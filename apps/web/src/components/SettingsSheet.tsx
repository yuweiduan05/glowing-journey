import { useEffect, useState } from 'react';
import type { Chain, HealthPayload } from '../lib/gateway';
import { IconChevron, IconTrash, IconX } from './icons';

const DOT: Record<string, string> = {
  ok: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  down: 'bg-rose-500',
};

const CHECK_LABEL: Record<string, string> = {
  'business-api': '业务服务',
  'rag-service': '知识库',
  'model-provider': '模型供应商',
};

function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-[13px] text-ink">{title}</p>
        {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{desc}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition ${checked ? 'bg-accent' : 'bg-line'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
          checked ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

export function SettingsSheet({
  open,
  onClose,
  chain,
  onChain,
  stream,
  onStream,
  knowledge,
  onKnowledge,
  chaos,
  onChaos,
  health,
  model,
  conversationCount,
  messageCount,
  onClearData,
}: {
  open: boolean;
  onClose: () => void;
  chain: Chain;
  onChain: (c: Chain) => void;
  stream: boolean;
  onStream: (v: boolean) => void;
  knowledge: boolean;
  onKnowledge: (v: boolean) => void;
  chaos: boolean;
  onChaos: (v: boolean) => void;
  health: HealthPayload | null;
  model: string;
  conversationCount: number;
  messageCount: number;
  onClearData: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // 演示与诊断默认折叠：普通用户只看对话体验，答辩时展开演示容灾
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 每次打开都重置二次确认，避免误触
  useEffect(() => {
    if (open) setConfirming(false);
  }, [open]);

  if (!open) return null;

  const checks = health?.checks ?? {};

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden="true" />
      <aside className="absolute inset-y-0 right-0 flex w-[min(380px,94vw)] animate-slide-in flex-col border-l border-line bg-white/85 backdrop-blur-xl shadow-sheet">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-[14px] font-semibold text-ink">设置与诊断</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭设置">
            <IconX size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <p className="pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-faint">对话体验</p>
          <div className="divide-y divide-line">
            <Row title="流式响应" desc="关闭后一次性返回整段回答（仍保留工具轨迹与引用）">
              <Switch checked={stream} onChange={onStream} label="流式响应" />
            </Row>
            <Row title="知识库工具" desc="关闭后只使用库存、订单、工单工具，不检索企业知识库">
              <Switch checked={knowledge} onChange={onKnowledge} label="知识库工具" />
            </Row>
          </div>

          {/* 技术性开关收进折叠区：普通用户不关心，答辩/排障时再展开 */}
          <button
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="mt-5 flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-subtle px-2.5 py-2 text-left transition hover:bg-surface"
          >
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <IconChevron size={11} className={`text-faint transition ${advancedOpen ? 'rotate-90' : ''}`} />
              演示与诊断
            </span>
            <span className="truncate text-[10.5px] text-faint">容灾 · 故障注入 · 运行状态</span>
          </button>

          {advancedOpen && (
            <div className="animate-fade-in">
              <p className="pb-1 pt-5 text-[10px] font-medium uppercase tracking-wider text-faint">
                请求链路与容灾
              </p>
              <div className="divide-y divide-line">
                <Row title="请求链路" desc={chain === 'proxy' ? '429/5xx 重试、备用供应商与熔断' : '单次调用，不重试不降级'}>
                  <div className="flex overflow-hidden rounded-lg border border-line">
                    {(['direct', 'proxy'] as Chain[]).map((c) => (
                      <button
                        key={c}
                        onClick={() => onChain(c)}
                        aria-pressed={chain === c}
                        className={`px-2.5 py-1 text-[11px] transition ${
                          chain === c ? 'bg-ink text-white' : 'text-muted hover:text-ink'
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row title="故障注入" desc="演示用：对业务服务注入 500，验证失败提示与重试">
                  <Switch checked={chaos} onChange={onChaos} label="故障注入" />
                </Row>
              </div>

              <p className="pb-1 pt-5 text-[10px] font-medium uppercase tracking-wider text-faint">运行状态</p>
              <ul className="space-y-1.5">
                {Object.entries(checks).map(([key, value]) => (
                  <li
                    key={key}
                    className="flex items-center justify-between rounded-lg border border-line bg-subtle px-2.5 py-2"
                  >
                    <span className="flex items-center gap-2 text-[12px] text-muted">
                      <span className={`h-1.5 w-1.5 rounded-full ${DOT[value.status] ?? 'bg-faint'}`} />
                      {CHECK_LABEL[key] ?? key}
                    </span>
                    <span className="font-mono text-[10px] text-faint">
                      {value.status}
                      {value.latency_ms !== undefined ? ` · ${value.latency_ms}ms` : ''}
                    </span>
                  </li>
                ))}
                {!Object.keys(checks).length && (
                  <li className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[11px] text-faint">
                    未获取到健康状态
                  </li>
                )}
              </ul>

              <p className="mt-2 text-[10px] leading-relaxed text-faint">
                这些开关用于课程演示与排障，日常对话不需要调整。
              </p>
            </div>
          )}

          <p className="pb-1 pt-5 text-[10px] font-medium uppercase tracking-wider text-faint">本地数据</p>
          <div className="rounded-lg border border-line bg-subtle px-2.5 py-2.5">
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-muted">会话已自动保存到本机</span>
              <span className="font-mono text-[10px] text-faint">
                {conversationCount} 个 · {messageCount} 条
              </span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              仅存于当前浏览器，不会上传；换浏览器或清缓存后不可恢复。
            </p>
            <button
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                onClearData();
                setConfirming(false);
              }}
              className={`mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition ${
                confirming
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-line text-muted hover:border-ink/20 hover:text-ink'
              }`}
            >
              <IconTrash size={12} />
              {confirming ? '再次点击确认清空' : '清空本地会话记录'}
            </button>
          </div>

          <p className="pb-1 pt-5 text-[10px] font-medium uppercase tracking-wider text-faint">关于</p>
          <dl className="space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <dt className="text-faint">产品</dt>
              <dd className="text-muted">知言 · 业务智能体</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">模型</dt>
              <dd className="max-w-[200px] truncate font-mono text-muted">{model || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">客户身份</dt>
              <dd className="font-mono text-muted">C-10087</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-faint">版本</dt>
              <dd className="font-mono text-muted">0.1.0</dd>
            </div>
          </dl>

          <p className="mt-4 rounded-lg border border-line bg-subtle px-2.5 py-2 text-[10px] leading-relaxed text-faint">
            客户身份由网关按凭证注入，模型无法指定他人 customer_id；写操作使用服务端派生的幂等键。
          </p>
        </div>
      </aside>
    </div>
  );
}
