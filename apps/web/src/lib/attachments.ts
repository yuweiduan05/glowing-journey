/**
 * 附件（文本类）
 *
 * 取舍：不引入 PDF/Office 解析库（体积大、纯前端解析质量不稳定），
 * 只支持「可以直接读成文本」的文件：txt/md/csv/json/日志/代码。
 * 这类文件恰好是业务场景里最常被拿来问的（库存表、订单导出、配置）。
 *
 * 附件内容会拼进**发给模型的那条消息**，而不是只展示在前端——
 * 否则模型看不到附件，回答会变成"我无法读取附件"。
 * 气泡里仍显示用户原本输入的问题，两者分开存（content / wireContent）。
 */

export interface Attachment {
  id: string;
  name: string;
  size: number;
  /** 字符数（截断后） */
  chars: number;
  /** 是否因为超长被截断 */
  truncated: boolean;
  text: string;
}

/** 展示与持久化只留元信息，正文已经在 wireContent 里，不重复存 */
export type AttachmentMeta = Pick<Attachment, 'id' | 'name' | 'size' | 'truncated'>;

export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CHARS_PER_FILE = 20_000;

const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log',
  'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx',
  'py', 'java', 'go', 'rs', 'sql', 'sh', 'ini', 'conf', 'env',
];

const TEXT_EXT = new RegExp(`\\.(${TEXT_EXTS.join('|')})$`, 'i');

export const ACCEPT_ATTR = TEXT_EXTS.map((ext) => `.${ext}`).join(',');

export function isTextFile(file: File): boolean {
  if (TEXT_EXT.test(file.name)) return true;
  return file.type.startsWith('text/') || file.type === 'application/json';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type ReadResult = { ok: true; attachment: Attachment } | { ok: false; error: string };

export async function readAttachment(file: File): Promise<ReadResult> {
  if (!isTextFile(file)) {
    return {
      ok: false,
      error: `「${file.name}」暂不支持解析，目前可添加文本、CSV、JSON、日志或代码文件`,
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `「${file.name}」超过 8MB，请拆分后再试` };
  }

  const raw = await file.text();
  if (!raw.trim()) {
    return { ok: false, error: `「${file.name}」是空文件` };
  }

  const truncated = raw.length > MAX_CHARS_PER_FILE;
  const text = truncated ? raw.slice(0, MAX_CHARS_PER_FILE) : raw;

  return {
    ok: true,
    attachment: {
      id: newId(),
      name: file.name,
      size: file.size,
      chars: text.length,
      truncated,
      text,
    },
  };
}

/**
 * 把附件拼进发给模型的消息。
 * 用围栏代码块包裹，避免 CSV 的竖线/代码的缩进被 Markdown 吃掉了；
 * 文件内容本身含 ``` 时升到四反引号，防止提前闭合。
 */
export function buildWireContent(text: string, attachments: Attachment[]): string {
  const ask = text.trim() || '请阅读附件并总结要点。';
  if (!attachments.length) return ask;

  const blocks = attachments.map((a) => {
    const fence = a.text.includes('```') ? '````' : '```';
    const note = a.truncated
      ? `，内容较长，已截断至前 ${MAX_CHARS_PER_FILE.toLocaleString('zh-CN')} 字符`
      : '';
    return `【附件：${a.name}（${formatBytes(a.size)}${note}）】\n${fence}\n${a.text}\n${fence}`;
  });

  return `${ask}\n\n${blocks.join('\n\n')}`;
}

export function toMeta(list: Attachment[]): AttachmentMeta[] {
  return list.map(({ id, name, size, truncated }) => ({ id, name, size, truncated }));
}
