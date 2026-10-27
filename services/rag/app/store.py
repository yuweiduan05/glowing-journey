"""
向量库适配层

- ChromaStore：默认实现（`VECTOR_STORE=chroma`），持久化目录 + 集合名带 embedding 签名，
  避免换模型后命中旧向量空间；
- LocalStore：零依赖兜底（`VECTOR_STORE=local` 或 chromadb 未安装时自动降级），
  JSONL 持久化 + 纯 Python 余弦计算。二者接口一致，上层检索逻辑不感知差异。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .chunking import Chunk


@dataclass
class Hit:
    chunk: Chunk
    cosine: float


def _where(filters: Dict[str, str]) -> Optional[dict]:
    clauses = [{k: v} for k, v in filters.items() if v]
    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _chunk_from_metadata(metadata: dict, text: str) -> Chunk:
    return Chunk(
        chunk_id=str(metadata.get("chunk_id", "")),
        doc_id=str(metadata.get("doc_id", "")),
        doc_title=str(metadata.get("doc_title", "")),
        doc_type=str(metadata.get("doc_type", "wiki")),
        product_line=str(metadata.get("product_line", "general")),
        section=str(metadata.get("section", "")),
        section_path=str(metadata.get("section_path", "")),
        page=None if int(metadata.get("page", -1)) < 0 else int(metadata.get("page", -1)),
        text=text,
        is_table=bool(int(metadata.get("is_table", 0))),
    )


class LocalStore:
    """纯 Python 向量库：够用的规模（数千 chunk）下延迟 < 30ms"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.chunks: List[Chunk] = []
        self.vectors: List[List[float]] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for item in payload.get("items", []):
            meta = item["metadata"]
            self.chunks.append(_chunk_from_metadata(meta, item["text"]))
            self.vectors.append(item["vector"])

    def add(self, chunks: Sequence[Chunk], vectors: Sequence[Sequence[float]]) -> None:
        self.chunks.extend(chunks)
        self.vectors.extend([list(v) for v in vectors])

    def query(self, vector: Sequence[float], top_k: int, filters: Dict[str, str]) -> List[Hit]:
        scored: List[Hit] = []
        for chunk, vec in zip(self.chunks, self.vectors):
            if filters:
                if any(getattr(chunk, k, None) != v for k, v in filters.items() if v):
                    continue
            dot = sum(a * b for a, b in zip(vector, vec))
            na = math.sqrt(sum(a * a for a in vector)) or 1.0
            nb = math.sqrt(sum(b * b for b in vec)) or 1.0
            scored.append(Hit(chunk=chunk, cosine=dot / (na * nb)))
        scored.sort(key=lambda h: h.cosine, reverse=True)
        return scored[:top_k]

    def count(self) -> int:
        return len(self.chunks)

    def iter_all(self) -> List[Chunk]:
        return list(self.chunks)

    def reset(self) -> None:
        self.chunks = []
        self.vectors = []
        if self.path.exists():
            self.path.unlink()

    def persist(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        items = [
            {"metadata": c.metadata(), "text": c.text, "vector": v}
            for c, v in zip(self.chunks, self.vectors)
        ]
        self.path.write_text(json.dumps({"items": items}, ensure_ascii=False), encoding="utf-8")


class ChromaStore:
    def __init__(self, directory: Path, collection_name: str) -> None:
        import chromadb  # 延迟导入：未安装时由 factory 降级

        directory.mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(path=str(directory))
        self.name = collection_name
        self.collection = self.client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )

    def add(self, chunks: Sequence[Chunk], vectors: Sequence[Sequence[float]]) -> None:
        batch = 256
        for i in range(0, len(chunks), batch):
            part = chunks[i : i + batch]
            self.collection.add(
                ids=[c.chunk_id for c in part],
                embeddings=[list(v) for v in vectors[i : i + batch]],
                documents=[c.text for c in part],
                metadatas=[c.metadata() for c in part],
            )

    def query(self, vector: Sequence[float], top_k: int, filters: Dict[str, str]) -> List[Hit]:
        res = self.collection.query(
            query_embeddings=[list(vector)],
            n_results=max(top_k, 1),
            where=_where(filters),
            include=["documents", "metadatas", "distances"],
        )
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        hits: List[Hit] = []
        for text, meta, dist in zip(docs, metas, dists):
            hits.append(
                Hit(chunk=_chunk_from_metadata(meta or {}, text or ""), cosine=max(0.0, 1.0 - float(dist)))
            )
        return hits

    def count(self) -> int:
        return int(self.collection.count())

    def iter_all(self) -> List[Chunk]:
        res = self.collection.get(include=["documents", "metadatas"])
        docs = res.get("documents") or []
        metas = res.get("metadatas") or []
        return [
            _chunk_from_metadata(meta or {}, text or "")
            for text, meta in zip(docs, metas)
        ]

    def reset(self) -> None:
        try:
            self.client.delete_collection(self.name)
        except Exception:  # noqa: BLE001 - 集合不存在时忽略
            pass
        self.collection = self.client.get_or_create_collection(
            name=self.name,
            metadata={"hnsw:space": "cosine"},
        )

    def persist(self) -> None:
        """Chroma PersistentClient 自动落盘，无需显式操作"""
        return


Store = LocalStore | ChromaStore


def collection_name(signature: str) -> str:
    import hashlib

    digest = hashlib.sha1(signature.encode("utf-8")).hexdigest()[:10]
    return f"kb_{digest}"


def build_store(directory: Path, signature: str, prefer: str) -> Tuple[Store, str]:
    """返回 (store, 实际使用的实现名)，实现名会写进 /health 便于排查"""
    if prefer == "chroma":
        try:
            return ChromaStore(directory, collection_name(signature)), "chroma"
        except Exception:  # noqa: BLE001 - 缺依赖/版本不兼容时降级
            pass
    directory.mkdir(parents=True, exist_ok=True)
    return LocalStore(directory / f"local-{collection_name(signature)}.json"), "local"
