"""
检索层（对应 2.6 retrieve / filter 两个节点）

打分是「向量余弦 + 查询词覆盖」的混合分：
- 纯余弦在 800 字长块上会被长度稀释，短问题容易全体低于阈值；
- 词覆盖（字符 2-gram 命中率）对中文短问句更稳，两者加权后阈值 0.35 才有意义。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Sequence

from .chunking import Chunk
from .store import Hit, Store

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
_LATIN_RE = re.compile(r"[a-zA-Z0-9]{2,}")

# 疑问词/口语填充词整词剔除；功能字所在的双字窗口也剔除，
# 否则「的是」「是和」「多少」这类噪声会把真实关键词的覆盖率稀释掉。
STOP_TOKENS = [
    "什么", "多少", "怎么", "如何", "是否", "可以", "我们", "你们", "请问",
    "帮我", "一下", "这个", "那个", "这款", "那款", "多久", "怎样", "哪些",
]
FUNCTION_CHARS = set("的了是在有和与或及吗呢吧啊呀嘛哦")


def _clean(seg: str) -> str:
    for token in STOP_TOKENS:
        seg = seg.replace(token, " ")
    return seg


def grams(text: str) -> set[str]:
    lowered = _clean(text.lower())
    out: set[str] = {w for w in _LATIN_RE.findall(lowered)}
    for seg in _CJK_RE.findall(lowered):
        if len(seg) == 1:
            out.add(seg)
            continue
        for i in range(len(seg) - 1):
            bigram = seg[i : i + 2]
            if any(ch in FUNCTION_CHARS for ch in bigram):
                continue
            out.add(bigram)
    return out


def coverage(query_grams: set[str], text: str) -> float:
    if not query_grams:
        return 0.0
    text_grams = grams(text)
    return len(query_grams & text_grams) / len(query_grams)


@dataclass
class Scored:
    chunk: Chunk
    cosine: float
    score: float


def query_segments(question: str) -> List[str]:
    """多意图问题拆段：「保修期多久？换货什么条件？」按段各自算覆盖率，
    避免两个主题互相稀释导致整体低于阈值。"""
    parts = re.split(r"[？?。！!；;，,\n]+", question)
    segs = [p.strip() for p in parts if len(p.strip()) >= 3]
    return segs or [question]


def search(
    store: Store,
    embedder,
    question: str,
    top_k: int,
    filters: Dict[str, str] | None = None,
) -> List[Scored]:
    """多查询检索：整句 + 每个意图分段各检一次，按 chunk 取最高分。

    「保修期多久？换货什么条件？」这类双主题问题，如果只用整句向量，
    两个主题会互相稀释；分段检索后再合并，才能同时召回两份政策。
    """
    queries = list(dict.fromkeys([question, *query_segments(question)]))
    merged: Dict[str, Scored] = {}

    # ---- 1) 向量召回 ----
    for query in queries:
        vector = embedder.embed_query(query)
        q_grams = grams(query)
        pool = max(top_k * 4, 20)
        for hit in store.query(vector, pool, filters or {}):
            full_text = f"{hit.chunk.doc_title} {hit.chunk.section} {hit.chunk.text}"
            title_text = f"{hit.chunk.doc_title} {hit.chunk.section}"
            cov = coverage(q_grams, full_text)
            title_cov = coverage(q_grams, title_text)
            score = round(0.50 * cov + 0.35 * hit.cosine + 0.15 * title_cov, 4)
            prev = merged.get(hit.chunk.chunk_id)
            if prev is None or score > prev.score:
                merged[hit.chunk.chunk_id] = Scored(chunk=hit.chunk, cosine=hit.cosine, score=score)

    # ---- 2) 词面召回兜底 ----
    # 哈希 embedding 对短问句的召回不稳定，只靠向量会漏掉「运费/截单/SLA」这类关键词精确匹配。
    # 对全量 chunk 做一次词覆盖扫描（本工程规模 ≤ 数千块，成本可接受），
    # 命中但未被向量召回的块用「纯词面分」参与排序。
    seg_grams = [grams(q) for q in queries]
    for chunk in store.iter_all():
        if chunk.chunk_id in merged:
            continue
        if filters and any(getattr(chunk, k, None) != v for k, v in filters.items() if v):
            continue
        full_text = f"{chunk.doc_title} {chunk.section} {chunk.text}"
        title_text = f"{chunk.doc_title} {chunk.section}"
        cov = max((coverage(g, full_text) for g in seg_grams), default=0.0)
        if cov < 0.2:
            continue
        title_cov = max((coverage(g, title_text) for g in seg_grams), default=0.0)
        score = round(0.90 * cov + 0.10 * title_cov, 4)
        merged[chunk.chunk_id] = Scored(chunk=chunk, cosine=0.0, score=score)

    # 平局按 chunk_id 决胜：chroma 对等距结果的返回顺序不保证稳定，
    # 只按分数排序会让 margin 用例（如 q17 的第 4 个槽位）在多次评测间偶发漂移
    return sorted(merged.values(), key=lambda s: (-s.score, s.chunk.chunk_id))


def apply_filter(
    candidates: Sequence[Scored],
    threshold: float,
    final_top_k: int,
    rerank: bool = False,
    question: str | None = None,
) -> List[Scored]:
    kept = [c for c in candidates if c.score >= threshold]

    # 去重：同一文档同一章节只保留得分最高的一块，保证来源多样性。
    # 平局同样按 chunk_id 决胜（配合 search() 的确定性排序，全链路可复现）
    best: Dict[tuple[str, str], Scored] = {}
    for item in kept:
        key = (item.chunk.doc_id, item.chunk.section)
        if key not in best or item.score > best[key].score:
            best[key] = item
    deduped = sorted(best.values(), key=lambda s: (-s.score, s.chunk.chunk_id))

    # 多意图保底：为每个问句分段保留一条最相关片段。
    # 否则「保修期多久？换货什么条件？」会被保修类片段占满 top-k，
    # 第二问永远没有证据可用（前端表现就是「答了一半」）。
    if question:
        segs = query_segments(question)
        if len(segs) > 1:
            reserved: List[Scored] = []
            for seg in segs:
                sg = grams(seg)
                best_item = None
                best_overlap = 0
                for item in deduped:
                    overlap = len(sg & grams(item.chunk.text))
                    if overlap > best_overlap:
                        best_item, best_overlap = item, overlap
                if best_item is not None and best_item not in reserved:
                    reserved.append(best_item)
            if reserved:
                rest = [item for item in deduped if item not in reserved]
                deduped = reserved + rest

    if rerank:
        # 轻量 rerank：对表格块与含数字/型号的块给一点加成（可开关，不做模型调优）
        for item in deduped:
            bonus = 0.05 if item.chunk.is_table else 0.0
            if re.search(r"\d", item.chunk.text):
                bonus += 0.02
            item.score = round(min(1.0, item.score + bonus), 4)
        deduped.sort(key=lambda s: s.score, reverse=True)

    return deduped[:final_top_k]
