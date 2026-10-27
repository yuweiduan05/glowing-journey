"""
入库流水线（对应 2.6「支持已有库直接加载」与 P2 任务 2）

解析 → 切块 → Embedding → 入库 → manifest.json（sha256 + 切块参数 + embedding 签名 + 版本）
启动时校验 manifest：命中则跳过重建（RAG_LOAD_EXISTING=1），参数或文档变化则提示重建。
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from .chunking import chunk_document, iter_kb_files
from .config import Settings
from .embedding import get_embedder
from .models import IngestResponse
from .store import Store


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest_version(signature: str, docs: Dict[str, str]) -> str:
    basis = signature + "|" + "|".join(f"{k}:{v}" for k, v in sorted(docs.items()))
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:12]


class Ingestor:
    def __init__(self, settings: Settings, store: Store) -> None:
        self.settings = settings
        self.store = store
        self.embedder = get_embedder(settings)

    # ---------- manifest ----------
    def read_manifest(self) -> Optional[dict]:
        path = self.settings.manifest_path
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def current_docs(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for path in iter_kb_files(self.settings.kb_dir):
            out[str(path.relative_to(self.settings.kb_dir)).replace("\\", "/")] = sha256_file(path)
        return out

    def is_fresh(self) -> tuple[bool, str]:
        manifest = self.read_manifest()
        if not manifest:
            return False, "manifest 不存在"
        sig = f"{self.settings.embedding_signature}|{self.settings.chunk_signature}"
        if manifest.get("signature") != sig:
            return False, "切块/embedding 参数变化，需要重建"
        if manifest.get("docs") != self.current_docs():
            return False, "知识库文档发生变化，需要重建"
        if self.store.count() == 0:
            return False, "向量库为空，需要重建"
        if self.store.count() != manifest.get("total_chunks"):
            return False, "向量库 chunk 数与 manifest 不一致，需要重建"
        return True, "命中已有库，跳过重建"

    # ---------- 构建 ----------
    def ingest(self, force: bool = False) -> IngestResponse:
        started = time.perf_counter()

        fresh, reason = self.is_fresh()
        if fresh and not force and self.settings.load_existing:
            manifest = self.read_manifest() or {}
            return IngestResponse(
                ingested=False,
                skipped=True,
                documents=len(manifest.get("docs", {})),
                chunks=int(manifest.get("total_chunks", 0)),
                elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
                manifest_version=str(manifest.get("version", "unknown")),
                reason=reason,
            )

        files = list(iter_kb_files(self.settings.kb_dir))
        if not files:
            raise RuntimeError(f"知识库目录为空：{self.settings.kb_dir}")

        self.store.reset()

        all_chunks = []
        per_doc: List[dict] = []
        for path in files:
            chunks = chunk_document(
                path,
                size=self.settings.chunk_size,
                overlap=self.settings.chunk_overlap,
                row_group=self.settings.table_row_group,
            )
            all_chunks.extend(chunks)
            per_doc.append(
                {
                    "doc_id": chunks[0].doc_id if chunks else path.stem,
                    "title": chunks[0].doc_title if chunks else path.stem,
                    "doc_type": chunks[0].doc_type if chunks else "wiki",
                    "product_line": chunks[0].product_line if chunks else "general",
                    "file": str(path.relative_to(self.settings.kb_dir)).replace("\\", "/"),
                    "chunks": len(chunks),
                }
            )

        vectors = self.embedder.embed_documents([c.text for c in all_chunks])
        self.store.add(all_chunks, vectors)
        self.store.persist()

        manifest = {
            "version": manifest_version(
                f"{self.settings.embedding_signature}|{self.settings.chunk_signature}",
                self.current_docs(),
            ),
            "built_at": datetime.now(timezone.utc).isoformat(),
            "signature": f"{self.settings.embedding_signature}|{self.settings.chunk_signature}",
            "chunk_size": self.settings.chunk_size,
            "chunk_overlap": self.settings.chunk_overlap,
            "table_row_group": self.settings.table_row_group,
            "embedding": self.settings.embedding_signature,
            "total_chunks": len(all_chunks),
            "documents": per_doc,
            "docs": self.current_docs(),
        }
        self.settings.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings.manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # 溯源导出：chunk_id → 文档/章节/序号/原文。评测报告只存 docs[:3]，
        # 有了它才能离线复算 chunk 级指标，也便于第三方抽查引用是否真实存在。
        chunks_path = self.settings.manifest_path.parent / "chunks.jsonl"
        with chunks_path.open("w", encoding="utf-8") as fh:
            for c in all_chunks:
                fh.write(
                    json.dumps(
                        {
                            "chunk_id": c.chunk_id,
                            "doc_id": c.doc_id,
                            "doc_title": c.doc_title,
                            "doc_type": c.doc_type,
                            "section": c.section,
                            "section_path": c.section_path,
                            "index": c.index,
                            "is_table": c.is_table,
                            "text": c.text,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

        elapsed = round((time.perf_counter() - started) * 1000, 1)
        print(f"[ingest] documents={len(files)} chunks={len(all_chunks)} cost={elapsed}ms")

        return IngestResponse(
            ingested=True,
            skipped=False,
            documents=len(files),
            chunks=len(all_chunks),
            elapsed_ms=elapsed,
            manifest_version=manifest["version"],
        )

    def ensure_ready(self) -> Optional[IngestResponse]:
        fresh, _ = self.is_fresh()
        if fresh:
            return None
        return self.ingest(force=False)
