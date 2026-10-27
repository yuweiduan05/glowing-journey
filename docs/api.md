# 接口文档

所有服务的错误响应统一为：

```json
{ "code": "TOOL_ARGS_INVALID", "message": "…", "request_id": "…", "retryable": false, "details": [
  { "path": "/sku", "message": "SKU 必须形如 SKU-A1B2C3", "code": "invalid_string" }
] }
```

| code | HTTP | 含义 |
| --- | --- | --- |
| INVALID_ARGUMENT | 400 | 请求体不符合 Schema |
| UNAUTHORIZED | 401 | 缺少/无效凭证 |
| FORBIDDEN_DATA_SCOPE | 403 | 越权访问他人订单/工单 |
| NOT_FOUND | 404 | 订单/SKU/工单不存在 |
| DUPLICATE_TICKET | 409 | 同订单同类别存在未关闭工单 |
| TOOL_ARGS_INVALID | 422 | 模型生成的工具参数非法 |
| RATE_LIMITED | 429 | 建单限流 |
| UPSTREAM_MODEL_ERROR | 502 | 上游模型异常 |
| TOOL_UPSTREAM_ERROR | 502 | 业务服务异常（契约补充） |
| RAG_UNAVAILABLE | 503 | 知识库不可用 |
| CIRCUIT_OPEN | 503 | 模型通道熔断 |
| TOOL_TIMEOUT | 504 | 工具调用超时 |
| INTERNAL_ERROR | 500 | 未归类的内部错误 |

口径：**400 = 调用方违约**（请求体不符合 Schema，网关在鉴权后第一道关卡拒绝）；
**422 = 模型违约**（模型生成的工具参数非法，由网关在工具执行前区分并收口）。

## 1. 网关 `:8081`

### POST `/v1/chat/completions`

请求头：

| Header | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <token>`，演示 token 见 `AUTH_TOKENS` |
| `X-Chain` | 否 | `direct` / `proxy`，默认 `proxy` |
| `X-Conversation-Id` | 否 | 幂等键派生与会话审计用，缺省随机 |
| `X-Request-Id` | 否 | 链路追踪，缺省生成；会透传到 business-api / RAG 的日志与响应头 |

Query：`?chaos=slow|fail|500` 会透传到 business-api，用于故障注入演示。

请求体：

```json
{
  "messages": [{ "role": "user", "content": "深圳仓 SKU-A1B2C3 还有多少可用库存？" }],
  "stream": true,
  "conversation_id": "c-demo",
  "enable_knowledge": true,
  "max_tool_rounds": 3,
  "temperature": 0.2
}
```

流式响应：`text/event-stream`，10 类事件。

| 事件 | data | 说明 |
| --- | --- | --- |
| `meta` | `{request_id, chain, model, mode, ts}` | 首帧，`mode=stream\|sync` |
| `thought` | `{step, text}` | 编排器的结构化步骤，`step` ∈ intent/plan/rag（`rag` = RAG 状态图节点流转，如 `route → rewrite → retrieve …`） |
| `reasoning` | `{delta}` | 模型思考文本增量。前端累积后以灰字展示，正文首 token 到达即折叠；**不进入答案正文** |
| `tool_call` | `{call_id, name, args}` | `args` 已是对象（不是字符串） |
| `tool_result` | `{call_id, name, status, latency_ms, data?, error?}` | `error` 含 code/message/details |
| `token` | `{delta}` | 最终答复增量 |
| `citation` | `{sources:[{doc_title, section, chunk_id, score, text?}]}` | 知识库引用 |
| `handoff` | `{reason, boundary}` | boundary ≠ in_kb 时下发；`boundary` 为结构化枚举，前端不再解析文案 |
| `done` | `{finish_reason, usage, total_ms}` | `finish_reason` ∈ stop/tool_limit/handoff（流内错误走独立的 `error` 事件，不用 `done` 承载） |
| `error` | `{code, message, retryable, details?}` | 开流后的错误，HTTP 仍为 200 |

心跳：每 15s 一行 `: ping`；`done` / `error` 之后立即关闭连接。

非流式响应：OpenAI 外形 + `citations` / `boundary` / `request_id` / `reasoning` 扩展，另有可选 `timeline`。
`reasoning` 为非流式下的整段思考文本（流式走 `reasoning` 事件，语义一致）。

```json
{
  "id": "chatcmpl_…", "object": "chat.completion", "created": 1792666331,
  "model": "mock-deterministic",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "citations": [{ "doc_title": "产品保修政策（2026 版）", "section": "二、保修期限", "chunk_id": "kb-007-0001", "score": 0.6309, "doc_id": "kb-007", "text": "整机保修 12 个月。" }],
  "boundary": "in_kb",
  "timeline": [
    { "kind": "thought", "step": "intent", "text": "正在分析问题意图，判断需要调用哪些工具" },
    { "kind": "tool", "call_id": "call_a1", "name": "search_knowledge", "args": { "question": "保修期多久？" }, "status": "ok", "latency_ms": 38, "data": { "answer": "…", "sources": [], "boundary": "in_kb" } }
  ],
  "request_id": "req-123"
}
```

`timeline` 与流式 SSE 的 `thought` / `tool_call` / `tool_result` 事件等价——关掉流式开关不丢「思考→调用→结果」。

### GET `/health` · GET `/v1/models`

`/health` 聚合三服务：任一 down → `status=degraded`。

## 2. 业务服务 `:8082`（内网）

除 `/health` 外均需 `X-Customer-Id`（由网关注入，不对外暴露）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/inventory/:sku?warehouse_code=&include_reserved=` | 单仓或跨仓汇总；`include_reserved=false` 按在库口径 |
| GET | `/v1/inventory?limit=20` | 低于安全库存的 SKU 列表 |
| GET | `/v1/orders/:orderNo` | 订单详情（越权 403） |
| GET | `/v1/orders?phone_tail=8866` | 按尾号查最近一单，多单带 `ambiguous` |
| POST | `/v1/tickets` | 建工单（幂等键必填；同 key 重放 200 + `deduplicated`；语义重复 409） |
| GET | `/v1/tickets/:ticketNo` | 工单详情 |

工单判重规则（2026-10-22 调整）：

1. **同幂等键重放** → 返回原工单，`deduplicated: true`（HTTP 200）；
2. **同订单 + 同类别 + 摘要相似度 ≥ 0.7** → 409 `DUPLICATE_TICKET`，details 指向已有工单；
3. **同订单 + 同类别但问题不同** → 允许新建（不折叠），但该组合未关闭工单上限 3 张，
   超出返回 409（details.code = `open_ticket_limit`）。

关键响应字段：

```json
// GET /v1/inventory/SKU-A1B2C3?warehouse_code=WH-SZ
{ "sku": "SKU-A1B2C3", "warehouse": "WH-SZ",
  "on_hand": 25, "reserved": 8, "available": 17,
  "safety_stock": 40, "below_safety": true,
  "in_transit": 100, "restock_eta": "2026-10-28",
  "substitutes": [{ "sku": "SKU-C7D8E9", "available": 33, "compatibility": "upgrade" }],
  "quantity_basis": "available" }
```

## 3. RAG `:8083`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/chat` | `{question, top_k?, filters?}` → `{answer, sources[], boundary, confidence, trace[]}` |
| POST | `/retrieve` | 只检索，返回 hits + 耗时 |
| GET | `/health` | 向量库类型、chunk 数、manifest 版本、图引擎、embedding 签名 |
| POST | `/admin/ingest` | `{force?:true}` 重建索引；未变化则 `skipped:true` |
| GET | `/admin/manifest` | 版本、切块参数、每篇文档 sha256 与块数 |
| GET | `/admin/graph` | Mermaid 状态图（text/plain） |

`boundary` 三态：`in_kb`（有证据且带引用）/ `insufficient`（未覆盖）/ `out_of_scope`（越界拒答）。

## 4. 契约文件

`pnpm contracts` 生成 `contracts/*.schema.json`（8 份）、`sse-events.json`、`error-codes.json`；
Python 侧 `tests/test_contract.py` 会断言字段一致，防止两侧漂移。
