"""
多意图覆盖回归测试。

背景：D5「保修期多久？换货什么条件？」曾出现「引用 4 条、正文只答保修」的可见缺陷：
- filter 按总分截断 top-k，换货片段被挤出；
- generate 只取前 3 块，第二问没有机会进入答案。

这两个测试分别锁住两处修复，避免以后调参时退回旧行为。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.chunking import Chunk  # noqa: E402
from app.config import settings  # noqa: E402
from app.llm import Generator  # noqa: E402
from app.retrieval import Scored, apply_filter  # noqa: E402


def make_chunk(
    cid: str,
    text: str,
    *,
    doc_id: str | None = None,
    section: str = "章节",
    title: str = "文档",
) -> Scored:
    return Scored(
        chunk=Chunk(
            chunk_id=cid,
            doc_id=doc_id or f"d-{cid}",
            doc_title=title,
            doc_type="policy",
            product_line="general",
            section=section,
            section_path=section,
            page=None,
            text=text,
            is_table=False,
        ),
        cosine=0.5,
        score=0.6,
    )


class TestMultiIntentFilter(unittest.TestCase):
    def test_second_intent_is_reserved_even_if_ranked_out(self) -> None:
        """换货片段的分数排在第 4 位，final_top_k=3 时也必须被保底选中。"""
        candidates = [
            make_chunk("c1", "工业传感器整机保修 24 个月，办公设备保修 12 个月。"),
            make_chunk("c2", "保修期内非人为损坏免费维修，包含工时费与配件费。"),
            make_chunk("c3", "保修期自签收之日起计算，以订单签收日期为准。"),
            make_chunk("c4", "自签收之日起 7 日内，未使用且包装完好可申请换货。"),
        ]
        for i, item in enumerate(candidates):
            item.score = [0.9, 0.8, 0.7, 0.5][i]

        picked = apply_filter(
            candidates,
            threshold=0.35,
            final_top_k=3,
            question="保修期是多久？换货要什么条件？",
        )
        ids = [p.chunk.chunk_id for p in picked]
        self.assertIn("c4", ids, f"换货片段被截断：{ids}")

    def test_single_intent_keeps_score_order(self) -> None:
        candidates = [
            make_chunk("c1", "工业传感器整机保修 24 个月。"),
            make_chunk("c2", "保修期自签收之日起计算。"),
        ]
        candidates[0].score = 0.9
        candidates[1].score = 0.6
        picked = apply_filter(candidates, threshold=0.35, final_top_k=4, question="保修期多久？")
        self.assertEqual([p.chunk.chunk_id for p in picked], ["c1", "c2"])


class TestMultiIntentGeneration(unittest.TestCase):
    def test_answer_covers_both_intents_and_cites_them(self) -> None:
        chunks = [
            make_chunk("c1", "工业传感器整机保修 24 个月，办公打印设备整机保修 12 个月。"),
            make_chunk("c2", "自签收之日起 7 个自然日内，未使用且包装完好可申请无理由换货。"),
        ]
        chunks[0].score = 0.8
        chunks[1].score = 0.55

        generator = Generator(settings)
        answer = generator._generate_mock("保修期是多久？换货要什么条件？", chunks)

        self.assertIn("保修", answer)
        self.assertIn("换货", answer, "第二个意图没有被回答")
        self.assertIn("[1]", answer)
        self.assertIn("[2]", answer, "第二个来源没有被引用")

    def test_table_chunk_is_rendered_as_readable_pairs(self) -> None:
        table = Chunk(
            chunk_id="t1",
            doc_id="d-t",
            doc_title="保修政策",
            doc_type="policy",
            product_line="general",
            section="二、保修期限",
            section_path="二、保修期限",
            page=None,
            text="【表格】二、保修期限\n| 产品类别 | 整机保修 |\n| --- | --- |\n| 工业传感器 | 24 个月 |\n| 办公打印设备 | 12 个月 |",
            is_table=True,
        )
        answer = Generator(settings)._generate_mock(
            "工业传感器的保修期是多久？",
            [Scored(chunk=table, cosine=0.6, score=0.7)],
        )
        self.assertIn("产品类别：", answer)
        self.assertNotIn("| --- |", answer, "不应把原始表格分隔行直接展示给用户")


if __name__ == "__main__":
    unittest.main()
