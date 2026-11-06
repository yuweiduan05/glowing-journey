import { useMemo, useState } from 'react';
import type { ConversationMeta } from '../lib/demo';
import { IconChevron, IconPlus, IconSearch, IconTrash, IconX } from './icons';
import { Logo } from './Logo';

function groupOf(ts: string): string {
  if (ts === '刚刚' || ts.includes('分钟') || ts === '今天') return '今天';
  if (ts === '昨天') return '近 7 天';
  if (/^\d+\s*天前$/.test(ts)) return '近 7 天';
  return '更早';
}

const GROUP_ORDER = ['今天', '近 7 天', '更早'];

/**
 * 侧栏遵循 DeepSeek 的三段式：品牌 + 新建 + 列表，底部是身份行。
 * 搜索默认收起成图标，避免顶部堆控件；点击才展开输入框。
 */
export function Sidebar({
  open,
  activeId,
  conversations,
  onSelect,
  onNew,
  onDelete,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  activeId: string;
  conversations: ConversationMeta[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

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
        } fixed inset-y-0 left-0 z-50 w-[260px] shrink-0 flex-col bg-white/55 backdrop-blur-xl lg:static lg:z-auto`}
      >
        <div className="flex h-[56px] shrink-0 items-center gap-2 px-3.5">
          <Logo size={26} className="shrink-0 shadow-[0_2px_8px_-3px_rgba(77,107,254,0.55)]" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[14px] font-semibold tracking-tight text-ink">知言</span>
            <span className="block truncate text-[10.5px] text-faint">智联贸易 · 业务智能体</span>
          </span>
          <button
            className="icon-btn h-7 w-7 lg:hidden"
            onClick={onClose}
            aria-label="关闭会话列表"
          >
            <IconX size={16} />
          </button>
          <button
            className={`icon-btn hidden h-7 w-7 lg:inline-flex ${searching ? 'bg-white text-ink' : ''}`}
            onClick={() => setSearching((v) => !v)}
            aria-label={searching ? '收起搜索' : '搜索会话'}
            aria-expanded={searching}
            title="搜索会话"
          >
            <IconSearch size={15} />
          </button>
        </div>

        <div className="px-2.5 pb-2">
          <button
            onClick={onNew}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full border border-line bg-white text-[13px] text-ink transition duration-200 hover:border-ink/15 hover:bg-white active:scale-[0.99]"
          >
            <IconPlus size={14} className="text-muted" />
            开始新的对话
          </button>
        </div>

        {searching && (
          <div className="animate-fade-in px-2.5 pb-2">
            <div className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]">
              <IconSearch size={13} className="shrink-0 text-faint" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setSearching(false);
                  }
                }}
                placeholder="搜索对话"
                aria-label="搜索会话"
                className="h-6 w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
              />
              <button
                className="shrink-0 text-faint transition hover:text-muted"
                onClick={() => {
                  setQuery('');
                  setSearching(false);
                }}
                aria-label="收起搜索"
              >
                <IconX size={13} />
              </button>
            </div>
          </div>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {grouped.length === 0 && (
            <p className="px-2 py-8 text-center text-[11.5px] text-faint">
              {query ? '没有匹配的对话' : '还没有对话'}
            </p>
          )}

          {grouped.map(({ group, items }) => (
            <div key={group} className="mb-2">
              <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-medium text-faint">{group}</p>
              <ul className="space-y-0.5">
                {items.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <li key={c.id} className="group/item relative">
                      <button
                        onClick={() => onSelect(c.id)}
                        aria-current={active ? 'true' : undefined}
                        title={c.title}
                        className={`w-full truncate rounded-lg px-2.5 py-2 pr-8 text-left text-[13px] transition duration-200 ${
                          active
                            ? 'bg-white text-ink shadow-[inset_0_0_0_1px_rgba(77,107,254,0.22)]'
                            : 'text-muted hover:bg-white/70 hover:text-ink'
                        }`}
                      >
                        {c.title}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                        }}
                        className="icon-btn absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition group-hover/item:opacity-100 focus-visible:opacity-100"
                        aria-label={`删除会话：${c.title}`}
                        title="删除对话"
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

        <button
          onClick={onOpenSettings}
          className="flex shrink-0 items-center gap-2.5 border-t border-line px-3 py-2.5 text-left transition hover:bg-white/60"
          aria-label="打开设置与诊断"
          title="设置与诊断"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-[11px] font-medium text-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
            客
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-ink">客户 C-10087</span>
            <span className="block truncate text-[10.5px] text-faint">演示账号 · 设置与诊断</span>
          </span>
          <IconChevron size={13} className="shrink-0 text-faint" />
        </button>
      </aside>
    </>
  );
}
