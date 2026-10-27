"""
契约测试：用 Node 侧导出的 JSON Schema 校验 Python 侧模型，
避免「TS 改了字段、Python 没跟上」这种只在联调时才暴露的问题。

两类断言：
1. 结构级：契约 required ⊆ model_fields（防漂移）；
2. 实例级：用 jsonschema 校验 model_dump() 产出的真实实例
   （防「字段名对得上但类型/取值对不上」）。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = SERVICE_DIR.parent.parent
sys.path.insert(0, str(SERVICE_DIR))

import jsonschema  # noqa: E402

from app.models import ChatResponse, Source  # noqa: E402


def load(name: str) -> dict:
    path = REPO_DIR / "contracts" / f"{name}.schema.json"
    if not path.exists():
        raise unittest.SkipTest(f"缺少契约文件 {path}，请先运行 pnpm contracts")
    return json.loads(path.read_text(encoding="utf-8"))


class TestToolContract(unittest.TestCase):
    def test_search_knowledge_output_required_fields_present(self) -> None:
        schema = load("search_knowledge.output")
        required = set(schema.get("required", []))
        model_fields = set(ChatResponse.model_fields.keys())
        self.assertTrue(
            required.issubset(model_fields),
            f"RAG 响应缺少契约字段：{required - model_fields}",
        )

    def test_source_fields_match(self) -> None:
        schema = load("search_knowledge.output")
        source_schema = schema["properties"]["sources"]["items"]
        required = set(source_schema.get("required", []))
        model_fields = set(Source.model_fields.keys())
        self.assertTrue(
            required.issubset(model_fields),
            f"Source 缺少契约字段：{required - model_fields}",
        )

    def test_boundary_enum_matches(self) -> None:
        schema = load("search_knowledge.output")
        enum = set(schema["properties"]["boundary"]["enum"])
        self.assertEqual(enum, {"in_kb", "insufficient", "out_of_scope"})

    def test_tool_input_does_not_accept_customer_id(self) -> None:
        """数据边界：query_order 的入参不应包含 customer_id"""
        schema = load("query_order.input")
        self.assertNotIn("customer_id", schema.get("properties", {}))

    def test_create_ticket_requires_idempotency_key(self) -> None:
        schema = load("create_ticket.input")
        self.assertIn("idempotency_key", schema.get("required", []))

    # ---------- 实例级校验（审查报告 §4.5：契约测试不能只做子集断言） ----------

    def test_chat_response_instance_validates_against_schema(self) -> None:
        schema = load("search_knowledge.output")
        instance = ChatResponse(
            answer="保修期为 12 个月[1]。",
            sources=[
                Source(
                    doc_id="kb-007",
                    doc_title="产品保修政策（2026 版）",
                    section="二、保修期限",
                    chunk_id="kb-007-0001",
                    page=None,
                    score=0.6309,
                    text="整机保修 12 个月。",
                )
            ],
            boundary="in_kb",
            confidence=0.77,
        )
        jsonschema.validate(instance.model_dump(mode="json", exclude_none=True), schema)

    def test_source_instance_rejects_wrong_types(self) -> None:
        """反证：类型不符的实例必须被 schema 拒绝（否则上面的通过毫无意义）"""
        schema = load("search_knowledge.output")
        bad = {
            "answer": "x",
            "sources": [
                {
                    "doc_id": "kb-007",
                    "doc_title": "t",
                    "section": "s",
                    "chunk_id": "kb-007-0001",
                    "score": "not-a-number",  # 契约要求 number
                    "page": None,
                }
            ],
            "boundary": "in_kb",
            "confidence": 0.5,
        }
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(bad, schema)


if __name__ == "__main__":
    unittest.main()
