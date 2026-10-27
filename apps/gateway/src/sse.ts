/**
 * SSE 写出器（对应 2.5「透传实现要点」）
 *
 * 四件事必须做对：
 * 1. 关闭压缩与缓冲（Content-Encoding: identity + X-Accel-Buffering: no）；
 * 2. 每 15s 发 `: ping` 心跳，避免中间层掐连接；
 * 3. 客户端中断时把 abort 传回上游，避免连接泄漏；
 * 4. done / error 之后立即关闭流，否则前端 loading 卡死。
 */
import type { ServerResponse } from 'node:http';
import {
  SSE_HEADERS,
  serializePing,
  serializeSse,
  type SseEventName,
  type SsePayloadMap,
} from '@app/shared';

export class SseWriter {
  private closed = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly raw: ServerResponse,
    private readonly heartbeatMs = 15_000,
  ) {
    raw.writeHead(200, SSE_HEADERS);
    raw.flushHeaders?.();

    raw.on('close', () => {
      this.closed = true;
      this.stopHeartbeat();
      // 客户端中断 → 通知上游 abort
      if (!this.abort.signal.aborted) this.abort.abort(new Error('client disconnected'));
    });

    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<K extends SseEventName>(event: K, data: SsePayloadMap[K]): void {
    if (this.closed) return;
    this.raw.write(serializeSse(event, data));
  }

  ping(): void {
    if (this.closed) return;
    this.raw.write(serializePing());
  }

  /** 结束流：先清心跳再 end，保证 done 之后连接立即关闭 */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.raw.end();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
