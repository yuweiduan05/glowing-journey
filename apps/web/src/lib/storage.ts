/**
 * 会话本地持久化（localStorage）
 *
 * 设计目标：
 * 1. 刷新/重开浏览器不丢会话与消息（纯前端态，不引入后端会话表）；
 * 2. 有版本号，结构不兼容时直接忽略而不是崩掉；
 * 3. 有容量上限：localStorage 通常 5MB，超出会抛 QuotaExceededError，必须主动裁剪；
 * 4. 流式中的半截消息不落盘，避免刷新后停在「生成到一半」的状态。
 */
import type { Chain } from './gateway';
import type { ChatMessage } from './types';
import type { ConversationMeta } from './demo';

const KEY = 'zhilian-agent-web-state';
const VERSION = 1;
const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES_PER_CONVERSATION = 80;
const MAX_BYTES = 3_500_000; // 留出余量给浏览器其它数据

export interface PersistedSettings {
  chain: Chain;
  stream: boolean;
  knowledge: boolean;
  chaos: boolean;
}

export interface PersistedState {
  version: number;
  savedAt: number;
  convos: ConversationMeta[];
  activeId: string;
  store: Record<string, ChatMessage[]>;
  settings: PersistedSettings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!isObject(raw)) return null;
  if (raw.role !== 'user' && raw.role !== 'assistant') return null;
  if (typeof raw.id !== 'string' || typeof raw.content !== 'string') return null;
  return {
    id: raw.id,
    role: raw.role,
    content: raw.content,
    attachments: Array.isArray(raw.attachments)
      ? (raw.attachments as ChatMessage['attachments'])
      : undefined,
    wireContent: typeof raw.wireContent === 'string' ? raw.wireContent : undefined,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : undefined,
    reasoningMs: typeof raw.reasoningMs === 'number' ? raw.reasoningMs : undefined,
    timeline: Array.isArray(raw.timeline) ? (raw.timeline as ChatMessage['timeline']) : [],
    citations: Array.isArray(raw.citations) ? (raw.citations as ChatMessage['citations']) : [],
    boundary: raw.boundary as ChatMessage['boundary'],
    handoff: typeof raw.handoff === 'string' ? raw.handoff : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    cancelled: raw.cancelled === true,
    streaming: false,
    stats: isObject(raw.stats) ? (raw.stats as ChatMessage['stats']) : undefined,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
  };
}

function sanitizeConvo(raw: unknown): ConversationMeta | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  return {
    id: raw.id,
    title: raw.title,
    preview: typeof raw.preview === 'string' ? raw.preview : '',
    ts: typeof raw.ts === 'string' ? raw.ts : '更早',
  };
}

/**
 * 丢弃仍在流式中的回答（不论是否已有半截内容）：
 * 半截答案落盘后会被当成完整回答展示，比"这条没答完"更容易误导。
 * 用户刷新后看到自己的提问仍在，可重新发送。
 */
function stripInFlight(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !(m.role === 'assistant' && m.streaming));
}

function trim(state: PersistedState): PersistedState {
  const convos = state.convos.slice(0, MAX_CONVERSATIONS);
  const allowed = new Set(convos.map((c) => c.id));
  const store: Record<string, ChatMessage[]> = {};
  for (const [id, list] of Object.entries(state.store)) {
    if (!allowed.has(id)) continue;
    store[id] = stripInFlight(list).slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  return {
    ...state,
    convos,
    store,
    activeId: allowed.has(state.activeId) ? state.activeId : (convos[0]?.id ?? state.activeId),
  };
}

export function loadState(): PersistedState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || parsed.version !== VERSION) return null;
    if (!Array.isArray(parsed.convos) || !isObject(parsed.store)) return null;

    const convos = parsed.convos.map(sanitizeConvo).filter((c): c is ConversationMeta => Boolean(c));
    if (!convos.length) return null;

    const store: Record<string, ChatMessage[]> = {};
    for (const convo of convos) {
      const list = parsed.store[convo.id];
      if (!Array.isArray(list)) continue;
      store[convo.id] = list
        .map(sanitizeMessage)
        .filter((m): m is ChatMessage => Boolean(m))
        .slice(-MAX_MESSAGES_PER_CONVERSATION);
    }

    const settings = isObject(parsed.settings) ? parsed.settings : {};
    return {
      version: VERSION,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : Date.now(),
      convos,
      activeId:
        typeof parsed.activeId === 'string' && convos.some((c) => c.id === parsed.activeId)
          ? parsed.activeId
          : convos[0]!.id,
      store,
      settings: {
        chain: settings.chain === 'direct' ? 'direct' : 'proxy',
        stream: settings.stream !== false,
        knowledge: settings.knowledge !== false,
        chaos: settings.chaos === true,
      },
    };
  } catch {
    return null;
  }
}

export function saveState(state: Omit<PersistedState, 'version' | 'savedAt'>): void {
  if (typeof window === 'undefined') return;
  let next = trim({ ...state, version: VERSION, savedAt: Date.now() });

  const write = (value: PersistedState): boolean => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  if (write(next)) return;

  // 超限：先砍会话数量，再砍工具明细，最后放弃（不影响主流程）
  while (next.convos.length > 1) {
    next = trim({ ...next, convos: next.convos.slice(0, -1) });
    next.store = Object.fromEntries(
      Object.entries(next.store).map(([id, list]) => [
        id,
        list.map((m) => ({
          ...m,
          // 超限时先丢附件正文（气泡与文件名仍在），最后才丢会话
          wireContent: undefined,
          timeline: m.timeline.map((t) =>
            t.kind === 'tool' ? { ...t, data: undefined, args: {} } : t,
          ),
        })),
      ]),
    );
    if (write(next)) return;
  }

  console.warn('[storage] 本地存储已满，本次会话未保存');
}

export function clearState(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}

export function estimateSize(state: Omit<PersistedState, 'version' | 'savedAt'>): number {
  try {
    return JSON.stringify({ ...state, version: VERSION, savedAt: 0 }).length;
  } catch {
    return 0;
  }
}

export const STORAGE_LIMIT_BYTES = MAX_BYTES;
