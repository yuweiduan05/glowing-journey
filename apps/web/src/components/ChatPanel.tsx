import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Boundary } from '@app/shared';
import type { ChatMessage } from '../lib/types';
import {
  ACCEPT_ATTR,
  MAX_FILES,
  formatBytes,
  readAttachment,
  type Attachment,
} from '../lib/attachments';
import {
  IconBook,
  IconBox,
  IconCheck,
  IconCopy,
  IconFile,
  IconPaperclip,
  IconRefresh,
  IconSend,
  IconStop,
  IconTicket,
  IconTruck,
  IconX,
} from './icons';
import { Reasoning } from './Reasoning';
import { Sources } from './Sources';

export type { ChatMessage };

/** 只在「答案有风险」时提示；in_kb 不打扰 */
const BOUNDARY_NOTE: Record<
  Exclude<Boundary, 'in_kb'>,
  { text: string; cls: string }
> = {
  insufficient: {
    text: '知识库没有覆盖这个问题，下面是基于已有信息的回答',
    cls: 'bg-amber-50 text-amber-800',
  },
  out_of_scope: {
    text: '这个问题超出业务范围，已拒答并记录',
    cls: 'bg-rose-50 text-rose-700',
  },
};

const CAPABILITIES = [
  {
    icon: <IconBox size={16} />,
    title: '查库存',
    desc: '可用量、安全库存、在途与替代型号',
    prompt: '深圳仓 SKU-A1B2C3 还有多少可用库存？',
  },
  {
    icon: <IconTruck size={16} />,
    title: '追订单',
    desc: '状态、物流、明细，自动识别少发',
    prompt: '订单 SO-20261012-007 到哪了？',
  },
  {
    icon: <IconTicket size={16} />,
    title: '建工单',
    desc: '按问题建单，重复提交不重复创建',
    prompt: '客户说少发了一件，帮我建个工单',
  },
  {
    icon: <IconBook size={16} />,
    title: '问政策',
    desc: '保修、换货、发票，答案带引用',
    prompt: '这款设备的保修期是多久？换货要什么条件？',
  },
];

const BOUNDARY_SAMPLES = [
  { label: '越界问题', prompt: '你们支持比特币付款吗？' },
  { label: '知识库未覆盖', prompt: '我们公司的股权结构是怎样的？' },
];

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn h-6 w-6"
      title={done ? '已复制' : '复制回答'}
      aria-label={done ? '已复制' : '复制回答'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 剪贴板不可用（非 https / 无权限）时静默失败 */
        }
      }}
    >
      {done ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

function MessageItem({
  msg,
  onRetry,
  onHandoff,
}: {
  msg: ChatMessage;
  onRetry: () => void;
  onHandoff: () => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex animate-fade-up justify-end">
        <div className="max-w-[85%] rounded-2xl bg-surface px-4 py-2.5 text-[14px] leading-7 text-ink">
          {msg.attachments?.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {msg.attachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1 text-[11.5px]"
                >
                  <IconFile size={12} className="shrink-0 text-faint" />
                  <span className="max-w-[200px] truncate text-ink">{a.name}</span>
                  <span className="shrink-0 text-faint">{formatBytes(a.size)}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="whitespace-pre-wrap">{msg.content}</div>
        </div>
      </div>
    );
  }

  const note = msg.boundary && msg.boundary !== 'in_kb' ? BOUNDARY_NOTE[msg.boundary] : null;

  return (
    <article className="group animate-fade-up">
      <Reasoning
        reasoning={msg.reasoning}
        reasoningMs={msg.reasoningMs}
        timeline={msg.timeline}
        streaming={Boolean(msg.streaming)}
        hasContent={Boolean(msg.content)}
      />

      {note && (
        <div className={`mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] ${note.cls}`}>
          <span>{note.text}</span>
          {msg.boundary === 'insufficient' && (
            <button
              onClick={onHandoff}
              className="ml-auto shrink-0 rounded-md border border-current/25 px-2 py-0.5 text-[11px] transition hover:bg-white/40"
            >
              转人工
            </button>
          )}
        </div>
      )}

      {msg.content ? (
        <div className="md">
          <ReactMarkdown>{msg.content}</ReactMarkdown>
          {msg.streaming && (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-ink/50 align-middle" />
          )}
        </div>
      ) : msg.streaming ? null : (
        <p className="text-[13px] text-faint">（没有返回内容）</p>
      )}

      {msg.error && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 px-3 py-2">
          <span className="text-[12px] text-rose-700">本轮失败：{msg.error}</span>
          <button
            onClick={onRetry}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-0.5 text-[11px] text-rose-700 transition hover:bg-rose-50"
          >
            <IconRefresh size={11} />
            重试
          </button>
        </div>
      )}

      {msg.cancelled && <p className="mt-1.5 text-[11.5px] text-faint">已停止生成</p>}

      <Sources citations={msg.citations} />

      <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
        {msg.stats?.totalMs !== undefined && <span>{msg.stats.totalMs}ms</span>}
        {msg.stats?.chain && <span>{msg.stats.chain}</span>}
        <span className="hidden sm:inline">{timeOf(msg.createdAt)}</span>
        {msg.stats?.requestId && (
          <span className="hidden max-w-[140px] truncate font-mono sm:inline" title={msg.stats.requestId}>
            {msg.stats.requestId.slice(0, 8)}
          </span>
        )}
        <span className="ml-auto opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          {msg.content && <CopyButton text={msg.content} />}
        </span>
      </div>
    </article>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-5 py-12">
      <h2 className="text-[26px] font-semibold tracking-tight text-ink sm:text-[28px]">有什么可以帮你？</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
        查实时库存、追订单物流、建售后工单，或问产品与售后政策。每个结论都会给出依据。
      </p>

      <div className="mt-7 grid gap-2 sm:grid-cols-2">
        {CAPABILITIES.map((c) => (
          <button
            key={c.title}
            onClick={() => onPick(c.prompt)}
            className="group/cap rounded-xl border border-line bg-white p-3.5 text-left transition hover:border-ink/15 hover:bg-subtle"
          >
            <span className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-surface text-muted transition group-hover/cap:text-ink">
                {c.icon}
              </span>
              <span className="text-[13px] font-medium text-ink">{c.title}</span>
            </span>
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-muted">{c.desc}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px]">
        <span className="text-faint">试试边界情况：</span>
        {BOUNDARY_SAMPLES.map((b) => (
          <button
            key={b.label}
            onClick={() => onPick(b.prompt)}
            className="text-muted underline decoration-line decoration-1 underline-offset-4 transition hover:text-ink hover:decoration-ink/30"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  busy,
  knowledge,
  onSend,
  onStop,
}: {
  busy: boolean;
  knowledge: boolean;
  onSend: (text: string, attachments?: Attachment[]) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const warn = (message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  };

  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list);
    if (!incoming.length) return;

    const room = MAX_FILES - files.length;
    if (room <= 0) {
      warn(`最多添加 ${MAX_FILES} 个附件`);
      return;
    }

    const accepted: Attachment[] = [];
    for (const file of incoming.slice(0, room)) {
      const result = await readAttachment(file);
      if (result.ok) accepted.push(result.attachment);
      else warn(result.error);
    }
    if (incoming.length > room) warn(`最多添加 ${MAX_FILES} 个附件，已忽略多余文件`);
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  };

  const remove = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const submit = () => {
    if (busy) return;
    const text = draft.trim();
    if (!text && !files.length) return;
    const picked = files;
    setDraft('');
    setFiles([]);
    setNotice(null);
    onSend(text, picked);
  };

  const canSend = Boolean(draft.trim() || files.length);

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-[760px]">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void addFiles(e.dataTransfer.files);
          }}
          className={`rounded-[18px] border bg-white shadow-composer transition ${
            dragging ? 'border-ink/30 bg-subtle' : 'border-line focus-within:border-ink/20'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />

          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {files.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-subtle px-2 py-1 text-[11.5px]"
                >
                  <IconFile size={12} className="shrink-0 text-faint" />
                  <span className="max-w-[170px] truncate text-ink">{f.name}</span>
                  <span className="shrink-0 text-faint">{formatBytes(f.size)}</span>
                  <button
                    onClick={() => remove(f.id)}
                    aria-label={`移除附件：${f.name}`}
                    className="ml-0.5 rounded p-0.5 text-faint transition hover:bg-white hover:text-ink"
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {notice && <p className="px-4 pt-2 text-[11.5px] text-rose-600">{notice}</p>}

          <textarea
            ref={ref}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData.files;
              if (pasted?.length) {
                e.preventDefault();
                void addFiles(pasted);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (e.nativeEvent.isComposing) return;
                e.preventDefault();
                submit();
              }
            }}
            aria-label="消息输入框"
            placeholder="问库存、订单、售后问题，或添加附件…"
            className="max-h-[180px] w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-7 text-ink outline-none placeholder:text-faint"
          />

          <div className="flex items-center justify-between px-2.5 pb-2 pt-0.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => inputRef.current?.click()}
                className="icon-btn h-7 w-7"
                title="添加附件（文本 / CSV / JSON / 代码）"
                aria-label="添加附件"
              >
                <IconPaperclip size={15} />
              </button>
              {dragging && <span className="text-[11px] text-faint">松开以添加</span>}
              {!knowledge && <span className="text-[11px] text-faint">未启用知识库</span>}
            </div>

            {busy ? (
              <button
                onClick={onStop}
                className="grid h-8 w-8 place-items-center rounded-full bg-ink text-white transition hover:bg-black"
                aria-label="停止生成"
                title="停止生成"
              >
                <IconStop size={14} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                className="grid h-8 w-8 place-items-center rounded-full bg-ink text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-surface disabled:text-faint"
                aria-label="发送"
                title="发送（Enter）"
              >
                <IconSend size={15} />
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[10.5px] text-faint">
          Enter 发送 · Shift + Enter 换行 · 附件支持文本 / CSV / JSON / 代码（≤8MB，最多 {MAX_FILES} 个）
        </p>
      </div>
    </div>
  );
}

export function ChatPanel({
  messages,
  busy,
  knowledge,
  onSend,
  onStop,
  onRetry,
  onHandoff,
  onScrollState,
}: {
  messages: ChatMessage[];
  busy: boolean;
  knowledge: boolean;
  onSend: (text: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  onRetry: () => void;
  onHandoff: () => void;
  /** 滚动后通知外部收起顶栏（移动端节省高度） */
  onScrollState?: (compact: boolean) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const handleScroll = () => {
    if (!onScrollState || rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      onScrollState((listRef.current?.scrollTop ?? 0) > 24);
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 切换到空会话时顶栏恢复常规高度
  useEffect(() => {
    if (!messages.length) onScrollState?.(false);
  }, [messages.length, onScrollState]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const last = messages[messages.length - 1];
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (!nearBottom && last?.role !== 'user') return;
    const streaming = messages.some((m) => m.streaming);
    endRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth', block: 'end' });
  }, [messages]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={listRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="h-full">
            <EmptyState onPick={onSend} />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] space-y-8 px-4 py-6 sm:px-6">
            {messages.map((m) => (
              <MessageItem key={m.id} msg={m} onRetry={onRetry} onHandoff={onHandoff} />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <Composer busy={busy} knowledge={knowledge} onSend={onSend} onStop={onStop} />
    </section>
  );
}
