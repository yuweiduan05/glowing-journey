import type { Boundary } from '@app/shared';
import type { AttachmentMeta } from './attachments';
import type { Chain, Citation, TimelineItem } from './gateway';

/** 一条对话消息：用户 / 助手共用，助手额外带思考、轨迹、引用与边界 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户消息附带的文件（只存元信息，正文在 wireContent 里） */
  attachments?: AttachmentMeta[];
  /** 真正发给模型的内容：正文 + 附件原文；为空表示与 content 相同 */
  wireContent?: string;
  /** 模型思考原文（reasoning 事件累积）；仅在展开「已思考」时展示 */
  reasoning?: string;
  /** 思考耗时（毫秒）：从请求发出到正文首 token 到达 */
  reasoningMs?: number;
  timeline: TimelineItem[];
  citations: Citation[];
  boundary?: Boundary;
  handoff?: string;
  error?: string;
  streaming?: boolean;
  cancelled?: boolean;
  stats?: { requestId?: string; totalMs?: number; model?: string; chain?: Chain };
  createdAt: number;
}
