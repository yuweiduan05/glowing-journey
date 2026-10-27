"""
切块策略（对应 2.6「切块策略」与场景2 明示参数 800/120）

三条规则分别对应三种文档形态：
1. 正文：按标题层级优先切分，800 字符 / 120 重叠，section_path 入 metadata；
2. 表格：整表转 Markdown 保留表头，按行组切块，**每块重复表头**（否则脱离表头后列义丢失）；
3. 中英混排：按 `。！？\\n` 与英文句点双规则切；URL / 型号 / SKU 先替换为不可切分占位符。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
TABLE_LINE_RE = re.compile(r"^\s*\|.*\|\s*$")

# 不可切分 token：URL、SKU、常见型号（字母+数字+连字符）
PROTECT_PATTERNS = [
    re.compile(r"https?://[^\s，。；）)]+"),
    re.compile(r"SKU-[A-Z0-9]{6}"),
    re.compile(r"\b[A-Z]{1,4}-\d{2,5}[A-Z]?\b"),
    re.compile(r"\bSO-\d{8}-\d{3}\b"),
    re.compile(r"\bTK-\d{8}-\d{4}\b"),
    re.compile(r"\b\d+(?:\.\d+)?\s?(?:mm|cm|kg|g|V|A|℃|%)\b"),
]

SENTENCE_END = re.compile(r"(?<=[。！？!?；;])|(?<=\.)\s+|\n+")


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    doc_title: str
    doc_type: str
    product_line: str
    section: str
    section_path: str
    page: Optional[int]
    text: str
    is_table: bool
    index: int = 0

    def metadata(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "doc_title": self.doc_title,
            "doc_type": self.doc_type,
            "product_line": self.product_line,
            "section": self.section,
            "section_path": self.section_path,
            "page": self.page if self.page is not None else -1,
            "chunk_id": self.chunk_id,
            "is_table": 1 if self.is_table else 0,
        }


def _protect(text: str) -> Tuple[str, List[str]]:
    tokens: List[str] = []

    def repl(match: re.Match[str]) -> str:
        tokens.append(match.group(0))
        return f"\x00{len(tokens) - 1}\x00"

    for pattern in PROTECT_PATTERNS:
        text = pattern.sub(repl, text)
    return text, tokens


def _restore(text: str, tokens: List[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        idx = int(match.group(1))
        return tokens[idx] if idx < len(tokens) else match.group(0)

    return re.sub(r"\x00(\d+)\x00", repl, text)


def split_sentences(text: str) -> List[str]:
    protected, tokens = _protect(text)
    parts = [p for p in SENTENCE_END.split(protected) if p and p.strip()]
    return [_restore(p, tokens).strip() for p in parts]


def pack_chunks(text: str, size: int, overlap: int) -> List[str]:
    """按句子打包到 <=size，相邻块保留 overlap 字符（对齐到句子边界）"""
    sentences = split_sentences(text)
    if not sentences:
        return []

    chunks: List[str] = []
    current = ""
    for sentence in sentences:
        if len(sentence) > size:
            # 超长单句（如没有标点的表格行）按硬切分兜底
            if current:
                chunks.append(current.strip())
                current = ""
            for i in range(0, len(sentence), size - overlap):
                chunks.append(sentence[i : i + size].strip())
            continue

        if len(current) + len(sentence) + 1 <= size:
            current = f"{current} {sentence}".strip()
        else:
            chunks.append(current.strip())
            tail = current[-overlap:] if overlap > 0 else ""
            # 让重叠部分尽量从句子边界开始，避免半句
            if tail:
                for sep in ("。", "！", "？", "\n", "；", ". "):
                    pos = tail.find(sep)
                    if 0 <= pos < len(tail) - 1:
                        tail = tail[pos + 1 :]
                        break
            current = f"{tail} {sentence}".strip()
    if current.strip():
        chunks.append(current.strip())
    return [c for c in chunks if c]


def split_table_block(block: List[str], row_group: int) -> List[str]:
    """表格按行组切块，每块重复表头（表头 + 分隔行）"""
    if len(block) < 3:
        return ["\n".join(block)]
    header = block[0]
    separator = block[1]
    rows = block[2:]
    out: List[str] = []
    for i in range(0, len(rows), row_group):
        group = rows[i : i + row_group]
        out.append("\n".join([header, separator, *group]))
    return out


def parse_front_matter(raw: str) -> Tuple[dict, str]:
    if not raw.startswith("---"):
        return {}, raw
    lines = raw.splitlines()
    meta: dict = {}
    end = -1
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = i
            break
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    if end < 0:
        return {}, raw
    return meta, "\n".join(lines[end + 1 :])


def chunk_document(
    path: Path,
    *,
    size: int,
    overlap: int,
    row_group: int,
    doc_type_fallback: str = "wiki",
) -> List[Chunk]:
    raw = path.read_text(encoding="utf-8")
    meta, body = parse_front_matter(raw)

    doc_id = meta.get("doc_id") or path.stem
    doc_title = meta.get("title") or path.stem
    doc_type = meta.get("doc_type") or doc_type_fallback
    product_line = meta.get("product_line") or "general"

    chunks: List[Chunk] = []
    section_stack: List[Tuple[int, str]] = []
    paragraph: List[str] = []
    table: List[str] = []
    idx = 0

    def section_name() -> str:
        return section_stack[-1][1] if section_stack else doc_title

    def section_path() -> str:
        return " > ".join(name for _, name in section_stack) or doc_title

    def emit_text() -> None:
        nonlocal idx, paragraph
        text = "\n".join(paragraph).strip()
        paragraph = []
        if not text:
            return
        for piece in pack_chunks(text, size, overlap):
            chunks.append(
                Chunk(
                    chunk_id=f"{doc_id}-{idx:04d}",
                    doc_id=doc_id,
                    doc_title=doc_title,
                    doc_type=doc_type,
                    product_line=product_line,
                    section=section_name(),
                    section_path=section_path(),
                    page=None,
                    text=piece,
                    is_table=False,
                    index=idx,
                )
            )
            idx += 1

    def emit_table() -> None:
        nonlocal idx, table
        if not table:
            return
        for piece in split_table_block(table, row_group):
            prefix = f"【表格】{section_name()}\n"
            chunks.append(
                Chunk(
                    chunk_id=f"{doc_id}-{idx:04d}",
                    doc_id=doc_id,
                    doc_title=doc_title,
                    doc_type=doc_type,
                    product_line=product_line,
                    section=section_name(),
                    section_path=section_path(),
                    page=None,
                    text=prefix + piece,
                    is_table=True,
                    index=idx,
                )
            )
            idx += 1
        table = []

    for line in body.splitlines():
        heading = HEADING_RE.match(line)
        if heading:
            emit_text()
            emit_table()
            level = len(heading.group(1))
            title = heading.group(2).strip()
            section_stack = [(lv, t) for lv, t in section_stack if lv < level]
            section_stack.append((level, title))
            continue

        if TABLE_LINE_RE.match(line):
            emit_text()
            table.append(line.strip())
            continue

        if table:
            emit_table()
        paragraph.append(line)

    emit_text()
    emit_table()
    return chunks


def iter_kb_files(kb_dir: Path) -> Iterable[Path]:
    for suffix in ("*.md", "*.markdown", "*.txt"):
        yield from sorted(kb_dir.glob(suffix))
