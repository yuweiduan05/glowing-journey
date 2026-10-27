# 架构决策记录（ADR）

## ADR-001 契约单一真源：zod + JSON Schema 导出

**背景**：工具入参/出参、SSE 事件、错误码在三个 Node 服务与一个 Python 服务之间流转，
最容易出现「网关改了字段、RAG 没跟上」的静默错位。

**决策**：全部契约写在 `packages/shared`（zod）。Node 侧直接 import；
Python 侧通过 `pnpm contracts` 导出 JSON Schema，用 Pydantic 模型 + 契约测试对齐。

**代价**：多一步导出命令；schema 改动需同步重建 shared。
**收益**：`tests/test_contract.py` 能在 CI 阶段拦住字段漂移，而不是等到联调。

---

## ADR-002 RAG 内嵌为工具，但保留独立服务与 `/chat`

**背景**：场景 2 要求 RAG 全链路独立可演示，场景 3 要求它是「一个工具」。

**决策**：RAG 仍是独立进程（`:8083`），网关通过 HTTP 调 `/chat`；不把它降级为库函数。
`/chat` 自己完成检索与生成，网关不拆它的内部步骤。

**代价**：多一次网络跳转（实测 ~40ms）。
**收益**：场景 2 的六环节可以单独验收；RAG 可独立扩容/换实现。

---

## ADR-003 模型接入不用 Vercel AI SDK，直接 fetch（对路线文档的偏差）

**背景**：路线文档 2.4 写「AI SDK 收口」。实际实现里模型调用只有两件事：
流式解析 `tool_calls` 增量、把 abort 传下去。

**决策**：`apps/gateway/src/providers/openai.ts` 直接用 `fetch` + 手写增量拼接。

**理由**：
1. AI SDK 的 `tool_calls` 增量语义被封装后，反而难以精确控制「按 index 拼接 arguments」这条最容易错的点；
2. 少一层 ESM/版本耦合，换供应商只需改 base_url；
3. mock 与真实供应商共用同一个 `ModelInvoker` 接口，替换成本为零。

**代价**：需要自己维护 SSE 解析（已有单测覆盖跨包截断/粘包）。
**复核条件**：若后续要接多模态/图片输入，重新评估引入 SDK。

---

## ADR-004 前端用 fetch + ReadableStream，不用 EventSource

**背景**：EventSource 只能 GET、不能带 Authorization 头、不能传 body。

**决策**：`fetch` POST + `ReadableStream`，解析器复用 `packages/shared` 的 `SseParser`。

**收益**：与网关同一份解析实现，单测一次覆盖两侧；支持中断、可读 `error` 事件体。

---

## ADR-005 工具错误统一翻译到网关

**背景**：下游会返回 400/403/404/409/429/500，语义各不相同；模型只认识错误码。

**决策**：business-api 用统一信封 `{code,message,request_id,details}`；
`ToolRegistry` 把下游错误映射成 13 个标准码之一，再交给模型/前端。

**边界**：`403` 必须是 `FORBIDDEN_DATA_SCOPE` 而不是 404 ——
「查不到」和「不能查」对前端与审计是两件事。

---

## ADR-006 业务数据全 Mock + 确定性种子

**背景**：真实 ERP 不可得；演示要可复现（截图、评测、回归）。

**决策**：`node:sqlite` + 固定种子 PRNG（`20261022`）生成 60 SKU / 3 仓 / 40 订单 / 12 工单；
锚点数据（SKU-A1B2C3、SO-20261012-007）硬编码，保证 D1–D4 数值稳定。

**代价**：不能反映真实数据分布。
**收益**：任何机器跑出来完全一致，单测可断言具体数字（如可用量 17）。

---

## ADR-007 Embedding 分层兜底：hash 默认，bge/openai 可切

**背景**：bge-small-zh 需 torch（数百 MB），演示现场网络不可靠；
路线文档 6.1 R6 允许「退化为 BM25 + 关键词检索」。

**决策**：
- 默认 `hash`：字符 2/3-gram 哈希到 512 维，确定性、零依赖；
- 检索层再加「全量词覆盖扫描」兜底，弥补哈希向量对短问句召回不足；
- `EMBEDDING_PROVIDER=bge|openai` 可切，签名变化会触发重建（manifest 校验）。

**代价**：语义泛化弱于真 embedding（同义不同词需靠 SYNONYMS 表补）。
**收益**：离线可跑、结果可复现，评测指标稳定在 hit@4 97%。
