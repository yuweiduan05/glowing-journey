"""
Embedding 适配层（对应 2.6 / 6.1 风险 R6 的兜底设计）

三种实现，按 `EMBEDDING_PROVIDER` 切换：
- hash   ：零依赖、离线、确定性。字符 2/3-gram + 英文词哈希到固定维度（默认 512），
           配合检索层的词覆盖混合打分，中文短问题召回稳定，用于演示与离线评测；
- openai ：任何 OpenAI 兼容的 /embeddings 接口（可指向自建 bge 服务）；
- bge    ：sentence-transformers 的 bge-small-zh（需额外安装 torch，未预装时自动降级 hash）。

设计要点：embedding 的签名（provider:model:dim）会写进 manifest，
换模型必须重建库，否则向量空间不一致 —— 这是「支持已有库直接加载」的前提。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.error
import urllib.request
from typing import List, Sequence

from .config import Settings

_LATIN_RE = re.compile(r"[a-z0-9]{2,}")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def _features(text: str) -> List[str]:
    lowered = text.lower()
    feats: List[str] = [f"w:{w}" for w in _LATIN_RE.findall(lowered)]
    for seg in _CJK_RE.findall(lowered):
        for n in (2, 3):
            if len(seg) < n:
                continue
            for i in range(len(seg) - n + 1):
                feats.append(f"c:{seg[i:i + n]}")
    return feats


class HashEmbedder:
    """确定性哈希向量：不依赖任何模型文件，离线可跑、结果可复现"""

    def __init__(self, dim: int = 512) -> None:
        self.dim = dim
        self.provider = "hash"
        self.model = f"hash-ngram-{dim}"
        self.signature = f"hash:{self.model}:{dim}"

    def _one(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        counts: dict[int, float] = {}
        for feat in _features(text):
            digest = hashlib.blake2b(feat.encode("utf-8"), digest_size=8).digest()
            value = int.from_bytes(digest, "big")
            idx = value % self.dim
            sign = 1.0 if (value >> 63) & 1 else -1.0
            counts[idx] = counts.get(idx, 0.0) + sign

        for idx, count in counts.items():
            # 亚线性词频，抑制长文档里高频词的支配
            vec[idx] = math.copysign(1.0 + math.log1p(abs(count)), count)

        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        return [self._one(t) for t in texts]

    def embed_query(self, text: str) -> List[float]:
        return self._one(text)


class OpenAIEmbedder:
    def __init__(self, settings: Settings) -> None:
        self.api_key = settings.embedding_api_key
        self.base_url = settings.embedding_base_url.rstrip("/")
        self.model = settings.embedding_model
        self.dim = settings.embedding_dim
        self.provider = "openai"
        self.signature = f"openai:{self.model}:{self.dim}"

    def _call(self, inputs: Sequence[str]) -> List[List[float]]:
        body = json.dumps({"model": self.model, "input": list(inputs)}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/embeddings",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
        data = sorted(payload["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        out: List[List[float]] = []
        for i in range(0, len(texts), 32):
            out.extend(self._call(texts[i : i + 32]))
        return out

    def embed_query(self, text: str) -> List[float]:
        return self._call([text])[0]


class SentenceTransformerEmbedder:  # pragma: no cover - 需额外安装 torch
    def __init__(self, model_name: str = "BAAI/bge-small-zh-v1.5") -> None:
        from sentence_transformers import SentenceTransformer  # type: ignore

        self.model = SentenceTransformer(model_name)
        self.provider = "bge"
        self.dim = int(self.model.get_sentence_embedding_dimension())
        self.signature = f"bge:{model_name}:{self.dim}"

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        return [v.tolist() for v in self.model.encode(list(texts), normalize_embeddings=True)]

    def embed_query(self, text: str) -> List[float]:
        return self.model.encode([text], normalize_embeddings=True)[0].tolist()


_embedder = None


def get_embedder(settings: Settings):
    global _embedder
    if _embedder is not None:
        return _embedder

    if settings.embedding_provider == "openai" and settings.embedding_api_key:
        _embedder = OpenAIEmbedder(settings)
    elif settings.embedding_provider == "bge":
        try:
            _embedder = SentenceTransformerEmbedder()
        except Exception:  # noqa: BLE001 - 缺依赖时按 R6 兜底降级
            _embedder = HashEmbedder(settings.embedding_dim)
    else:
        _embedder = HashEmbedder(settings.embedding_dim)
    return _embedder


def reset_embedder() -> None:
    """测试用：切换 provider 后清空单例"""
    global _embedder
    _embedder = None
