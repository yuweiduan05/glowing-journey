import { IconMenu, IconPanel } from './icons';

/**
 * 顶栏只保留 DeepSeek 式的两件事：侧栏开合 + 当前对话标题。
 * 模型名、服务健康、设置入口全部下沉到侧栏底部身份行 → 设置抽屉，
 * 避免顶栏挂一串状态 chip 把界面压得很重。
 */
export function Header({
  title,
  sidebarOpen,
  onToggleSidebar,
  compact = false,
}: {
  title: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  compact?: boolean;
}) {
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
        {title || '新对话'}
      </h1>
    </header>
  );
}
