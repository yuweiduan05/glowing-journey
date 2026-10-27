"""
LangGraph 六节点状态图（对应 2.6 与 P2 任务 4）

    route ──(知识问题)──→ rewrite ─→ retrieve ─→ filter ─→ generate ─→ verify
      │                      ↑                                            │
      ├─(闲聊)──→ 直接回复    └──────(低置信/无引用，retry ≤ 2)─────────────┘
      └─(业务请求)──→ 交回网关                              └─(重试耗尽)→ boundary=insufficient

「自适应」的四件证据：条件边（成功 / 重试 / 放弃）+ 重试计数上限 + 回写路径
+ 分级改写（每次重试的 query 都不同——确定性重放在自适应里等于没重试）。
阈值保持 0.35 不放宽：实测放宽到 0.30 会把「股权结构」这类应拒答的问题误放行
（q32 重试 top1=0.32），而 q31 靠第 1 次重试的改写即可回到 0.39，无需动阈值。
retry 不是节点，而是 verify 之后的条件边 —— 这是 P0 冻结时确认的口径。

LangGraph 不可用时（缺依赖/版本不符），`_run_fallback` 用同一套节点函数按同一拓扑执行，
trace 输出完全一致，保证服务永远能起来；正式环境应使用 LangGraph（requirements 已锁定）。
"""
from __future__ import annotations

import re
import time
from typing import Dict, List, Optional, TypedDict

from .boundary import is_out_of_scope, judge
from .chunking import Chunk
from .config import Settings
from .embedding import get_embedder
from .llm import REFUSAL_INSUFFICIENT, REFUSAL_OUT_OF_SCOPE, Generator
from .models import Source
from .retrieval import Scored, apply_filter, search
from .store import Store

SMALLTALK_RE = re.compile(r"^(你好|您好|在吗|hi|hello|谢谢|辛苦|早上好|下午好)[!！。.~～\s]*$", re.I)
# 只有「明确的业务操作请求」才交回网关；含提问词的（多久/哪些/规定）仍按知识问题处理，
# 否则「截单时间是什么时候」「S2 工单多久响应」会被误判成业务查询。
BUSINESS_RE = re.compile(r"(查|看一下|查询).{0,4}(库存|订单)|(建|开|提).{0,3}工单|SO-\d{8}-\d{3}|SKU-[A-Z0-9]{6}")
KNOWLEDGE_HINT_RE = re.compile(r"多久|什么时候|几点|哪些|什么|怎么|如何|政策|规定|流程|标准|条件|是否|多少|吗")

SYNONYMS: Dict[str, List[str]] = {
    "保修": ["质保", "保修期", "售后", "免费维修"],
    "质保": ["保修", "保修期"],
    "换货": ["退换货", "退货", "7 天无理由", "换新"],
    "退货": ["退换货", "退款", "七天无理由"],
    "发票": ["开票", "增值税专用发票", "普票"],
    "物流": ["发货", "配送", "快递", "承运商", "截单"],
    "安装": ["调试", "上门安装", "部署"],
    "参数": ["规格", "技术参数", "量程", "精度"],
    "付款": ["支付", "账期", "结算"],
    "价格": ["报价", "折扣", "渠道价"],
    "摘要": ["必填项", "工单内容", "要素", "写清"],
    "工单": ["售后单", "工单号", "分级", "SLA"],
    "截单": ["发货时间", "当日发货", "出库"],
}


class RAGState(TypedDict, total=False):
    question: str
    rewritten: str
    route: str
    candidates: List[Scored]
    filtered: List[Scored]
    answer: str
    sources: List[dict]
    boundary: str
    confidence: float
    retries: int
    trace: List[str]
    top_k: int
    filters: Dict[str, str]


class RAGGraph:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store
        self.embedder = get_embedder(settings)
        self.generator = Generator(settings)
        self.engine = "fallback"
        self._graph = None
        self._build()

    # ---------------- 节点 ----------------
    def route(self, state: RAGState) -> RAGState:
        question = state["question"]
        trace = state.get("trace", []) + ["route"]
        route = "knowledge"

        if is_out_of_scope(question):
            route = "out_of_scope"
        elif SMALLTALK_RE.match(question.strip()):
            route = "smalltalk"
        elif BUSINESS_RE.search(question) and not KNOWLEDGE_HINT_RE.search(question):
            route = "business"

        if route == "out_of_scope":
            return {
                "route": route,
                "answer": REFUSAL_OUT_OF_SCOPE,
                "boundary": "out_of_scope",
                "confidence": 0.03,
                "sources": [],
                "trace": trace,
            }
        if route == "smalltalk":
            return {
                "route": route,
                "answer": "你好，我是企业知识库助手，可以回答产品手册、售后政策、发票物流等资料类问题。",
                "boundary": "in_kb",
                "confidence": 0.6,
                "sources": [],
                "trace": trace,
            }
        if route == "business":
            return {
                "route": route,
                "answer": "这属于业务查询（库存/订单/工单），请由业务助手在对话中处理，知识库只负责资料类问题。",
                "boundary": "insufficient",
                "confidence": 0.2,
                "sources": [],
                "trace": trace,
            }
        return {"route": route, "trace": trace}

    def rewrite(self, state: RAGState) -> RAGState:
        question = state["question"]
        retries = state.get("retries", 0)
        expansions: List[str] = []
        for key, syns in SYNONYMS.items():
            if key in question:
                expansions.extend(syns)
        syn_text = " ".join(dict.fromkeys(expansions))

        if retries <= 0:
            # 首轮：原问句 + 同义词扩展（不改变问句主干）
            rewritten = f"{question} {syn_text}".strip() if syn_text else question
        elif retries == 1:
            # 第一次重试：去疑问词与标点，叠加同义词 + 泛化词，扩大召回面
            core = re.sub(r"[？?。！!，,、]", " ", question)
            core = re.sub(r"(请问|帮我|一下|想知道|是什么|是多少|怎么|如何)", " ", core)
            rewritten = f"{core} {syn_text} 政策 说明 规范 手册".strip()
        else:
            # 第二次重试：只保留核心名词 + 上位词（按 section 反查的轻量替代），
            # 与第 1 次重试逐字节不同——否则重试只是确定性重复
            core = re.sub(r"[？?。！!，,、\s]", " ", question)
            core = re.sub(r"(请问|帮我|一下|想知道|是什么|是多少|怎么|如何|的|了|吗)", " ", core).strip()
            rewritten = f"{core} 产品 售后 服务 支持 说明".strip()
        return {"rewritten": rewritten.strip(), "trace": state.get("trace", []) + ["rewrite"]}

    def retrieve(self, state: RAGState) -> RAGState:
        started = time.perf_counter()
        # top_k 由调用方（契约 1..8）贯通到检索候选规模；缺省回落 settings.retrieve_top_k
        candidates = search(
            self.store,
            self.embedder,
            state.get("rewritten") or state["question"],
            top_k=state.get("top_k") or self.settings.retrieve_top_k,
            filters=state.get("filters") or {},
        )
        trace = state.get("trace", []) + ["retrieve"]
        print(
            f"[retrieve] q={state['question'][:40]!r} candidates={len(candidates)} "
            f"top={candidates[0].score if candidates else 0:.3f} cost={(time.perf_counter()-started)*1000:.0f}ms"
        )
        return {"candidates": candidates, "trace": trace}

    def filter(self, state: RAGState) -> RAGState:
        candidates = state.get("candidates", [])
        # 同一 top_k 同时决定最终返回条数（契约语义：top_k=8 时最多返回 8 条引用）
        filtered = apply_filter(
            candidates,
            threshold=self.settings.filter_threshold,
            final_top_k=state.get("top_k") or self.settings.final_top_k,
            rerank=self.settings.rerank_enabled,
            question=state.get("rewritten") or state["question"],
        )
        print(
            f"[filter] before={len(candidates)} after={len(filtered)} threshold={self.settings.filter_threshold}"
        )
        return {"filtered": filtered, "trace": state.get("trace", []) + ["filter"]}

    def generate(self, state: RAGState) -> RAGState:
        filtered = state.get("filtered", [])
        answer = self.generator.generate(state["question"], filtered)

        # 生成器会按正文引用顺序返回 chunk 下标；sources 必须同序，
        # 否则右侧「来源 1」和正文 [1] 指的不是同一篇。
        order = getattr(self.generator, "last_order", None)
        # 只保留正文真正引用到的片段：检索到 4 条但正文只引 1 条时，
        # 面板列出 4 条会让「引用」对不上号，读者点开 [2] 也找不到出处。
        if order:
            by_idx = {i: c for i, c in enumerate(filtered)}
            filtered = [by_idx[i] for i in order if i in by_idx]

        sources = [
            Source(
                doc_id=c.chunk.doc_id,
                doc_title=c.chunk.doc_title,
                section=c.chunk.section,
                chunk_id=c.chunk.chunk_id,
                page=c.chunk.page,
                score=round(c.score, 4),
                text=c.chunk.text[:400],
            ).model_dump()
            for c in filtered
        ]
        print(f"[generate] chunks={len(filtered)} answer_len={len(answer)}")
        return {"answer": answer, "sources": sources, "trace": state.get("trace", []) + ["generate"]}

    def verify(self, state: RAGState) -> RAGState:
        filtered = state.get("filtered", [])
        answer = state.get("answer", "")
        boundary, confidence = judge(filtered, answer, self.settings.filter_threshold)
        retries = state.get("retries", 0)

        if boundary != "in_kb":
            retries += 1
            answer = REFUSAL_INSUFFICIENT if retries > self.settings.max_retry else answer
            print(f"[verify] boundary={boundary} retries={retries}/{self.settings.max_retry} -> retry edge")
            return {
                "boundary": boundary,
                "confidence": confidence,
                "retries": retries,
                "answer": answer,
                "trace": state.get("trace", []) + ["verify"],
            }
        print(f"[verify] boundary=in_kb confidence={confidence}")
        return {
            "boundary": boundary,
            "confidence": confidence,
            "retries": retries,
            "answer": answer,
            "trace": state.get("trace", []) + ["verify"],
        }

    # ---------------- 图构建 ----------------
    def _build(self) -> None:
        try:
            from langgraph.graph import END, StateGraph

            graph = StateGraph(RAGState)
            graph.add_node("route", self.route)
            graph.add_node("rewrite", self.rewrite)
            graph.add_node("retrieve", self.retrieve)
            graph.add_node("filter", self.filter)
            graph.add_node("generate", self.generate)
            graph.add_node("verify", self.verify)

            graph.set_entry_point("route")
            graph.add_conditional_edges(
                "route",
                lambda s: "rewrite" if s.get("route") == "knowledge" else END,
                {"rewrite": "rewrite", END: END},
            )
            graph.add_edge("rewrite", "retrieve")
            graph.add_edge("retrieve", "filter")
            graph.add_edge("filter", "generate")
            graph.add_edge("generate", "verify")
            graph.add_conditional_edges(
                "verify",
                lambda s: "rewrite"
                if s.get("boundary") != "in_kb" and s.get("retries", 0) <= self.settings.max_retry
                else END,
                {"rewrite": "rewrite", END: END},
            )
            self._graph = graph.compile()
            self.engine = "langgraph"
        except Exception as exc:  # noqa: BLE001
            print(f"[graph] LangGraph 不可用（{exc}），使用等价内置执行器")
            self._graph = None
            self.engine = "fallback"

    def run(
        self,
        question: str,
        top_k: Optional[int] = None,
        filters: Optional[Dict[str, str]] = None,
    ) -> RAGState:
        init: RAGState = {
            "question": question,
            "rewritten": question,
            "route": "knowledge",
            "candidates": [],
            "filtered": [],
            "answer": "",
            "sources": [],
            "boundary": "insufficient",
            "confidence": 0.0,
            "retries": 0,
            "trace": [],
            # top_k 缺省 None：retrieve/filter 各自回落 settings（保持默认行为不变）；
            # 调用方显式传入时同时决定候选规模与最终返回条数（契约 1..8）
            "top_k": top_k,
            "filters": {k: v for k, v in (filters or {}).items() if v},
        }
        if self._graph is not None:
            return self._graph.invoke(init, config={"recursion_limit": 40})
        return self._run_fallback(init)

    def _run_fallback(self, state: RAGState) -> RAGState:
        """与上图完全一致的拓扑：route → [rewrite → retrieve → filter → generate → verify]*"""
        state.update(self.route(state))
        if state.get("route") != "knowledge":
            return state

        while True:
            state.update(self.rewrite(state))
            state.update(self.retrieve(state))
            state.update(self.filter(state))
            state.update(self.generate(state))
            state.update(self.verify(state))
            if state.get("boundary") == "in_kb":
                break
            if state.get("retries", 0) > self.settings.max_retry:
                break
        return state

    def mermaid(self) -> str:
        if self._graph is not None:
            try:
                return self._graph.get_graph().draw_mermaid()
            except Exception:  # noqa: BLE001
                pass
        return (
            "graph TD\n"
            "  route -->|knowledge| rewrite\n"
            "  route -->|smalltalk| END1[直接回复]\n"
            "  route -->|business| END2[交回网关]\n"
            "  rewrite --> retrieve --> filter --> generate --> verify\n"
            "  verify -->|低置信 且 retry<=2| rewrite\n"
            "  verify -->|成功/重试耗尽| END3[结束]"
        )


def sources_from_state(state: RAGState) -> List[Source]:
    return [Source(**s) for s in state.get("sources", [])]


def chunk_of(source: Source, chunks: List[Chunk]) -> Optional[Chunk]:
    return next((c for c in chunks if c.chunk_id == source.chunk_id), None)
