import type { HealthPayload } from '../lib/gateway';
import { IconMenu, IconPanel, IconSettings } from './icons';

const DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
};

const STATUS_TEXT: Record<string, string> = {
  ok: '服务正常',
  degraded: '部分降级',
  down: '连接异常',
};

/**
 * 顶栏只承担三件事：开合侧栏、显示当前会话、进设置。
 * 模型名、耗时、链路、request_id 全部下沉到消息底部与设置抽屉——
 * 顶栏挂 5 个状态 chip 是上一版「看起来复杂」的主要原因。
 */
export function Header({
  title,
  health,
  model,
  sidebarOpen,
  onToggleSidebar,
  onOpenSettings,
  compact = false,
}: {
  title: string;
  health: HealthPayload | null;
  model: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  compact?: boolean;
}) {
  const status = health?.status ?? 'down';

  return (
    <header
      className={`flex shrink-0 items-center gap-1 px-2 transition-[height] duration-200 sm:px-3 ${
        compact ? 'h-11' : 'h-[52px]'
      }`}
    >
      <button
        className="icon-btn"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? '收起会话列表' : '展开会话列表'}
        title={sidebarOpen ? '收起会话列表' : '展开会话列表'}
      >
        <span className="lg:hidden">
          <IconMenu size={18} />
        </span>
        <span className="hidden lg:block">
          <IconPanel size={17} />
        </span>
      </button>

      <h1
        className={`min-w-0 flex-1 truncate px-1 font-medium text-ink transition-all ${
          compact ? 'text-[12.5px]' : 'text-[13.5px]'
        }`}
      >
        {title || '新会话'}
      </h1>

      {model && (
        <span
          className="hidden max-w-[160px] truncate px-1 font-mono text-[10.5px] text-faint sm:inline"
          title={`当前模型：${model}`}
        >
          {model}
        </span>
      )}

      <button
        onClick={onOpenSettings}
        className="icon-btn"
        title={
          health
            ? `${STATUS_TEXT[status] ?? status}｜${Object.entries(health.checks)
                .map(([k, v]) => `${k}: ${v.status}`)
                .join(' · ')}`
            : '未连接'
        }
        aria-label="服务状态与设置"
      >
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[status] ?? 'bg-faint'}`} />
        </span>
      </button>

      <button className="icon-btn" onClick={onOpenSettings} aria-label="设置" title="设置">
        <IconSettings size={17} />
      </button>
    </header>
  );
}
