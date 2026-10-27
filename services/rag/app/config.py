"""RAG 服务配置（全部可用环境变量覆盖，与 .env.example 一一对应）"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = SERVICE_DIR.parent.parent


def _load_env() -> None:
    """读取仓库根目录 .env（不存在则忽略），显式环境变量优先"""
    env_path = REPO_DIR / ".env"
    if not env_path.exists():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())
    except OSError:
        pass


_load_env()


def _path(value: str, default: str) -> Path:
    p = Path(value or default)
    return p if p.is_absolute() else (REPO_DIR / p).resolve()


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("RAG_HOST", "127.0.0.1")
    port: int = int(os.getenv("RAG_PORT", "8083"))

    kb_dir: Path = field(default_factory=lambda: _path(os.getenv("KB_DIR", "./data/kb"), "./data/kb"))
    chroma_dir: Path = field(
        default_factory=lambda: _path(os.getenv("CHROMA_DIR", "./data/chroma"), "./data/chroma")
    )
    manifest_path: Path = field(
        default_factory=lambda: _path(os.getenv("MANIFEST_PATH", "./data/manifest.json"), "./data/manifest.json")
    )

    vector_store: str = os.getenv("VECTOR_STORE", "chroma").lower()
    load_existing: bool = os.getenv("RAG_LOAD_EXISTING", "1") != "0"

    chunk_size: int = int(os.getenv("CHUNK_SIZE", "800"))
    chunk_overlap: int = int(os.getenv("CHUNK_OVERLAP", "120"))
    table_row_group: int = int(os.getenv("TABLE_ROW_GROUP", "8"))

    retrieve_top_k: int = int(os.getenv("RETRIEVE_TOP_K", "8"))
    filter_threshold: float = float(os.getenv("FILTER_THRESHOLD", "0.35"))
    final_top_k: int = int(os.getenv("FINAL_TOP_K", "4"))
    rerank_enabled: bool = os.getenv("RERANK_ENABLED", "0") != "0"
    max_retry: int = int(os.getenv("MAX_RETRY", "2"))

    embedding_provider: str = os.getenv("EMBEDDING_PROVIDER", "hash").lower()
    embedding_dim: int = int(os.getenv("EMBEDDING_DIM", "512"))
    embedding_api_key: str = os.getenv("EMBEDDING_API_KEY", "")
    embedding_base_url: str = os.getenv("EMBEDDING_BASE_URL", "https://api.openai.com/v1")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")

    llm_provider: str = os.getenv("RAG_LLM_PROVIDER", "mock").lower()
    llm_api_key: str = os.getenv("RAG_LLM_API_KEY", "")
    llm_base_url: str = os.getenv("RAG_LLM_BASE_URL", "https://api.openai.com/v1")
    llm_model: str = os.getenv("RAG_LLM_MODEL", "gpt-4o-mini")
    llm_timeout_s: float = float(os.getenv("RAG_LLM_TIMEOUT_S", "30"))

    @property
    def embedding_signature(self) -> str:
        """单一真源：直接取 embedder 自报的签名（provider:model:dim）。

        曾在这里手拼 f"{provider}:{embedding_model}:{dim}"，provider=hash 时会错拼成
        hash:text-embedding-3-small:512（默认 model 名的残留），与 HashEmbedder.signature
        （hash:hash-ngram-512:512）互相矛盾——manifest 与 /health 各说各话。
        """
        from .embedding import get_embedder  # 延迟导入：embedding 依赖本模块的 Settings

        return get_embedder(self).signature

    @property
    def chunk_signature(self) -> str:
        return f"{self.chunk_size}/{self.chunk_overlap}/{self.table_row_group}"


settings = Settings()
