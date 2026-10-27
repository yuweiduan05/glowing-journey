import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { SettingsSheet } from './components/SettingsSheet';
import { CONVERSATIONS, type ConversationMeta } from './lib/demo';
import type { ChatMessage } from './lib/types';
import {
  fetchHealth,
  sendChat,
  type Chain,
  type Citation,
  type HealthPayload,
  type WireMessage,
} from './lib/gateway';
import { clearState, loadState, saveState, type PersistedState } from './lib/storage';
import { buildWireContent, toMeta, type Attachment, type AttachmentMeta } from './lib/attachments';

let seq = 0;
const nextId = () => `m-${Date.now()}-${seq++}`;

export default function App() {
  // 只读一次本地快照，后续状态由 React 管；刷新/重开浏览器时恢复
  const [restored] = useState<PersistedState | null>(() => loadState());

  const [convos, setConvos] = useState<ConversationMeta[]>(restored?.convos ?? CONVERSATIONS);
  const [activeId, setActiveId] = useState(restored?.activeId ?? 'c-demo');
  const [store, setStore] = useState<Record<string, ChatMessage[]>>(restored?.store ?? {});
  const [busy, setBusy] = useState(false);

  const [chain, setChain] = useState<Chain>(restored?.settings.chain ?? 'proxy');
  const [stream, setStream] = useState(restored?.settings.stream ?? true);
  const [knowledge, setKnowledge] = useState(restored?.settings.knowledge ?? true);
  const [chaos, setChaos] = useState(restored?.settings.chaos ?? false);

  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [model, setModel] = useState('');

  // 桌面端默认展开侧栏；移动端默认收起
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 滚动后顶栏收成紧凑态（移动端省出内容高度）
  const [compactHeader, setCompactHeader] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const snapshotRef = useRef<Omit<PersistedState, 'version' | 'savedAt'>>({
    convos,
    activeId,
    store,
    settings: { chain, stream, knowledge, chaos },
  });

  snapshotRef.current = {
    convos,
    activeId,
    store,
    settings: { chain, stream, knowledge, chaos },
  };

  // 防抖落盘：流式期间 token 高频更新，不能每次都序列化
  useEffect(() => {
    const timer = setTimeout(() => saveState(snapshotRef.current), 500);
    return () => clearTimeout(timer);
  }, [convos, store, activeId, chain, stream, knowledge, chaos]);

  // 关闭/切后台时补一次，避免丢掉最后 500ms 的改动
  useEffect(() => {
    const flush = () => saveState(snapshotRef.current);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const messages = store[activeId] ?? [];
  const activeConvo = convos.find((c) => c.id === activeId);

  // 健康轮询
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await fetchHealth();
        if (alive) setHealth(h);
      } catch {
        if (alive) setHealth(null);
      }
    };
    void tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Esc 关闭浮层（从最上层开始）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (settingsOpen) setSettingsOpen(false);
      else if (sidebarOpen && window.innerWidth < 1024) setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, sidebarOpen]);

  const patch = useCallback(
    (id: string, updater: (m: ChatMessage) => ChatMessage) => {
      setStore((prev) => {
        const list = prev[activeId] ?? [];
        return { ...prev, [activeId]: list.map((m) => (m.id === id ? updater(m) : m)) };
      });
    },
    [activeId],
  );

  const runTurn = useCallback(
    async (
      text: string,
      history: WireMessage[],
      options?: { appendUser?: boolean; wireContent?: string; attachments?: AttachmentMeta[] },
    ) => {
      const cid = activeId;
      // 重试时复用已有的用户气泡，避免再追加一条
      const appendUser = options?.appendUser !== false;
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        content: text,
        attachments: options?.attachments,
        wireContent: options?.wireContent,
        timeline: [],
        citations: [],
        createdAt: Date.now(),
      };
      const botId = nextId();
      const botMsg: ChatMessage = {
        id: botId,
        role: 'assistant',
        content: '',
        timeline: [],
        citations: [],
        streaming: true,
        createdAt: Date.now(),
      };

      setStore((prev) => ({
        ...prev,
        [cid]: appendUser ? [...(prev[cid] ?? []), userMsg, botMsg] : [...(prev[cid] ?? []), botMsg],
      }));
      setBusy(true);

      // 首条用户消息用作会话标题，避免侧栏永远显示「新会话」
      if (appendUser) {
        setConvos((prev) =>
          prev.map((c) =>
            c.id === cid && (c.title === '新会话' || !c.title)
              ? {
                  ...c,
                  title: text.replace(/\s+/g, ' ').slice(0, 22),
                  preview: text.replace(/\s+/g, ' ').slice(0, 40),
                  ts: '刚刚',
                }
              : c,
          ),
        );
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const started = performance.now();

      try {
        await sendChat({
          // 发出去的是「问题 + 附件正文」，气泡里仍只显示问题
          messages: [...history, { role: 'user', content: options?.wireContent ?? text }],
          chain,
          stream,
          enableKnowledge: knowledge,
          chaos: chaos ? '500' : undefined,
          signal: controller.signal,
          conversationId: cid,
          handlers: {
            onMeta: (meta) => {
              setModel(meta.model);
              patch(botId, (m) => ({
                ...m,
                stats: { ...m.stats, requestId: meta.request_id, model: meta.model, chain: meta.chain },
              }));
            },
            onThought: (t) => patch(botId, (m) => ({ ...m, timeline: [...m.timeline, t] })),
            onReasoning: (delta) => patch(botId, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + delta })),
            onToolCall: (t) => patch(botId, (m) => ({ ...m, timeline: [...m.timeline, t] })),
            onToolResult: (callId, p) =>
              patch(botId, (m) => ({
                ...m,
                timeline: m.timeline.map((item) =>
                  item.kind === 'tool' && item.callId === callId ? { ...item, ...p } : item,
                ),
              })),
            onToken: (delta) =>
              patch(botId, (m) => ({
                ...m,
                content: m.content + delta,
                // 首 token 到达 = 思考结束：记下耗时，界面随即折叠思考块
                reasoningMs: m.reasoningMs ?? (m.reasoning ? Math.round(performance.now() - started) : undefined),
              })),
            onCitation: (sources: Citation[]) =>
              patch(botId, (m) => ({ ...m, citations: sources, boundary: m.boundary ?? 'in_kb' })),
            onHandoff: (reason) => patch(botId, (m) => ({ ...m, handoff: reason })),
            // 边界来自事件字段，不解析文案
            onBoundary: (b) => patch(botId, (m) => ({ ...m, boundary: b })),
            onDone: (info) =>
              patch(botId, (m) => ({
                ...m,
                streaming: false,
                reasoningMs:
                  m.reasoningMs ??
                  (m.reasoning ? Math.round(performance.now() - started) : undefined),
                // 非流式没有服务端 total_ms，用客户端实测补上
                stats: { ...m.stats, totalMs: info.total_ms || Math.round(performance.now() - started) },
              })),
            onError: (err) => patch(botId, (m) => ({ ...m, streaming: false, error: `${err.code}：${err.message}` })),
          },
        });
      } catch (err) {
        const aborted = (err as Error).name === 'AbortError';
        patch(botId, (m) => ({
          ...m,
          streaming: false,
          cancelled: aborted,
          error: aborted ? undefined : (err as Error).message,
          reasoningMs:
            m.reasoningMs ?? (m.reasoning ? Math.round(performance.now() - started) : undefined),
        }));
      } finally {
        patch(botId, (m) => ({ ...m, streaming: false }));
        setBusy(false);
        abortRef.current = null;
      }
    },
    [activeId, chain, chaos, knowledge, patch, stream],
  );

  /**
   * 组装发给模型的历史。
   * 附件正文只展开最近两次带附件的提问：更早的折叠成文件名，
   * 否则每轮都把历史文件重发一遍，请求体很快超过上限。
   */
  const buildHistory = useCallback(
    (list: ChatMessage[]): WireMessage[] => {
      const usable = list.filter((m) => m.content && !m.error);
      const expanded = new Set(
        usable
          .filter((m) => m.role === 'user' && m.wireContent)
          .slice(-2)
          .map((m) => m.id),
      );
      return usable.map((m) => {
        if (m.wireContent && expanded.has(m.id)) return { role: m.role, content: m.wireContent };
        if (m.attachments?.length) {
          return {
            role: m.role,
            content: `【历史附件：${m.attachments.map((a) => a.name).join('、')}，正文已省略】${m.content}`,
          };
        }
        return { role: m.role, content: m.wireContent ?? m.content };
      });
    },
    [],
  );

  const handleSend = (text: string, attachments: Attachment[] = []) => {
    if (busy) return;

    // 只发附件、不写字时，补一句默认诉求，避免气泡空白（与 buildWireContent 保持一致）
    const display = text.trim() || (attachments.length ? '请阅读附件并总结要点。' : '');
    if (!display) return;

    void runTurn(display, buildHistory(messages), {
      wireContent: buildWireContent(display, attachments),
      attachments: attachments.length ? toMeta(attachments) : undefined,
    });
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const handleRetry = () => {
    if (busy) return;
    const list = messages.filter((m) => !m.error);
    const lastUser = [...list].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    // 只移除末尾失败的助手气泡，保留原用户气泡；请求时复用该气泡
    setStore((prev) => {
      const cur = prev[activeId] ?? [];
      const trimmed = cur.length && cur[cur.length - 1]?.role === 'assistant' ? cur.slice(0, -1) : cur;
      return { ...prev, [activeId]: trimmed };
    });

    void runTurn(lastUser.content, buildHistory(list.filter((m) => m.id !== lastUser.id)), {
      appendUser: false,
      wireContent: lastUser.wireContent,
      attachments: lastUser.attachments,
    });
  };

  const handleNew = () => {
    const id = `c-${Date.now()}`;
    setConvos((prev) => [{ id, title: '新会话', preview: '空会话', ts: '刚刚' }, ...prev]);
    setStore((prev) => ({ ...prev, [id]: [] }));
    setActiveId(id);
    setSidebarOpen(window.innerWidth >= 1024);
  };

  const handleDelete = (id: string) => {
    const rest = convos.filter((c) => c.id !== id);

    if (id === activeId) {
      if (rest.length) {
        setActiveId(rest[0]!.id);
      } else {
        const fresh = `c-${Date.now()}`;
        setConvos([{ id: fresh, title: '新会话', preview: '空会话', ts: '刚刚' }]);
        setStore((prev) => ({ ...prev, [fresh]: [] }));
        setActiveId(fresh);
      }
    }
    if (rest.length) setConvos(rest);

    setStore((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleClearData = () => {
    clearState();
    const fresh = `c-${Date.now()}`;
    setConvos([{ id: fresh, title: '新会话', preview: '空会话', ts: '刚刚' }, ...CONVERSATIONS]);
    setStore({ [fresh]: [] });
    setActiveId(fresh);
    setCompactHeader(false);
  };

  return (
    <div className="flex h-full overflow-hidden bg-canvas">
      <Sidebar
        open={sidebarOpen}
        activeId={activeId}
        conversations={convos}
        onSelect={(id) => {
          setActiveId(id);
          if (window.innerWidth < 1024) setSidebarOpen(false);
        }}
        onNew={handleNew}
        onDelete={handleDelete}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          title={activeConvo?.title ?? '业务智能体'}
          health={health}
          model={model}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onOpenSettings={() => setSettingsOpen(true)}
          compact={compactHeader}
        />

        <ChatPanel
          messages={messages}
          busy={busy}
          knowledge={knowledge}
          onSend={handleSend}
          onStop={() => abortRef.current?.abort()}
          onRetry={handleRetry}
          onHandoff={() => handleSend('请帮我建一个工单，转人工跟进这个问题')}
          onScrollState={setCompactHeader}
        />
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        chain={chain}
        onChain={setChain}
        stream={stream}
        onStream={setStream}
        knowledge={knowledge}
        onKnowledge={setKnowledge}
        chaos={chaos}
        onChaos={setChaos}
        health={health}
        model={model}
        conversationCount={convos.length}
        messageCount={Object.values(store).reduce((sum, list) => sum + list.length, 0)}
        onClearData={handleClearData}
      />
    </div>
  );
}
