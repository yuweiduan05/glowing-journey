import { useMemo, useState } from 'react';
import type { ConversationMeta } from '../lib/demo';
import { IconPlus, IconSearch, IconSettings, IconTrash, IconX } from './icons';

function groupOf(ts: string): string {
  if (ts === '刚刚' || ts.includes('分钟')) return '今天';
  if (ts === '昨天') return '昨天';
  return '更早';
}

const GROUP_ORDER = ['今天', '昨天', '更早'];

export function Sidebar({
  open,
  activeId,
  conversations,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  open: boolean;
  activeId: string;
  conversations: ConversationMeta[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const filtered = conversations.filter(
      (c) =>
        !keyword ||
        c.title.toLowerCase().includes(keyword) ||
        c.preview.toLowerCase().includes(keyword),
    );
    return GROUP_ORDER.map((group) => ({
      group,
      items: filtered.filter((c) => groupOf(c.ts) === group),
    })).filter((g) => g.items.length);
  }, [conversations, query]);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/25 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={`${
          open ? 'flex' : 'hidden'
        } fixed inset-y-0 left-0 z-50 w-[264px] shrink-0 flex-col bg-subtle lg:static lg:z-auto`}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2 px-3">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-[12px] font-semibold text-white">
            智
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">智联贸易</p>
            <p className="truncate text-[10.5px] text-faint">业务智能体</p>
          </div>
          <button className="icon-btn lg:hidden" onClick={onClose} aria-label="关闭会话列表">
            <IconX size={16} />
          </button>
        </div>

        <div className="px-2.5">
          <button
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] text-ink transition hover:bg-surface"
          >
            <IconPlus size={15} className="text-muted" />
            新建会话
          </button>
        </div>

        <div className="px-2.5 pb-1 pt-2.5">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1 text-muted transition focus-within:bg-white">
            <IconSearch size={14} className="text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会话"
              aria-label="搜索会话"
              className="h-7 w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
            />
            {query && (
              <button className="text-faint hover:text-muted" onClick={() => setQuery('')} aria-label="清除搜索">
                <IconX size={13} />
              </button>
            )}
          </div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {grouped.length === 0 && (
            <p className="px-2 py-8 text-center text-[11.5px] text-faint">
              {query ? '没有匹配的会话' : '还没有会话'}
            </p>
          )}

          {grouped.map(({ group, items }) => (
            <div key={group} className="mb-3">
              <p className="px-2 pb-1 pt-1.5 text-[10.5px] text-faint">{group}</p>
              <ul className="space-y-px">
                {items.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <li key={c.id} className="group/item relative">
                      <button
                        onClick={() => onSelect(c.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`w-full rounded-lg px-2 py-1.5 pr-7 text-left transition ${
                          active ? 'bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]' : 'hover:bg-white/70'
                        }`}
                      >
                        <span className={`block truncate text-[12.5px] ${active ? 'text-ink' : 'text-muted'}`}>
                          {c.title}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-faint">{c.preview}</span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                        }}
                        className="icon-btn absolute right-0.5 top-1.5 h-6 w-6 opacity-0 transition group-hover/item:opacity-100 focus-visible:opacity-100"
                        aria-label={`删除会话：${c.title}`}
                        title="删除会话"
                      >
                        <IconTrash size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="flex items-center justify-between border-t border-line px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-[11px] text-faint">
            <IconSettings size={13} />
            设置与诊断在右上角
          </span>
          <span className="font-mono text-[10px] text-faint">C-10087</span>
        </div>
      </aside>
    </>
  );
}
