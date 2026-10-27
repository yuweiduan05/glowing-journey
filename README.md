# 智联贸易 · 业务智能体工作台

> 面向中小贸易企业的「售前—库存—售后」一体化业务智能体。
> **场景 3（业务智能体）为主体，场景 2（企业内部知识库 RAG）作为其中一个工具内嵌**，
> 让「网关双链路 / SSE 透传 / RAG 全链路 / 状态图自适应 / 回答边界 / LangGraph」六项能力在一次演示里全部可验。

---

## 1. 评分点 → 实现位置（自查用）

| 评分能力 | 落点 | 怎么验 |
| --- | --- | --- |
| 网关双链路适配 | `apps/gateway/src/chain.ts`：direct 单次透传 / proxy 重试+降级+熔断 | `pnpm --filter @app/gateway test` 的 `chain.test.ts`；界面顶部切 direct/proxy |
| SSE 透传 | `apps/gateway/src/sse.ts` + `packages/shared/src/sse.ts` | 请求 D1 观察 10 类事件（含 reasoning）；`sse.test.ts` 覆盖跨包截断/心跳/粘包 |
| RAG 全链路 | `services/rag/`（切块→embedding→Chroma→混合检索→状态图→边界→评测） | `pnpm eval:rag` 输出 hit@4 / 边界准确率 |
| 状态图自适应 | `services/rag/app/graph.py`：6 节点 + 重试条件边（上限 2） | `/admin/graph` 返回 Mermaid；D7 的 trace 能看到 `retry` 两次 |
| 回答边界 | `services/rag/app/boundary.py` + 网关 `handoff` | D6 越界拒答、D7 未覆盖转人工 |
| LangChain/LangGraph | 同上，`engine=langgraph` 写在 `/health` | `curl :8083/health` |
| 2–3 个业务工具 | `packages/shared/src/tools.ts` 注册 4 个（3 业务 + 1 RAG） | 界面「工具轨迹」卡片 |

---

## 2. 架构

```
浏览器 (React + Vite + Tailwind, :5173)
   │  fetch + ReadableStream 解析 SSE（ADR-004）
   ▼
统一模型网关 (:8081)  ── 鉴权注入 customer_id / 双链路 / SSE 9 事件 / 工具编排 / 错误收口
   ├─► 上游模型（mock 确定性 / 任意 OpenAI 兼容供应商）
   ├─► 业务 Mock 服务 (:8082)  库存 · 订单 · 工单（SQLite + 确定性种子）
   └─► RAG 服务 (:8083)       FastAPI + LangGraph 六节点 + Chroma
                                 └─ 知识库 12 篇 / 96 chunk / manifest 增量校验
```

四个进程、三类契约（工具 JSON Schema / SSE 事件 / 统一错误码），全部由 `packages/shared` 单一真源派生。

---

## 3. 目录

```
packages/shared/          契约真源：zod schema、工具注册表、SSE 协议、错误码、DTO
apps/gateway/             统一模型网关（Fastify + TS）
  src/agent/              编排回路 + 系统提示词
  src/providers/          mock / openai 兼容（含 tool_calls 增量拼接）
  src/tools/              参数校验、字段注入、下游调用、错误翻译
apps/web/                 工作台前端（浅色极简单列 / 可收起会话侧栏 / 思考过程折叠 / 文本附件 / 设置抽屉，见 docs/ui-redesign.md）
services/business-api/    进销存 Mock（node:sqlite，零原生依赖）
services/rag/             RAG 服务（Python 3.13 + FastAPI + LangGraph + Chroma）
data/kb/                  知识库 12 篇（4 类 doc_type，2 篇表格型，1 篇中英混排）
data/eval/                36 条评测集 + report.json
contracts/                由 pnpm contracts 导出的 JSON Schema / 事件 / 错误码
docker/ + docker-compose.yml   4 容器编排（未经实跑验证，见 §4.5 诚实说明）
docs/                     架构、接口、ADR、演示脚本、测试与知识库说明
```

---

## 4. 快速开始

### 4.1 前置

- Node.js ≥ 22.5（用到内置 `node:sqlite`）
- pnpm ≥ 9（本仓库在 pnpm 12 验证）
- Python **3.13**（`services/rag/.pylibs` 的预编译依赖锁定 cp313；用其他版本请改走 `.venv` 安装，
  或设置 `RAG_PYTHON` 指向 3.13 解释器）

### 4.2 安装

```bash
pnpm install
pnpm build:shared

# Python 依赖（任选其一）
cd services/rag && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && cd ../..
# 或者无 venv 的本地目录安装：
# cd services/rag && python -m pip install --target .pylibs -r requirements.txt
```

### 4.3 一键启动

```bash
cp .env.example .env     # 默认 mock 模型，无需任何 Key
pnpm dev                 # 同时起 business-api / gateway / rag / web
```

打开 <http://127.0.0.1:5173>，健康灯三个全绿即可开始。

端口表：

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 5173 | web | React 工作台（Vite dev server / nginx） |
| 8081 | gateway | 统一模型网关（唯一对前端入口） |
| 8082 | business-api | 库存 / 订单 / 工单（只监听 127.0.0.1，不对外） |
| 8083 | rag | 知识库服务（FastAPI + LangGraph + Chroma） |

> Windows 提示：`pnpm dev:rag` 走 `scripts/run-rag.mjs` 自动探测 `.venv` / `.pylibs`，
> 避免 cmd 下 `PYTHONPATH=` 前缀语法失败。

### 4.4 换成真实模型

```ini
MODEL_PROVIDER=openai
MODEL_API_KEY=sk-xxx
MODEL_BASE_URL=https://api.openai.com/v1   # 或 DeepSeek / 通义 / Kimi / Ollama 的兼容地址
MODEL_NAME=gpt-4o-mini
# proxy 链路的备用供应商（可选）
MODEL_FALLBACK_API_KEY=
MODEL_FALLBACK_BASE_URL=
MODEL_FALLBACK_NAME=
```

改完重启网关即可，编排、工具、SSE、双链路逻辑一行都不用动。
没 Key 也能完整演示：`MODEL_PROVIDER=mock` 会按规则真实产生 `tool_calls` 并读工具结果，
不是前端假数据。

### 4.5 Docker

```bash
docker compose up --build
# web → http://127.0.0.1:5173（nginx 把 /v1 反代到 gateway，SSE 关闭缓冲）
```

> **诚实说明**：本机没有 Docker，compose 方案**未经真实运行验证**，上面的命令是设计意图而非验收结论；
> 复现请以 §4.3 的 `pnpm dev` 为准（该路径已验证）。另注意 compose 中 gateway / business-api / rag
> 只做了容器间 `expose`，未映射宿主端口——按设计只有 web 对外。

---

## 5. 演示脚本（D1–D8）

界面左侧「演示脚本」按钮一键发送，右侧同步显示意图/工具/耗时/引用。

| # | 说法 | 预期 |
| --- | --- | --- |
| D1 | 深圳仓 SKU-A1B2C3 还有多少可用库存？ | 可用 17 件（在库 25 − 预占 8），低于安全库存 40，在途 100 |
| D2 | SKU-A1B2C3 广州仓呢？如果都不够，有什么替代型号？ | 广州仓可用 9；替代 SKU-B4C5D6 / SKU-C7D8E9 |
| D3 | 订单 SO-20261012-007 到哪了？ | 已发货 + 顺丰单号 + 「订购 3 / 已发 2」少发提示 |
| D4 | 客户说少发了一件，帮我建个工单 | 新工单号；**再点一次** → `deduplicated: true` |
| D5 | 这款设备的保修期是多久？换货要什么条件？ | 带 [1][2][3] 引用的政策答案 + 4 条来源 |
| D6 | 你们支持比特币付款吗？ | `out_of_scope` 红色拒答，不检索不生成 |
| D7 | 我们公司的股权结构是怎样的？ | `insufficient` 黄色 + 转人工；trace 里能看到重试两次 |
| D8 | 打开「故障注入」再问 D1 | 工具两次失败 → `TOOL_UPSTREAM_ERROR`，界面不卡死，可重试；关掉注入后恢复 |

---

## 6. 验证

```bash
pnpm test              # 网关 35 + 业务 22 用例
pnpm contracts         # 导出 8 份 JSON Schema 到 contracts/
pnpm eval:rag          # 36 条评测：可答 31/31 全命中 / 拒答正确率 4/5 / 边界准确率 97.2%
node scripts/e2e.mjs   # D1–D8 端到端：8/8（干净 DB，含故障注入）
cd services/rag && python -m unittest discover -s tests   # 26 条（含契约实例校验、状态图与多意图回归）
curl :8083/health      # 看 vector_store=chroma、chunks=96、engine=langgraph
```

实测结果与已知未命中项见 `docs/testing.md`。

---

## 7. 与路线文档的偏差（已确认项 + 修补项）

| 编号 | 文档原描述 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| A1 | 六节点出现两种写法（verify / retry） | 6 节点 = route/rewrite/retrieve/filter/generate/verify，retry 为条件边 | 与你确认，取状态图口径 |
| A2 | direct「不改内容」= 纯透传 | 两条链路都跑完整编排，差异只在重试/降级/熔断 | 与你确认，否则 direct 下没有工具时间线 |
| A3 | RAG 自生成 + 网关汇总 | 纯知识问题直接转发 RAG answer；混合问题才二次汇总 | 与你确认，避免答案与引用不一致 |
| A4 | 错误码按 HTTP 状态码定义 | 流式下统一 HTTP 200 + `error` 事件，`error.details` 带字段级信息 | 开流后无法再改状态码 |
| C1 | `idempotency_key` 由模型传入 | 网关按「会话+订单+类别+**摘要指纹**」派生注入，模型不可见 | 模型每次重放都会换 uuid；且只看类别会把「少发/破损」折叠成一张单 |
| C2 | `phone_tail` 出参为单对象 | 命中多单返回最近一单 + `ambiguous/candidates` | 契约无数组形态 |
| C3 | D8 期望「展示 503」 | 业务服务故障映射为 `TOOL_UPSTREAM_ERROR(502)`，503 保留给 RAG/熔断 | 503 原本只定义了两个 code |
| C4 | `meta.mode` 未定义取值 | `stream` / `sync` | 与「流式开关」对应 |
| C5 | 无 Python 侧契约方案 | zod → JSON Schema → Pydantic 契约测试 | TS/Python 无法共享代码 |
| C6 | 2.4 写「AI SDK 收口模型调用」 | `providers/openai.ts` 直接 fetch 手写流式解析 | 需精确控制 tool_calls 增量拼接与 abort，见 ADR-003 |
| C7 | bge-small-zh 本地 embedding | 默认 hash（离线确定性），可切 bge/openai | torch 体积与现场网络风险，R6 允许降级，见 ADR-007 |

契约扩展（只增不改）：`Source.text`（引用原文）、`QueryInventoryOutput.by_warehouse/quantity_basis`、
`QueryOrderOutput.ambiguous/candidates`、`ErrorEvent.details`。

---

## 8. 已知限制

- **默认 embedding 是内置 hash 实现**（离线、确定性、零模型下载）。要上 bge-small-zh：
  装 `sentence-transformers` 后设 `EMBEDDING_PROVIDER=bge`，**并重建索引**（签名变了）。
- 检索为「向量 + 全量词覆盖」混合，规模到十万级 chunk 时应换成倒排索引/BM25 服务。
- mock 模型按规则选工具，只覆盖演示语料；真实模型的泛化能力需切 `MODEL_PROVIDER=openai` 验证。
- 演示鉴权是固定 token 映射，生产需换 JWT/网关注册；business-api 不对外暴露端口。
- 未做多轮指代消解（「那广州仓呢」依赖上下文里出现过的 SKU，mock 会回看历史消息）。

---

## 9. 文档索引

- `docs/architecture.md`：模块边界、数据流、时序、失败路径
- `docs/api.md`：四个服务的接口、SSE 事件表、错误码表
- `docs/adr/README.md`：ADR-001 ~ 007
- `docs/knowledge-base.md`：知识库构成、切块参数、manifest、评测
- `docs/testing.md`：测试清单与实测输出
- `docs/demo-script.md`：8 分钟演示口播稿
- `docs/spike-sse.md`：SSE 透传 spike 记录
- `docs/tech-review.md`：技术选型评估（六维度 + 量化瓶颈 + 改进清单）
- `docs/ui-redesign.md`：Web 端改版说明（诊断 / 主流对照 / 方案 / 验证）
