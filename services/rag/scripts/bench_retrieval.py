"""
检索层规模基准（只测「全量词覆盖扫描」这一段，因为它是当前架构的 O(N) 瓶颈）。

说明：
- 向量部分在 Chroma 里是 Rust HNSW，复杂度与 N 基本无关，不能用本脚本衡量；
- 这里刻意用合成文本测纯 Python 的词覆盖扫描，给出「每千块」的成本，
  用于判断现有实现能撑到多大规模、何时必须换倒排索引。
"""
from __future__ import annotations

import random
import statistics
import sys
import time
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.chunking import Chunk  # noqa: E402
from app.retrieval import coverage, grams, query_segments  # noqa: E402

random.seed(20261022)

CHARS = "工业传感器打印机仓储耗材保修换货发票物流截单库存订单工单政策流程规格量程精度安装校准替代型号仓库发货验收退款税率"


def make_chunk(i: int) -> Chunk:
    text = "".join(random.choice(CHARS) for _ in range(300))
    return Chunk(
        chunk_id=f"c-{i}",
        doc_id=f"d-{i % 50}",
        doc_title=f"文档{i % 50}",
        doc_type="wiki",
        product_line="general",
        section=f"章节{i % 7}",
        section_path=f"章节{i % 7}",
        page=None,
        text=text,
        is_table=False,
    )


QUERIES = [
    "这款设备的保修期是多久？换货要什么条件？",
    "S2 级工单多久要首次响应？",
    "广州仓的截单时间是几点？",
]

print(f"{'chunks':>8} {'per-query ms':>14} {'extrapolated 10k':>18}")
for n in (100, 1_000, 5_000, 20_000):
    chunks = [make_chunk(i) for i in range(n)]
    samples = []
    for q in QUERIES:
        segs = [grams(s) for s in query_segments(q)]
        t0 = time.perf_counter()
        for chunk in chunks:
            full = f"{chunk.doc_title} {chunk.section} {chunk.text}"
            max((coverage(g, full) for g in segs), default=0.0)
        samples.append((time.perf_counter() - t0) * 1000)
    median = statistics.median(samples)
    print(f"{n:>8} {median:>14.1f} {median / n * 10_000:>18.0f}")
