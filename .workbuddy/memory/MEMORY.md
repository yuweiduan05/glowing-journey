# 项目长期记忆（期末作品）

## 项目性质
腾讯 AI 选修课期末作品，用户是**学习者**（交作业方）。作品按 `项目路线规划.md` 实现：
场景 3 业务智能体为主体，场景 2 的 RAG 全链路内嵌为工具（`search_knowledge`）。

## 不可动摇的约定
1. **契约单一真源** `packages/shared`：工具 schema、SSE 9 类事件、13 个错误码都在这里；
   改动后必须 `pnpm --filter @app/shared build`，Python 侧用 `pnpm contracts` 重新导出 JSON Schema。
2. **数据边界**：`customer_id` 只能来自网关凭证注入；工具模型 schema 里不存在该字段，
   传了会被 strict schema 拒绝（`query_order` 有测试）。
3. **幂等键**由网关派生（会话+订单+类别），**绝不交给模型生成**。
4. 业务规则只在 `services/business-api`；网关不算库存、不写工单。
5. 流式错误一律 HTTP 200 + `error` 事件（不能改状态码）。

## 端口与服务
5173 web / 8081 gateway / 8082 business-api / 8083 rag。
`pnpm dev` 一键起；`scripts/run-rag.mjs` 负责探测 Python 与 `.pylibs`。

## 常用命令
```
pnpm build:shared && pnpm dev
pnpm test                 # gateway + business
pnpm --filter @app/gateway test
cd services/rag && .pylibs python -m unittest discover -s tests
pnpm eval:rag
node scripts/e2e.mjs      # 干净 DB 下 8/8
pnpm contracts
```

## 演示锚点数据（不要改）
- `SKU-A1B2C3` 深圳仓 在库 25 / 预占 8 / 可用 17 / 安全库存 40 / 在途 100（2026-10-28）
- 订单 `SO-20261012-007` 属于 C-10087，已发货，订购 3 已发 2（少发）
- 种子 PRNG 固定 `20261022`；重置 DB 即恢复
