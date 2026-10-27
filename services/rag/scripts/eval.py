"""
离线评测脚本（对应 P2 任务 8：30+ 条 QA，报告 hit@4 / 边界准确率 / 引用覆盖率 / 平均耗时）

口径（2026-10-22 整改，R2 审查意见）：
- hit_at_4：**只统计可答用例**（expected_docs 非空）的文档级命中。
  旧口径把「不可答用例双方 docs 都空」也算命中——不可答用例只要闭嘴就白送，
  指标会被"沉默的大多数"灌水，hit@4=1.000 也经不起复算；
- refusal_accuracy：不可答用例中「边界态判对且没有引用」的比例（正确拒答）；
- boundary_accuracy：全体用例的三态判别准确率；
- citation_coverage：可答用例有引用 / 不可答用例未误报引用。

用法（需先建好索引）：
    cd services/rag
    PYTHONPATH=.pylibs python scripts/eval.py

不依赖 HTTP 服务，直接复用 graph，便于在 CI 里跑。
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.config import settings  # noqa: E402
from app.embedding import get_embedder  # noqa: E402
from app.graph import RAGGraph  # noqa: E402
from app.ingest import Ingestor  # noqa: E402
from app.store import build_store  # noqa: E402

REPO_DIR = SERVICE_DIR.parent.parent
QA_PATH = REPO_DIR / "data" / "eval" / "qa.jsonl"


def main() -> int:
    cases = [json.loads(line) for line in QA_PATH.read_text(encoding="utf-8").splitlines() if line.strip()]

    store, kind = build_store(
        settings.chroma_dir,
        f"{settings.embedding_signature}|{settings.chunk_signature}",
        settings.vector_store,
    )
    Ingestor(settings, store).ensure_ready()
    graph = RAGGraph(settings, store)

    hit4 = 0
    answerable = 0
    refusal_ok = 0
    unanswerable = 0
    boundary_ok = 0
    citation_ok = 0
    total_ms = 0.0
    rows = []

    for case in cases:
        started = time.perf_counter()
        state = graph.run(case["question"])
        elapsed = (time.perf_counter() - started) * 1000
        total_ms += elapsed

        # hit@k 是检索指标，按「检索到的片段」算；
        # sources 只包含正文实际引用的片段（生成端会裁剪），不能拿它当召回率。
        retrieved_docs = [c.chunk.doc_id for c in state.get("filtered", [])]
        got_docs = [s["doc_id"] for s in state.get("sources", [])]
        expected_docs = case["expected_docs"]
        got_boundary = state.get("boundary", "")
        expected_boundary = case["expected_boundary"]

        if expected_docs:
            # 可答用例：文档级命中才算成功（不白送）
            answerable += 1
            hit = bool(set(expected_docs) & set(retrieved_docs))
            hit4 += int(hit)
        else:
            # 不可答用例：边界态判对且没有引用，才算正确拒答
            unanswerable += 1
            hit = got_boundary == expected_boundary and not got_docs
            refusal_ok += int(hit)

        boundary_hit = got_boundary == expected_boundary
        boundary_ok += int(boundary_hit)
        # 可答：有引用；不可答：没有误报引用（与指标名直译一致，不再借边界态间接判断）
        citation = bool(got_docs) if expected_docs else not got_docs
        citation_ok += int(citation)
        rows.append(
            {
                "id": case["id"],
                "hit": hit,
                "boundary": f"{got_boundary}({'ok' if boundary_hit else 'x'})",
                # 不截断、带上期望值：第三方可拿 qa.jsonl + report.json 独立复算每个数字
                "expected_docs": expected_docs,
                "expected_boundary": expected_boundary,
                "docs": got_docs,
                "retrieved": retrieved_docs,
                "ms": round(elapsed, 1),
            }
        )

    total = len(cases)
    report = {
        "cases": total,
        "answerable_cases": answerable,
        "hit_at_4": round(hit4 / answerable, 3) if answerable else 0.0,
        "unanswerable_cases": unanswerable,
        "refusal_accuracy": round(refusal_ok / unanswerable, 3) if unanswerable else 0.0,
        "boundary_accuracy": round(boundary_ok / total, 3),
        "citation_coverage": round(citation_ok / total, 3),
        "avg_latency_ms": round(total_ms / total, 1),
        "vector_store": kind,
        "embedding": get_embedder(settings).signature,
        "graph_engine": graph.engine,
    }

    print("\n=== RAG 评测 ===")
    for key, value in report.items():
        print(f"{key:20s} {value}")
    print("口径：hit_at_4 仅统计可答用例的文档级命中；refusal_accuracy 为不可答用例的正确拒答率")
    print("     （边界态判对且无引用）；boundary_accuracy 为全体三态判别。")

    misses = [r for r in rows if not r["hit"]]
    if misses:
        print(f"\n未通过 {len(misses)} 条：")
        for row in misses:
            print(f"  {row['id']} docs={row['docs']} boundary={row['boundary']}")

    out = REPO_DIR / "data" / "eval" / "report.json"
    out.write_text(json.dumps({"summary": report, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已写入 {out}")
    return 0 if report["hit_at_4"] >= 0.85 and report["boundary_accuracy"] >= 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
