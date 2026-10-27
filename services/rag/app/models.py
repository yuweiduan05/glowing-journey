"""对外数据模型（与 packages/shared/src/schemas.ts 的 T4 契约手工对齐，契约测试见 tests/）"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

Boundary = Literal["in_kb", "insufficient", "out_of_scope"]


class Source(BaseModel):
    doc_id: str
    doc_title: str
    section: str
    chunk_id: str
    page: Optional[int] = None
    score: float
    # 契约扩展：引用原文片段（前端「点击展开原文」用），可选
    text: Optional[str] = None


class Filters(BaseModel):
    doc_type: Optional[Literal["product_manual", "faq", "policy", "wiki"]] = None
    product_line: Optional[str] = None


class ChatRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    top_k: int = Field(default=4, ge=1, le=8)
    filters: Filters = Field(default_factory=Filters)
    conversation_id: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    sources: List[Source]
    boundary: Boundary
    confidence: float = Field(ge=0, le=1)
    trace: List[str] = Field(default_factory=list)


class RetrieveRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)
    top_k: int = Field(default=8, ge=1, le=20)
    filters: Filters = Field(default_factory=Filters)


class RetrieveResponse(BaseModel):
    hits: List[Source]
    total_candidates: int
    elapsed_ms: float


class IngestResponse(BaseModel):
    ingested: bool
    skipped: bool
    documents: int
    chunks: int
    elapsed_ms: float
    manifest_version: str
    reason: Optional[str] = None
