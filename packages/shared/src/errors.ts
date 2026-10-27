/**
 * 统一错误码（对应路线规划 2.5「统一错误码表」，P0 契约冻结项）
 *
 * 约定：
 * 1. 错误码在网关统一收口，工具层只抛语义错误（ADR-005）；
 * 2. 非流式响应使用 HTTP 状态码 + { code, message, request_id, details? } 信封；
 * 3. 流式响应一旦开流，HTTP 恒为 200，错误以 SSE `error` 事件下发，
 *    字段级 details 由 `error.details` 携带（补 A4 契约缺口）。
 */

export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'UNAUTHORIZED',
  'FORBIDDEN_DATA_SCOPE',
  'NOT_FOUND',
  'DUPLICATE_TICKET',
  'TOOL_ARGS_INVALID',
  'RATE_LIMITED',
  'UPSTREAM_MODEL_ERROR',
  'RAG_UNAVAILABLE',
  'CIRCUIT_OPEN',
  'TOOL_TIMEOUT',
  'TOOL_UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN_DATA_SCOPE: 403,
  NOT_FOUND: 404,
  DUPLICATE_TICKET: 409,
  TOOL_ARGS_INVALID: 422,
  RATE_LIMITED: 429,
  UPSTREAM_MODEL_ERROR: 502,
  RAG_UNAVAILABLE: 503,
  CIRCUIT_OPEN: 503,
  TOOL_TIMEOUT: 504,
  // A4 补丁：业务服务故障此前无对应码，独立为 502，避免与熔断混淆
  TOOL_UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export interface ErrorDetail {
  /** JSON Pointer 风格字段路径，如 /sku */
  path: string;
  message: string;
  code?: string;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  request_id: string;
  details?: ErrorDetail[];
  retryable: boolean;
}

export interface AppErrorOptions {
  message: string;
  details?: ErrorDetail[];
  retryable?: boolean;
  cause?: unknown;
}

/** 带错误码的语义异常，唯一允许跨模块抛出的错误类型 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetail[];
  readonly retryable: boolean;

  constructor(code: ErrorCode, options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? [429, 502, 503, 504].includes(this.httpStatus);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    const envelope: ErrorEnvelope = {
      code: this.code,
      message: this.message,
      request_id: requestId,
      retryable: this.retryable,
    };
    if (this.details?.length) envelope.details = this.details;
    return envelope;
  }
}

/** 把任意 throw 出来的东西收敛成 AppError（未知异常一律 INTERNAL_ERROR） */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('INTERNAL_ERROR', { message, cause: err });
}
