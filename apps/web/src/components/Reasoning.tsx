import { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../lib/gateway';
import { IconChevron, IconSpark } from './icons';

const TOOL_CN: Record<string, string> = {
  query_inventory: '查询库存',
  query_order: '查询订单',
  create_ticket: '创建工单',
  search_knowledge: '检索知识库',
};

function duration(ms: number): string {
  // 「已思考 629 毫秒」读起来像仪表盘，按人类习惯给一个粗粒度时间
  if (ms < 1000) return '不到 1 秒';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.round(ms / 1000)} 秒`;
}

function StepRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const failed = item.status === 'error';
  const running = item.status === 'running';

  return (
    <div className="text-[12px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition hover:bg-white"
        aria-expanded={open}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            failed ? 'bg-rose-500' : running ? 'animate-pulse-soft bg-amber-400' : 'bg-emerald-500'
          }`}
        />
        <span className="text-ink">{TOOL_CN[item.name] ?? item.name}</span>
        <span className="truncate font-mono text-[10.5px] text-faint">{item.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">
          {failed ? '失败' : running ? '执行中' : `${item.latencyMs ?? 0}ms`}
        </span>
        <IconChevron size={11} className={`shrink-0 text-faint transition ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="ml-3 mt-1 space-y-1 border-l border-line pl-2.5">
          <p className="text-[10.5px] uppercase tracking-wide text-faint">入参</p>
          <pre className="overflow-x-auto rounded-md bg-white p-2 font-mono text-[10.5px] leading-relaxed text-muted">
            {JSON.stringify(item.args ?? {}, null, 2)}
          </pre>
          {item.data !== undefined && (
            <>
              <p className="text-[10.5px] uppercase tracking-wide text-faint">返回</p>
              <pre className="max-h-40 overflow-auto rounded-md bg-white p-2 font-mono text-[10.5px] leading-relaxed text-muted">
                {JSON.stringify(item.data, null, 2)}
              </pre>
            </>
          )}
          {item.error && <p className="text-[11px] text-rose-600">{item.error.message}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * 思考块：流式期间是灰字实时滚动，正文一开始输出就自动折叠成一行。
 *
 * 为什么不用「边想边折叠」的开关：真实模型的 reasoning 往往持续十几秒，
 * 这期间用户唯一能看的就是这些灰字；一旦正文开始，它就不再是主角，
 * 必须让位给答案，只留一行「已思考 X 秒」作为可回溯的入口。
 */
export function Reasoning({
  reasoning,
  reasoningMs,
  timeline,
  streaming,
  hasContent,
}: {
  reasoning?: string;
  reasoningMs?: number;
  timeline: TimelineItem[];
  streaming: boolean;
  hasContent: boolean;
}) {
  const steps = timeline.filter((t): t is Extract<TimelineItem, { kind: 'tool' }> => t.kind === 'tool');
  const [open, setOpen] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  const thinking = streaming && !hasContent && Boolean(reasoning || steps.length);
  const hasAnything = Boolean(reasoning) || steps.length > 0;

  // 思考文本持续增长时把视口钉在底部（与正文自动滚动同理）
  useEffect(() => {
    if (!thinking) return;
    const el = liveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning, thinking]);

  if (!hasAnything) return null;

  if (thinking) {
    return (
      <div className="mb-4" aria-live="polite">
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-ink/40" />
          正在思考
        </div>
        {reasoning && (
          <div
            ref={liveRef}
            className="think-mask mt-2 max-h-[196px] overflow-y-auto whitespace-pre-wrap pr-2 text-[13px] leading-[1.9] text-[#8b8b93]"
          >
            {reasoning}
          </div>
        )}
      </div>
    );
  }

  const label = reasoningMs
    ? `已思考 ${duration(reasoningMs)}`
    : steps.length
      ? `已完成 ${steps.length} 个步骤`
      : '思考过程';

  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group inline-flex items-center gap-1.5 rounded-md py-0.5 text-[12px] text-muted transition hover:text-ink"
      >
        <IconSpark size={12} className="text-faint" />
        <span>{label}</span>
        {steps.length > 0 && <span className="text-faint">· {steps.length} 个步骤</span>}
        <IconChevron size={11} className={`text-faint transition ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 space-y-3 rounded-xl bg-subtle p-3">
          {reasoning && (
            <p className="whitespace-pre-wrap text-[12.5px] leading-[1.9] text-muted">{reasoning}</p>
          )}
          {steps.length > 0 && (
            <div className="space-y-0.5 border-t border-line pt-2">
              {steps.map((item) => (
                <StepRow key={item.callId} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
