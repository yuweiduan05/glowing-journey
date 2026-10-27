"""
回答边界（对应 2.6「回答边界」三态判定）

判定顺序很重要：
1. 先看是否属于明确超出业务范围的话题（crypto / 炒股 / 时政 / 招聘 / 竞品价）→ out_of_scope，
   **不做检索、不生成**，只拒答（对应 2.3 网关处置规则）；
2. 再看检索是否有达到阈值的证据 → 没有则 insufficient；
3. 有证据但生成后仍无有效引用（verify 未通过）→ insufficient。
"""
from __future__ import annotations

import re
from typing import Sequence

from .retrieval import Scored

OUT_OF_SCOPE_PATTERNS = [
    r"比特币|加密货币|虚拟币|区块链投资|USDT|BTC",
    r"股票|炒股|基金收益|证券开户|投资回报",
    r"政治|选举|总统|时政",
    r"招聘|简历|面试|薪资待遇|工资多少",
    r"竞争对手|友商.*报价|竞品.*价格",
    r"天气预报",
]


def is_out_of_scope(question: str) -> bool:
    return any(re.search(p, question, flags=re.IGNORECASE) for p in OUT_OF_SCOPE_PATTERNS)


def judge(
    candidates: Sequence[Scored],
    answer: str,
    threshold: float,
) -> tuple[str, float]:
    """返回 (boundary, confidence)"""
    if not candidates:
        return "insufficient", 0.12

    top = candidates[0].score
    has_citation = bool(re.search(r"\[\d+\]", answer))

    if top < threshold or not has_citation:
        return "insufficient", round(min(0.34, max(0.05, top)), 3)

    confidence = round(min(0.95, 0.45 + top * 0.5), 3)
    return "in_kb", confidence
