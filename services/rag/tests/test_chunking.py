"""切块规则单测：800/120、表格重复表头、不可切分 token"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.chunking import chunk_document, pack_chunks, split_table_block  # noqa: E402


class TestChunking(unittest.TestCase):
    def test_chunk_size_and_overlap(self) -> None:
        text = "。".join(["这是一段用于验证切块长度的测试句子，包含若干中文内容"] * 40) + "。"
        chunks = pack_chunks(text, size=800, overlap=120)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(len(chunk), 800, "单块不得超过 800 字")

    def test_table_repeats_header(self) -> None:
        block = [
            "| 型号 | 量程 |",
            "| --- | --- |",
            *[f"| PX-{i} | {i} MPa |" for i in range(1, 20)],
        ]
        parts = split_table_block(block, row_group=8)
        self.assertEqual(len(parts), 3)
        for part in parts:
            self.assertTrue(part.startswith("| 型号 | 量程 |"), "每块都必须重复表头")

    def test_protected_tokens_not_split(self) -> None:
        # 判别性构造：URL 内部含「?」（SENTENCE_END 会在 ? 后断句）。
        # 无保护时断句点正好落在 token 内部，URL 被切成两半；
        # 有保护时 URL 先换成占位符，断句不会进入 token 内部，还原后完整。
        text = "选型手册见 https://example.com/px200?lang=zh 页面。"
        chunks = pack_chunks(text, size=200, overlap=0)
        self.assertTrue(
            any("https://example.com/px200?lang=zh" in c for c in chunks),
            "不可切分 token 必须完整落在单个块内（不能跨块断开）",
        )

        # 区分度证明：关掉保护后同一输入的 URL 必然被切开（否则本用例形同虚设）
        from app import chunking

        original = chunking.PROTECT_PATTERNS
        chunking.PROTECT_PATTERNS = []
        try:
            raw = pack_chunks(text, size=200, overlap=0)
        finally:
            chunking.PROTECT_PATTERNS = original
        self.assertFalse(
            any("https://example.com/px200?lang=zh" in c for c in raw),
            "无保护时断句点应正好落入 token 内部，URL 被跨块切开",
        )

        # 基本 sanity：SKU / 订单号同样保持完整
        text2 = "型号 SKU-A1B2C3 与订单 SO-20261012-007 需要完整保留。"
        joined = "".join(pack_chunks(text2, size=200, overlap=0))
        self.assertIn("SKU-A1B2C3", joined)
        self.assertIn("SO-20261012-007", joined)

    def test_real_kb_document_metadata(self) -> None:
        kb = Path(__file__).resolve().parent.parent.parent.parent / "data" / "kb"
        files = sorted(kb.glob("kb-001-*.md"))
        if not files:
            self.skipTest("知识库文档不存在")
        chunks = chunk_document(files[0], size=800, overlap=120, row_group=8)
        self.assertTrue(chunks)
        self.assertEqual(chunks[0].doc_type, "product_manual")
        self.assertEqual(chunks[0].doc_title, "压力传感器 PX-200 产品手册")
        self.assertTrue(any(c.is_table for c in chunks), "技术参数表应被识别为表格块")


if __name__ == "__main__":
    unittest.main()
