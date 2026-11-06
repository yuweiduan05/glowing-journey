# 测试与验证

## 1. 自动化测试

```bash
pnpm test                                              # 网关 + 业务
pnpm test:rag                                          # RAG（自动探测 .pylibs / .venv 并注入 PYTHONPATH）
```

> 直接 `cd services/rag && python -m unittest` 会因 `.pylibs` 不在 `sys.path` 报 `ImportError: pydantic`，
> 且 Windows 的 cmd / PowerShell 不支持 `PYTHONPATH=x cmd` 前缀语法 —— 所以统一走 `pnpm test:rag`。

| 套件 | 用例数 | 覆盖点 |
| --- | --- | --- |
| `apps/gateway/src/__tests__/sse.test.ts` | 4 | 跨 chunk 截断、心跳、CRLF、10 类事件往返 |
| `apps/gateway/src/__tests__/providers.test.ts` | 5 | 上游 SSE：CRLF 分帧、跨 chunk 截断、粘包、截断 flush、tool_calls 增量累积 |
| `apps/gateway/src/__tests__/tools.test.ts` | 15 | SKU 格式、customer_id 越权入参、摘要长度、未注册工具、坏 JSON、下游不可达、幂等键派生、mock 工具决策（含混合意图并行调用） |
| `apps/gateway/src/__tests__/chain.test.ts` | 6 | direct 不重试、proxy 退避、不可重试错误、降级、熔断、熔断后 direct 仍可调用 |
| `apps/gateway/src/__tests__/orchestrator.test.ts` | 5 | tool_limit 判定（末轮作答不误标/用尽仍要工具才标）、enable_knowledge 执行拦截（不触达下游、不误发 handoff） |
| `services/business-api/src/__tests__/domain.test.ts` | 22 | 数据规模、可用量口径、跨仓汇总、替代型号（含按仓过滤）、403/404、少发识别、幂等、冲突、限流、工单详情数据边界 |
| `services/rag/tests/` | 26 | 切块长度/表头重复/token 保护（含区分度反证）、边界判定、契约字段一致性 + 实例级校验、状态图（引擎/六节点/重试上限/分级改写） |

实测输出：

```
apps/gateway        Tests 35 passed (35)
business-api        Tests 22 passed (22)
rag (unittest)      Ran 26 tests ... OK
```

## 2. 契约

```bash
pnpm contracts
# [contracts] 已导出 8 份 schema + SSE/错误码清单
```

`test_contract.py` 断言：RAG 响应含 `answer/sources/boundary/confidence`；
`Source` 含 `doc_title/section/chunk_id/score`；`query_order.input` 不含 `customer_id`；
`create_ticket.input` 必填 `idempotency_key`。

## 3. 端到端手工验证（已执行）

```bash
# 1) 健康
curl :8081/health    # business ok / rag ok / model ok
curl :8083/health    # vector_store=chroma, chunks=96, engine=langgraph

# 2) D1 库存（SSE）
curl -N :8081/v1/chat/completions -H 'Authorization: Bearer demo-token' \
  -H 'X-Chain: direct' -d '{"messages":[{"role":"user","content":"深圳仓 SKU-A1B2C3 还有多少可用库存？"}]}'
# meta → thought×2 → tool_call(query_inventory, WH-SZ) → tool_result(available=17) → token* → done

# 3) D3 订单
# status=SHIPPED, tracking=SF1234567890, line qty=3/shipped=2（少发）
```

工单三条路径实测：

```
首次创建   201 {"ticket_no":"TK-20261022-0001","deduplicated":false,...}
幂等重放   200 {"ticket_no":"TK-20261022-0001","deduplicated":true,...}
同类冲突   409 {"code":"DUPLICATE_TICKET","details":[{"message":"未关闭工单 TK-..."}]}
```

错误码实测：

```
越权订单    403 FORBIDDEN_DATA_SCOPE
非法 SKU    400 INVALID_ARGUMENT + details[0].path=/sku
chaos=500   500 INTERNAL_ERROR → 网关映射 TOOL_UPSTREAM_ERROR(502)，proxy 重试一次
```

## 4. RAG 评测

```bash
pnpm eval:rag
```

```
cases                36
answerable_cases     31
hit_at_4             1.000      # 仅可答用例的文档级命中，不可答不再白送
unanswerable_cases   5
refusal_accuracy     0.800      # 正确拒答 4/5（q34 越界降级为未覆盖，如实计入失败）
boundary_accuracy    0.972
citation_coverage    1.000
avg_latency_ms       ~40（纯本地，随负载 35–60ms 波动；report.json 存当次实测值）
vector_store         chroma
graph_engine         langgraph
```

## 4.1 端到端脚本

```bash
node scripts/e2e.mjs        # 需三服务已启动
```

覆盖 D1–D8，实测输出：

```
PASS  D1 库存            可用 17 件，低于安全库存
PASS  D2 跨仓/替代       广州仓可用 9
PASS  D3 订单/少发       已发货 + 少发 1 件
PASS  D4 建单 + 幂等     TK-20261022-0001，二次 deduplicated
PASS  D5 知识问答 + 引用  引用 4 条
PASS  D6 越界拒答        工具=search_knowledge，handoff=out_of_scope
PASS  D7 未覆盖 + 转人工  handoff=insufficient
PASS  D8 故障注入        TOOL_UPSTREAM_ERROR，界面可重试
8/8 通过
```

> D8（故障注入）依赖 business-api 的 `BUSINESS_CHAOS_ENABLED=1`：`pnpm dev` 通过 `dev.ts` 默认开启，
> 单独用 `pnpm --filter @app/business-api start` 启动时需显式带上，否则 `?chaos=500` 会被静默忽略。
>
> D4 会真实建单，重复跑之前需重置：删除 `services/business-api/data/business.db*` 后重启业务服务。
> 或直接把 `scripts/e2e.mjs` 的 conversationId 换掉（幂等键随之变化），但「同订单同类别未关闭工单」的冲突检查仍会生效。

## 4.2 跨服务追踪（需求 4 的验收）

```bash
curl -s :8081/v1/chat/completions -H 'Authorization: Bearer demo-token' \
  -H 'X-Request-Id: trace-demo-001' -H 'X-Conversation-Id: conv-trace-9' \
  -d '{"messages":[{"role":"user","content":"深圳仓 SKU-A1B2C3 还有多少可用库存？"}]}'
```

三处日志应出现同一组 id：

```
gateway      {"reqId":"trace-demo-001","msg":"request completed"}
business-api {"request_id":"trace-demo-001","conversation_id":"conv-trace-9","msg":"request received"}
rag          [http] POST /chat rid=trace-demo-001 cid=conv-trace-9 status=200
```

## 4.3 真实模型演练（换模型前必跑）

```bash
pnpm drill:model                # 无 Key 也能跑：缺 Key / 上游不可达
pnpm drill:model -- --gateway   # 加验网关 D1 / D5 / D8
```

| 用例 | 断言 | 说明 |
| --- | --- | --- |
| 失败路径 · 缺少 Key | `UNAUTHORIZED` | 必须在发请求前拒绝，不能等上游 401 |
| 失败路径 · 上游不可达 | `UPSTREAM_MODEL_ERROR` | 连接失败要映射成统一错误码 |
| 文本流式 | 收到文本 + 首 token 耗时 | 首包耗时是前端指标的真实来源 |
| 工具调用 | `query_inventory` 且 arguments 是合法 JSON | 验证增量 tool_calls 按 index 拼接 |
| 思考增量 | `reasoning_content` 非空 | 仅推理模型；普通模型自动 SKIP |
| 网关 D1/D5/D8 | 17 件 / 有引用 / `TOOL_UPSTREAM_ERROR` | 需网关已切真实模型、业务服务开 chaos |

报告：`data/runtime/model-drill.json`（已忽略，不入库）。

## 5. 演示前的 5 分钟自检

1. `pnpm dev` 后三个健康灯是否全绿；
2. 顶部链路切 `proxy`，发 D1，看「首包」耗时与工具卡片；
3. 发 D4 两次，确认第二次 `deduplicated`（工单卡片「幂等命中: 是」）；
4. 发 D7，展开 `工具轨迹` 看 `verify` 后的两次重试（trace 长度 16）；
5. 打开「故障注入」发 D1，确认出现红色错误 + 重试按钮，界面仍可输入。

## 6. 已知缺口

- 未做浏览器自动化 E2E（Playwright），当前为手工 + 接口级验证；
- 工具层单测覆盖参数校验与错误映射，未 mock HTTP 做「成功路径」断言（成功路径由 E2E 覆盖）；
- 高并发未压测（SSE 每连接一个 Node 事件循环任务，目标场景为坐席工作台）。
