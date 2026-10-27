"""
生成节点（对应 2.6 generate：带编号引用约束生成，只允许用给定片段）

- mock（默认）：抽取式生成。每个意图抽一句结论（加粗）并带 [n] 编号，其余片段作补充，
  不产生任何片段外的事实 —— 离线演示与评测时不会「编造」，指标可复现；
- openai：把编号片段放进 prompt，强约束只能引用给定材料。
"""
from __future__ import annotations

import json
import re
import urllib.request
from typing import List, Sequence

from .config import Settings
from .retrieval import Scored, grams, query_segments


class Generator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider = settings.llm_provider
        # 最近一次生成里，片段在正文中首次出现的顺序（供 graph 重排 sources）
        self.last_order: list[int] = []

    def generate(self, question: str, chunks: Sequence[Scored]) -> str:
        if not chunks:
            return ""
        self.last_order = []
        if self.provider == "openai" and self.settings.llm_api_key:
            try:
                return self._generate_openai(question, chunks)
            except Exception:  # noqa: BLE001 - 上游异常时退回抽取式，保证可用性
                return self._generate_mock(question, chunks)
        return self._generate_mock(question, chunks)

    # ---------- 抽取式 ----------
    @staticmethod
    def _table_rows(text: str) -> tuple[list[str], list[list[str]]]:
        """把 Markdown 表格解析成 (表头, 数据行)；解析失败返回空"""
        lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("|")]
        if len(lines) < 2:
            return [], []
        header = [c.strip() for c in lines[0].strip("|").split("|")]
        rows: list[list[str]] = []
        for ln in lines[1:]:
            if set(ln) <= set("|-: "):
                continue
            cells = [c.strip() for c in ln.strip("|").split("|")]
            if any(cells):
                rows.append(cells)
        return header, rows

    @staticmethod
    def _tidy(sentence: str) -> str:
        """去掉列表序号与句尾冒号，避免展示成半截列表"""
        s = re.sub(r"^\d+\s*[.、)）]\s*", "", sentence.strip())
        s = re.sub(r"[：:]\s*1\s*[.、)）]\s*", "：", s)
        s = re.sub(r"\s+\d+\s*[.、)）]\s*", "；", s)
        return s.rstrip("：:；; ").strip()

    @staticmethod
    def _sentences(text: str) -> list[str]:
        return [x.strip() for x in re.split(r"(?<=[。！？；\n])", text) if len(x.strip()) > 8]

    @staticmethod
    def _answer_bonus(question: str, sentence: str) -> int:
        """
        判断「这句话像不像答案」，而不只是「像不像问题」。

        只按词面重合选句会挑中兜底条款：「进口部件按其原厂保修条款执行，
        但整体保修期不低于本政策标准」和「保修期」重合度很高，却没有回答
        「多久」。问时效时要奖励带时间量的句子，问条件时要奖励条件句，
        同时把「按原厂/本政策/不低于」这类范围说明降权。
        """
        bonus = 0
        if re.search(r"多久|多长时间|期限|时效|保修期|有效期|几天", question):
            if re.search(r"\d+\s*(个月|个自然日|天|日|小时|分钟|年|个工作日)", sentence):
                bonus += 4
        if re.search(r"多少|几", question):
            if re.search(r"\d+(\.\d+)?\s*(件|元|%|MPa|V|mA|mm|℃)", sentence):
                bonus += 2
        if re.search(r"条件|要求|材料|需要|怎么办", question):
            if re.search(r"条件|需|满足|提供|提交", sentence):
                bonus += 2
        if re.search(r"本政策|按原厂|按其原厂|不低于|另行|视情况|如有变化", sentence):
            bonus -= 4
        return bonus

    @staticmethod
    def _similar(a: str, b: str) -> float:
        """字符 2-gram Jaccard，用于识别「结论和补充说的是同一件事」"""
        ga, gb = grams(a), grams(b)
        if not ga or not gb:
            return 0.0
        inter = len(ga & gb)
        return inter / (len(ga) + len(gb) - inter)

    @staticmethod
    def _shorten(text: str, limit: int) -> str:
        """按标点截断，避免把一句话砍在半截词上"""
        if len(text) <= limit:
            return text
        window = text[:limit]
        cut = max(window.rfind("，"), window.rfind("；"), window.rfind("。"))
        return (window[:cut] if cut > 30 else window).rstrip("，；。") + "…"

    def _snippet(self, item: Scored, seg_grams: Sequence[set[str]]) -> str:
        """从单个片段里挑出与「某个意图分段」最相关的一句（表格则转成「列：值」）"""
        text = item.chunk.text

        def overlap(piece: str) -> int:
            pg = grams(piece)
            return max((len(g & pg) for g in seg_grams), default=0)

        if item.chunk.is_table:
            lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("|")]
            cols = [c.strip() for c in (lines[0].strip("|").split("|") if lines else [])]
            rows = [ln for ln in lines[1:] if not set(ln) <= set("|-: ")]
            best_row = max(rows, key=overlap, default="")
            cells = [c.strip() for c in best_row.strip("|").split("|")]
            pairs = [
                f"{cols[i]}：{cells[i]}"
                for i in range(min(len(cols), len(cells)))
                if cols[i] and cells[i] and cells[i] != "---"
            ]
            return ("；".join(pairs) if pairs else " ".join(rows[:3]))[:180]

        sentences = [s.strip() for s in re.split(r"(?<=[。！？；\n])", text) if len(s.strip()) > 8]
        if not sentences:
            return text[:160]
        best = max(sentences, key=overlap)
        chosen = best if overlap(best) > 0 else sentences[0]
        return self._tidy(chosen)[:160]

    def _conclusion(self, item: Scored, seg: set[str]) -> str:
        """
        为一个意图抽一句「结论句」：与问题重合度最高、且本身是完整陈述的那一句。

        只挑一句而不是整段，是因为片段开头常是适用范围/兜底条款
        （「进口部件按其原厂条款执行…」），直接罗列会让用户读到最后才看到答案。
        """
        if item.chunk.is_table:
            header, rows = self._table_rows(item.chunk.text)
            if not rows:
                return self._snippet(item, [seg])

            scored = sorted(
                ((len(seg & grams(" ".join(r))), r) for r in rows),
                key=lambda x: x[0],
                reverse=True,
            )
            matched = [r for sc, r in scored if sc > 0][:3]
            if not matched:
                return self._snippet(item, [seg])

            # 「项目」型参数表：问多个参数时逐行给「名称：值」，别只回一行
            if header and header[0] in {"项目", "参数", "指标", "名称", "字段"} and len(matched) >= 2:
                pairs = [f"{r[0]}：{r[1]}" for r in matched if len(r) > 1 and r[0] and r[1]]
                if pairs:
                    return "；".join(pairs)

            best = matched[0]
            return "；".join(
                f"{header[i]}：{best[i]}"
                for i in range(min(len(header), len(best)))
                if header[i] and best[i] and best[i] != "---"
            )

        sentences = [
            s.strip() for s in re.split(r"(?<=[。！？；\n])", item.chunk.text) if len(s.strip()) > 8
        ]
        if not sentences:
            return ""

        def score(sentence: str) -> int:
            return len(seg & grams(sentence))

        best = max(sentences, key=score)
        if score(best) == 0:
            best = sentences[0]
        return self._shorten(self._tidy(best), 96)

    def _generate_mock(self, question: str, chunks: Sequence[Scored]) -> str:
        """
        结论先行：每个意图先给一句加粗结论，再补依据与例外。

        旧实现是「- 片段1 [1] / - 片段2 [2]」平铺，用户读到的是检索结果而不是答案：
        问「保修期多久」，第一条却是「进口部件按原厂条款执行」这种兜底条款。
        现在的顺序是：按意图逐条给结论（带引用编号），剩余片段降级为补充说明。
        """
        segs = query_segments(question) or [question]
        seg_grams = [grams(s) for s in segs]

        # 每个意图在「句级」全局挑最优：先按块挑会把整块里最像问题的那句
        # 当成答案，但真正回答问题的句子可能在另一块里。
        picks: List[tuple[int, int, str, bool]] = []  # (seg_idx, chunk_idx, sentence, is_table)
        used_idx: set[int] = set()
        used_sent: set[str] = set()
        for gi, g in enumerate(seg_grams):
            best_score = 0
            best: tuple[int, str, bool] | None = None
            for i, item in enumerate(chunks):
                if item.chunk.is_table:
                    cand = self._conclusion(item, g)
                    candidates = [(cand, True)] if cand else []
                else:
                    candidates = [(x, False) for x in self._sentences(item.chunk.text)]
                for raw, is_table in candidates:
                    if not raw:
                        continue
                    text = self._tidy(raw)
                    if text in used_sent:
                        continue
                    sc = len(g & grams(text)) + self._answer_bonus(question, text)
                    if sc > best_score:
                        best_score, best = sc, (i, text, is_table)
            if best is not None and best_score > 0:
                i, text, is_table = best
                picks.append((gi, i, text, is_table))
                used_idx.add(i)
                used_sent.add(text)

        # 编号按「正文出现顺序」重排，而不是按检索排名：
        # 否则多意图问题会出现 [2] 在 [1] 前面，读者会以为引用错乱。
        order: List[int] = []

        def cite(i: int) -> int:
            if i not in order:
                order.append(i)
            return order.index(i) + 1

        conclusions: List[str] = []
        seen: set[str] = set()
        for _gi, i, raw_text, is_table in picks:
            text = re.sub(r"\s+", " ", raw_text).strip()
            if not text or text in seen:
                continue
            seen.add(text)
            n = cite(i)
            if is_table:
                # 表格型答案本身是「列：值」，加粗反而更难读
                conclusions.append(f"{text} [{n}]")
            else:
                # 长句只加粗第一个分句：整段加粗会变成一块黑体，
                # 反而看不出「哪一句是结论」
                head, rest = text, ""
                if len(text) > 48:
                    cut = text.find("，")
                    if cut > 6:
                        head, rest = text[:cut], text[cut:]
                conclusions.append(f"**{head}**{rest} [{n}]")

        # 单意图问题只留 1 条高相关补充：结论句已经回答完了，
        # 再堆 3 条「相关但不回答」的句子，读起来又变回检索结果列表。
        support_limit = 3 if len(conclusions) >= 2 else 1
        min_overlap = 2 if len(conclusions) >= 2 else 3
        supports: List[str] = []
        for i, item in enumerate(chunks):
            if len(supports) >= support_limit:
                break
            if i in used_idx:
                continue
            snippet = re.sub(r"\s+", " ", self._snippet(item, seg_grams)).strip()
            if not snippet or snippet in seen:
                continue
            # 相关性门槛：和问题几乎没有词面交集就不要凑数（旧实现会把校准方法、
            # 产品简介一起塞进「补充」，读起来像检索结果而不是回答）
            if max((len(g & grams(snippet)) for g in seg_grams), default=0) < min_overlap:
                continue
            # 与结论说的是同一件事就不重复（例如 S2 那条既在表里又出现在正文）
            if any(self._similar(snippet, c) > 0.5 for c in conclusions):
                continue
            seen.add(snippet)
            supports.append(f"- {snippet} [{cite(i)}]")

        self.last_order = order
        if not conclusions and not supports:
            return ""

        blocks: List[str] = []
        if conclusions:
            blocks.append("\n\n".join(conclusions))
        if supports:
            blocks.append("\n".join(supports))
        return "\n\n".join(blocks)

    # ---------- OpenAI 兼容 ----------
    def _generate_openai(self, question: str, chunks: Sequence[Scored]) -> str:
        context = "\n\n".join(
            f"[{i}] 文档：{c.chunk.doc_title}｜章节：{c.chunk.section}\n{c.chunk.text}"
            for i, c in enumerate(chunks, start=1)
        )
        system = (
            "你是企业知识库问答助手。只能使用给定的编号片段回答，每条结论后必须标注 [n]。"
            "片段不足以回答时，直接说“知识库未覆盖该问题”，禁止补充片段外的事实。"
            "回答控制在 200 字以内，先给结论再给依据。"
        )
        body = {
            "model": self.settings.llm_model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": f"问题：{question}\n\n片段：\n{context}"},
            ],
        }
        req = urllib.request.Request(
            f"{self.settings.llm_base_url.rstrip('/')}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.settings.llm_api_key}",
            },
        )
        with urllib.request.urlopen(req, timeout=self.settings.llm_timeout_s) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
        return str(payload["choices"][0]["message"]["content"]).strip()


REFUSAL_OUT_OF_SCOPE = (
    "这个问题超出了我的服务范围。我只负责产品资料、库存、订单与售后政策相关的问题，"
    "涉及投资、法务、人事等信息建议转人工客服处理。"
)

REFUSAL_INSUFFICIENT = (
    "知识库暂未覆盖该问题。为避免给错信息，我不会凭空作答；"
    "可以点击「转人工」由客服跟进，或补充更具体的产品型号/订单号后再问一次。"
)
