# 架构说明

## 1. 模块边界（谁负责什么）

| 模块 | 只做 | 明确不做 | 对外接口 |
| --- | --- | --- | --- |
| `apps/web` | 渲染、SSE 解析、交互状态 | 不直连模型、不拼提示词、不碰业务规则 | HTTP + SSE |
| `apps/gateway` | 鉴权注入、编排、工具参数校验、双链路容灾、错误收口、SSE 下发 | 不算库存、不写工单、不切文档 | `/v1/chat/completions` |
| `services/business-api` | 库存/订单/工单的业务规则与持久化 | 不鉴权（信任网关注入的 `X-Customer-Id`）、不生成话术 | `/v1/inventory` `/v1/orders` `/v1/tickets` |
| `services/rag` | 切块、检索、状态图、边界判定、引用 | 不编排业务工具、不改库存 | `/chat` `/retrieve` `/health` `/admin/*` |
| `packages/shared` | 契约真源（zod / 类型 / 事件 / 错误码） | 不含运行时逻辑 | TS 包 + JSON Schema |

边界的两条硬约束：

1. **`customer_id` 只能来自凭证**。网关从 `Authorization` 解析 token → customer_id，注入到工具调用；
   模型侧 schema 里根本没有这个字段，传了会被 strict schema 拒绝（测试 `tools.test.ts` 覆盖）。
2. **业务规则只在 business-api**。网关不写「可用量 = 在库 − 预占」这类公式，只透传与翻译错误。

## 2. 一次对话的时序

```
web ──POST /v1/chat/completions (Bearer, X-Chain, X-Conversation-Id)──► gateway
                                                                        │
   meta ◄───────────────────────────────────────────────────────────────┤ 鉴权 → customer_id
   thought(intent) ◄────────────────────────────────────────────────────┤ 编排第 1 轮
                                                                        │
                        ┌────── 模型返回 tool_calls ────────────────────┤
   thought(plan) ◄──────┤                                               │
   tool_call    ◄───────┤ 参数校验 + 字段注入 + 调用下游                 │
   tool_result  ◄───────┘                                               │
                                                                        │
   token* ◄────────────── 模型生成（或直接转发 RAG answer）───────────────┤
   citation ◄──────────── search_knowledge 的 sources                   │
   handoff  ◄──────────── boundary != in_kb                             │
   done     ◄──────────── finish_reason + usage + total_ms ──────────────┘
```

- `stream=false` 时同样逻辑，但一次性返回 OpenAI 外形 JSON（带 `citations/boundary` 扩展）。
- 客户端 `AbortController` 中断 → 网关 `SseWriter` 监听 `close` → 向上游 fetch 传 abort，
  避免模型连接泄漏（`sse.test.ts` / 手工验证）。

## 3. 双链路差异矩阵

| 场景 | direct | proxy |
| --- | --- | --- |
| 正常调用 | 1 次 | 1 次 |
| 上游 429 / 5xx | 直接报错 | 退避重试 ≤2 次（`PROXY_RETRY_BASE_MS` 指数退避） |
| 主供应商持续失败 | 报错 | 切备用供应商（若配置） |
| 连续失败 ≥ 阈值 | 不熔断 | 熔断 15s，期间直接 `CIRCUIT_OPEN(503)` |
| 读工具超时/5xx | 不重试 | 重试 1 次（写工具不重试，靠幂等键） |
| SSE 契约 | 完全相同 | 完全相同 |

> 关键约束：**已经向前端吐过 token 就不能重试**（会产生重复内容），只能报错。

## 4. 编排回路（ReAct）

```
messages = [system] + 历史
for round in 1..3:
   流式调用模型（tools = 4 个工具，可按开关剔除 search_knowledge）
   若返回 tool_calls：
       emit thought(plan) → 逐条 emit tool_call → 执行 → emit tool_result → 回填角色 tool 消息
       若本轮只有 search_knowledge：直接转发 RAG answer（A3），结束
   否则：
       结束（最终答复已随 token 流出）
超过轮次：降级为「请补充更具体信息」
```

为什么纯知识问题要短路：RAG 的 answer 与 sources 是同一份证据生成的，再让网关「汇总」一次，
会出现「答案提到 A 条款、引用却挂 B 文档」的错位。混合问题（库存 + 保修）才需要二次汇总。

## 5. RAG 状态图

```
route ──knowledge──► rewrite ──► retrieve ──► filter ──► generate ──► verify
  │                     ▲                                                  │
  ├──smalltalk──► 直接回复                                                  │
  ├──business───► 交回网关                                                  │
  └──────────────────── 低置信/无引用 且 retries ≤ 2 ─────────────────────┘
                                                        重试耗尽 → insufficient
```

- `route` 先判越界（crypto/炒股/时政/招聘/竞品价）→ 不检索、不生成，直接拒答；
- `rewrite` 做同义词扩写；重试**按轮次分级**：第 1 次去疑问词 + 同义词 + 泛化词，
  第 2 次只保留核心名词 + 上位词——每轮 query 都不同，不做确定性重复；
  （实测 q31 首轮 top1=0.31 被阈值拦下，第 1 次重试后回到 0.39 判 in_kb）；
- `retrieve` 混合召回：向量 top-N ∪ 全量词覆盖扫描（哈希 embedding 对短问句不稳，需要兜底）；
- `filter` 阈值 0.35、按 (doc, section) 去重、可选轻量 rerank；
- `generate` 只允许用给定片段，逐条带 `[n]`；
- `verify` 判定三态，并决定「成功 / 回写 rewrite / 放弃」。

`/admin/graph` 返回真实 Mermaid（LangGraph 编译产物），可直接截图进文档。

## 5.1 可观测性

网关是唯一入口，`X-Request-Id` 由它确定（缺省生成），并通过工具层透传给 business-api 与 RAG：
下游所有日志都带 `request_id`，business-api 额外带 `conversation_id`，RAG 以 `rid/cid` 打印。
排查一次对话时，三处日志用同一组 id 直接 grep，不需要按时间戳猜。

## 6. 失败路径

| 失败点 | 表现 | 兜底 |
| --- | --- | --- |
| 模型 Key 失效/断网 | `UPSTREAM_MODEL_ERROR` | 切 `MODEL_PROVIDER=mock` 仍可完整演示 |
| business-api 故障 | 工具 `TOOL_UPSTREAM_ERROR` → 前端 toast + 重试 | proxy 链路自动重试一次 |
| business-api 变慢 | `TOOL_TIMEOUT(504)` | 超时可配，前端不卡死 |
| RAG 未建库 | `/chat` 返回 503 `RAG_UNAVAILABLE` | 启动自动 ingest；也可 `POST /admin/ingest` |
| Chroma 不可用 | 自动降级 `LocalStore`，`/health` 标注 `local` | 接口一致，功能不减 |
| 客户端断开 | 网关 abort 上游 | 无连接泄漏 |
| 模型参数非法 | `TOOL_ARGS_INVALID(422)` + 字段级 details | 流式下走 `error` 事件 |
