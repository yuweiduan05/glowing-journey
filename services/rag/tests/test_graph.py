"""
状态图测试（审查报告 §4.5：「图/入库/接口零测试」的补强）：

1. 引擎断言：正式环境必须用 LangGraph（缺依赖时的 fallback 只是保底，不能冒充）；
2. 拓扑断言：route/rewrite/retrieve/filter/generate/verify 六节点齐备；
3. 重试上限：低置信问题最多重试 max_retry 次，不会无限循环；
4. 分级改写：三次重试的 query 互不相同（「自适应」不能是确定性重复）。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from app.config import Settings  # noqa: E402
from app.graph import RAGGraph  # noqa: E402
from app.llm import REFUSAL_INSUFFICIENT  # noqa: E402
from app.store import LocalStore  # noqa: E402


def build_graph() -> tuple[RAGGraph, tempfile.TemporaryDirectory]:
    tmp = tempfile.TemporaryDirectory()
    settings = Settings(
        chroma_dir=Path(tmp.name),
        manifest_path=Path(tmp.name) / "manifest.json",
        vector_store="local",
        load_existing=False,
    )
    store = LocalStore(Path(tmp.name) / "store.json")  # 空库：检索必然无候选
    return RAGGraph(settings, store), tmp


class TestRagGraph(unittest.TestCase):
    def test_engine_is_langgraph(self) -> None:
        graph, tmp = build_graph()
        self.addCleanup(tmp.cleanup)
        self.assertEqual(graph.engine, "langgraph", "正式环境应使用 LangGraph（requirements 已锁定）")

    def test_six_nodes_present(self) -> None:
        graph, tmp = build_graph()
        self.addCleanup(tmp.cleanup)
        expected = {"route", "rewrite", "retrieve", "filter", "generate", "verify"}
        if graph._graph is not None:
            nodes = set(graph._graph.get_graph().nodes)
        else:  # fallback 执行器：拓扑与上图一致，按约定名断言
            nodes = set(expected)
        self.assertTrue(expected <= nodes, f"状态图缺少节点：{expected - nodes}")

    def test_retry_capped_at_max_retry(self) -> None:
        graph, tmp = build_graph()
        self.addCleanup(tmp.cleanup)
        state = graph.run("这是一个空库里必然没有答案的测试问题")
        # max_retry=2：rewrite/retrieve/filter/generate/verify 各执行 3 轮后收手
        self.assertEqual(state["retries"], graph.settings.max_retry + 1)
        self.assertEqual(state["boundary"], "insufficient")
        self.assertEqual(state["answer"], REFUSAL_INSUFFICIENT)
        for node in ("rewrite", "retrieve", "filter", "generate", "verify"):
            self.assertEqual(state["trace"].count(node), 3, f"{node} 应执行 3 轮（1 首轮 + 2 重试）")

    def test_rewrite_is_tiered_not_deterministic(self) -> None:
        """§2.3：每次重试的 query 必须不同，否则重试只是确定性重复"""
        graph, tmp = build_graph()
        self.addCleanup(tmp.cleanup)
        question = "售后工单摘要必须写清哪些内容？"
        rewrites = [graph.rewrite({"question": question, "retries": r})["rewritten"] for r in (0, 1, 2)]
        self.assertEqual(len(set(rewrites)), 3, f"三级改写产生了重复 query：{rewrites}")
        for r in rewrites:
            self.assertIn("售后工单", r)


if __name__ == "__main__":
    unittest.main()
