"""
RAG 服务入口（:8083）

接口（对应 2.6：/chat 与 /health 必须对外保留，不因被内嵌为工具而降级为纯函数）：
  POST /chat           六节点状态图生成，返回 answer + sources + boundary + confidence + trace
  POST /retrieve       只做检索，便于逐环节验证
  GET  /health         Chroma 连接 / chunk 数 / manifest 版本 / 图引擎
  POST /admin/ingest   重建或增量校验入库
  GET  /admin/manifest 当前库的 manifest
  GET  /admin/graph    状态图 Mermaid（截图进文档）
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse

from .boundary import is_out_of_scope
from .config import settings
from .embedding import get_embedder
from .graph import RAGGraph
from .ingest import Ingestor
from .models import (
    ChatRequest,
    ChatResponse,
    IngestResponse,
    RetrieveRequest,
    RetrieveResponse,
    Source,
)
from .retrieval import search
from .store import build_store

SERVICE_VERSION = "0.1.0"

store, store_kind = build_store(
    settings.chroma_dir,
    f"{settings.embedding_signature}|{settings.chunk_signature}",
    settings.vector_store,
)
ingestor = Ingestor(settings, store)
graph = RAGGraph(settings, store)

started_at = time.time()
last_ingest: dict = {"status": "pending"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    global last_ingest
    try:
        result = ingestor.ensure_ready()
        last_ingest = {
            "status": "skipped" if result is None else "built",
            "chunks": store.count(),
            "at": time.time(),
        }
        print(
            f"[rag] store={store_kind} chunks={store.count()} graph={graph.engine} "
            f"embedding={get_embedder(settings).signature} last_ingest={last_ingest['status']}"
        )
    except Exception as exc:  # noqa: BLE001
        last_ingest = {"status": "failed", "error": str(exc)}
        print(f"[rag] 启动入库失败：{exc}")
    yield


app = FastAPI(title="Enterprise Knowledge RAG", version=SERVICE_VERSION, lifespan=lifespan)


@app.middleware("http")
async def trace_requests(request, call_next):
    """把网关透传的 request_id / conversation_id 打进日志，并回写响应头，方便三方日志串联。"""
    request_id = request.headers.get("x-request-id", "-")
    conversation_id = request.headers.get("x-conversation-id", "-")
    started = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - started) * 1000
    print(
        f"[http] {request.method} {request.url.path} "
        f"rid={request_id} cid={conversation_id} status={response.status_code} {elapsed:.0f}ms"
    )
    response.headers["X-Request-Id"] = request_id
    return response


@app.get("/health")
async def health():
    manifest = ingestor.read_manifest() or {}
    return {
        "status": "ok" if store.count() > 0 else "degraded",
        "service": "rag-service",
        "version": SERVICE_VERSION,
        "ts": int(time.time() * 1000),
        "uptime_s": round(time.time() - started_at, 1),
        "checks": {
            "vector_store": {"status": "ok", "detail": f"{store_kind} / chunks={store.count()}"},
            "manifest": {
                "status": "ok" if manifest else "degraded",
                "detail": f"version={manifest.get('version', 'none')} built_at={manifest.get('built_at', '-')}",
            },
            "graph": {"status": "ok", "detail": f"engine={graph.engine}"},
            "embedding": {"status": "ok", "detail": get_embedder(settings).signature},
            "last_ingest": {"status": last_ingest.get("status", "unknown"), "detail": last_ingest.get("error", "")},
        },
    }


@app.post("/retrieve", response_model=RetrieveResponse)
async def retrieve(req: RetrieveRequest):
    started = time.perf_counter()
    if is_out_of_scope(req.question):
        return RetrieveResponse(hits=[], total_candidates=0, elapsed_ms=0.0)
    hits = search(
        store,
        get_embedder(settings),
        req.question,
        top_k=req.top_k,
        filters=req.filters.model_dump(exclude_none=True),
    )
    return RetrieveResponse(
        hits=[
            Source(
                doc_id=h.chunk.doc_id,
                doc_title=h.chunk.doc_title,
                section=h.chunk.section,
                chunk_id=h.chunk.chunk_id,
                page=h.chunk.page,
                score=round(h.score, 4),
                text=h.chunk.text[:400],
            )
            for h in hits
        ],
        total_candidates=len(hits),
        elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if store.count() == 0:
        raise HTTPException(
            status_code=503,
            detail={"code": "RAG_UNAVAILABLE", "message": "知识库未建立索引，请先调用 /admin/ingest"},
        )

    state = graph.run(
        req.question,
        # 客户端未显式传 top_k 时传 None → 走 settings 默认（候选 8 / 返回 4）；
        # 显式传入（契约 1..8）则同时决定候选规模与最终返回条数
        top_k=req.top_k if "top_k" in req.model_fields_set else None,
        filters=req.filters.model_dump(exclude_none=True),
    )
    return ChatResponse(
        answer=state.get("answer", ""),
        sources=[Source(**s) for s in state.get("sources", [])],
        boundary=state.get("boundary", "insufficient"),  # type: ignore[arg-type]
        confidence=float(state.get("confidence", 0.0)),
        trace=state.get("trace", []),
    )


@app.post("/admin/ingest", response_model=IngestResponse)
async def admin_ingest(payload: Optional[dict] = None):
    force = bool((payload or {}).get("force", False))
    try:
        return ingestor.ingest(force=force)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail={"code": "INGEST_FAILED", "message": str(exc)},
        ) from exc


@app.get("/admin/manifest")
async def admin_manifest():
    manifest = ingestor.read_manifest()
    if not manifest:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "manifest 不存在"})
    return manifest


@app.get("/admin/graph", response_class=PlainTextResponse)
async def admin_graph():
    return graph.mermaid()
