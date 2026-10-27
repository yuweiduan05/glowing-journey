# SSE 透传 Spike 记录

> P1 任务 1 要求的 spike：先证明「网关能把上游 token 原样、低延迟、不粘包地送到前端」，再谈编排。

## 结论（先看这个）

| 风险 | 结论 | 处理 |
| --- | --- | --- |
| 中间层缓冲导致「一次性蹦出一大段」 | 真实存在 | `Content-Encoding: identity` + `X-Accel-Buffering: no` + nginx `proxy_buffering off` |
| 代理空闲超时掐连接 | 真实存在 | 每 15s 发 `: ping` 注释行 |
| 客户端断开后上游连接泄漏 | 真实存在 | 监听 `res.on('close')` → abort 上游 fetch |
| 一个 TCP 包不等于一个事件 | 真实存在 | 自研增量解析器，按 `\n\n` 分帧 |
| `done` 后不关流导致前端 loading 卡死 | 真实存在 | 写完 `done` 立即 `res.end()` |

## 实测数据

本地（127.0.0.1，无代理）三条链路的首包与总耗时：

| 环节 | 首包 | 说明 |
| --- | --- | --- |
| mock 模型直接流式 | 14 ms | `meta` 帧几乎立刻到 |
| 网关 → 业务工具 → 汇总 | 388 ms（总） | 含一次 HTTP 工具调用 |
| 网关 → RAG `/chat` | 约 90 ms（工具）+ 流式 token | RAG 六节点约 40 ms |

## 三个必须写对的细节

### 1. 分帧

```ts
buffer += decoder.decode(value, { stream: true });
let i = buffer.indexOf('\n\n');
while (i !== -1) { parse(buffer.slice(0, i)); buffer = buffer.slice(i + 2); i = buffer.indexOf('\n\n'); }
```

注意 `TextDecoder` 必须带 `{ stream: true }`：中文一个字符 3 字节，跨 chunk 时用普通模式会出乱码。
单测 `sse.test.ts` 专门在 `event:` 与 `data:` 中间切开验证。

### 2. 心跳与关闭

```ts
this.heartbeat = setInterval(() => raw.write(': ping\n\n'), 15_000);
// done 之后
clearInterval(this.heartbeat); raw.end();
```

心跳用注释行而不是事件：前端解析器会忽略 `:` 开头的行，不会污染 10 类事件。

### 3. 中断

```ts
raw.on('close', () => abortController.abort(new Error('client disconnected')));
```

不做这一步，前端每点一次「停止」就会在上游留一个未完成的请求，演示多轮后连接数明显上涨。

## 上游 `tool_calls` 的坑（顺带验证）

OpenAI 流式返回的 `tool_calls` 是**增量**：

```json
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"query_inventory","arguments":"{\"sk"}}]}}]}
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"u\":\"SKU-"}}]}}]}
```

必须按 `index` 累加 `arguments` 字符串，最后 `JSON.parse`。
按 `id` 拼、每次覆盖、或假设一个 chunk 里就是完整参数，都会得到 `{"sku":` 这类半截 JSON ——
这正是 `TOOL_ARGS_INVALID` 最常见的来源。

## 复现命令

```bash
# 观察逐帧到达（-N 关闭 curl 缓冲）
curl -N http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer demo-token' -H 'X-Chain: direct' \
  -d '{"messages":[{"role":"user","content":"深圳仓 SKU-A1B2C3 还有多少可用库存？"}]}'
```
