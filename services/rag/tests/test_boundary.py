"""回答边界单测：out_of_scope 先于检索判定，insufficient 不编造"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.boundary import is_out_of_scope, judge  # noqa: E402
from app.chunking import Chunk  # noqa: E402
from app.retrieval import Scored  # noqa: E402


def make_scored(score: float) -> Scored:
    chunk = Chunk(
        chunk_id="c1",
        doc_id="d1",
        doc_title="保修政策",
        doc_type="policy",
        product_line="general",
        section="二、保修期限",
        section_path="二、保修期限",
        page=None,
        text="工业传感器整机保修 24 个月。",
        is_table=False,
    )
    return Scored(chunk=chunk, cosine=0.6, score=score)


class TestBoundary(unittest.TestCase):
    def test_crypto_is_out_of_scope(self) -> None:
        self.assertTrue(is_out_of_scope("你们支持比特币付款吗？"))

    def test_equity_is_not_out_of_scope(self) -> None:
        """股权属于业务范围内但知识库未覆盖 → 应走 insufficient，而不是拒答越界"""
        self.assertFalse(is_out_of_scope("我们公司的股权结构是怎样的？"))

    def test_product_question_in_scope(self) -> None:
        self.assertFalse(is_out_of_scope("PX-200 的量程是多少？"))

    def test_judge_in_kb_requires_citation(self) -> None:
        boundary, confidence = judge([make_scored(0.62)], "整机保修 24 个月 [1]", 0.35)
        self.assertEqual(boundary, "in_kb")
        self.assertGreater(confidence, 0.5)

    def test_judge_without_citation_is_insufficient(self) -> None:
        boundary, confidence = judge([make_scored(0.62)], "整机保修 24 个月。", 0.35)
        self.assertEqual(boundary, "insufficient")
        self.assertLessEqual(confidence, 0.34)

    def test_judge_empty_candidates_is_insufficient(self) -> None:
        boundary, confidence = judge([], "", 0.35)
        self.assertEqual(boundary, "insufficient")
        self.assertLess(confidence, 0.2)

    def test_low_score_below_threshold(self) -> None:
        boundary, _ = judge([make_scored(0.2)], "内容 [1]", 0.35)
        self.assertEqual(boundary, "insufficient")


if __name__ == "__main__":
    unittest.main()
