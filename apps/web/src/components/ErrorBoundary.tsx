import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界：单个组件抛错（如引用面板拿到缺字段的数据）不再整页白屏，
 * 而是降级为可恢复的错误卡片——答辩现场比白屏安全一个量级。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 text-center">
            <p className="text-sm font-medium text-amber-200">界面出现异常，但服务仍在运行</p>
            <p className="mt-2 break-all text-[11px] text-muted">{this.state.error.message}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded-lg bg-amber-500/20 px-4 py-1.5 text-xs text-amber-200 transition hover:bg-amber-500/30"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
