import { useState } from 'react';
import type { Citation } from '../lib/gateway';
import { IconBook, IconChevron } from './icons';

/**
 * 引用：默认只占一行「来源 · 4」，点开才是列表，再点某条才展开原文。
 *
 * 主流对话产品的引用都是「脚注」而非「并列面板」：正文里的 [n] 是主线索，
 * 来源列表是备查信息，不应该和答案抢空间。
 */
export function Sources({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  if (!citations.length) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-[12px] text-muted transition hover:text-ink"
      >
        <IconBook size={12} className="text-faint" />
        来源 · {citations.length}
        <IconChevron size={11} className={`text-faint transition ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <ol className="mt-2 animate-fade-in space-y-1 rounded-xl bg-subtle p-2">
          {citations.map((c, i) => {
            const isOpen = active === c.chunk_id;
            return (
              <li key={c.chunk_id}>
                <button
                  onClick={() => setActive(isOpen ? null : c.chunk_id)}
                  className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-white"
                  aria-expanded={isOpen}
                >
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded bg-white font-mono text-[10px] text-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-ink">{c.doc_title}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {c.section}
                      {Number.isFinite(c.score) ? ` · ${c.score.toFixed(3)}` : ''}
                    </span>
                  </span>
                  <IconChevron
                    size={11}
                    className={`mt-1 shrink-0 text-faint transition ${isOpen ? 'rotate-90' : ''}`}
                  />
                </button>
                {isOpen && (
                  <p className="mb-1 ml-7 mr-1 rounded-lg bg-white px-2.5 py-2 text-[12px] leading-relaxed text-muted">
                    {c.text ? c.text : '该来源未返回原文片段，仅提供文档与章节信息。'}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
