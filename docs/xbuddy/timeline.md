# 时间线 · 五个阶段

> 按阶段而非"第 N 天"组织：这个项目是**集中攻坚 + 分阶段打磨**，硬凑成日记会失真。
> 每个阶段记四件事：目标 / AI 产出了什么 / 我拦下或改了什么 / 拿什么验证。

---

## 阶段一 · 10-22 立项与契约冻结

**目标**　按路线文档把单仓多模块立起来：契约层 → 业务 Mock → 网关 → RAG → 前端 → 文档/容器。

**AI 产出**　一天内落了七个模块的主体实现；同时把路线文档里 7 处"写得很顺但实现不了"的地方逐条改写，形成 README §7 的偏差表。

**我拦下/改了什么**

- **A2 双链路语义**：文档说 direct 是"只鉴权不改内容"的纯透传。我否掉了——那样 direct 下没有工具时间线，双链路对比就退化成"有没有工具"的对比。改为两条链路都跑完整编排，差异只在重试/降级/熔断。
- **C1 幂等键**：见 [cases.md](cases.md) 案例 2，从"模型传"改成"网关派生"。
- **C3 错误码**：业务服务故障原本映射 503，与 RAG 不可用撞车；改成 `TOOL_UPSTREAM_ERROR(502)`，503 只留给 RAG 与熔断。

**当日踩的环境坑**（都是"AI 想当然"的代价）

1. 沙箱里 esbuild 加载不到 `winmm.dll` → 装依赖/跑测试要放开沙箱；
2. PyPI 默认源与清华源都失败，阿里云镜像可用；
3. 中文路径下 `python -m venv` 的 ensurepip 失败 → 放弃 venv，改 `pip install --target .pylibs`，由 `scripts/run-rag.mjs` 注入 `PYTHONPATH`；
4. 本机 HTTP(S)_PROXY 会拦 127.0.0.1 → `curl` 要加 `--noproxy '*'`。

**验证**　单测 gateway 21 / business 15 / rag 16；`node scripts/e2e.mjs` 8/8；`pnpm eval:rag` 36 条（hit@4 0.972 / 边界 0.944）。

**遗留**　幂等语义过宽、无限流、无迁移、无 CI、Docker 未实跑——当晚补了跨服务 trace 与幂等指纹，CI 写了但**当时没有 git 仓库，从未真跑过**（这条后来在阶段五被证实）。

---

## 阶段二 · 10-23 前端整改

**目标**　把 `前端审查报告.md` 里 6 条高优先级 + 8 条中优先级逐条落地。

**AI 产出**　按清单改：流式 token 50ms 合帧、IME `isComposing` 判断、智能自动滚动（底部 80px 判定）、首屏健康态改"检测中"中性态、Markdown 表格横向滚动、对比度 slate-600→500、`prefers-reduced-motion`、`focus-visible` 焦点环、SVG favicon、aria-label/aria-current、引用展开键修复。

**我拦下/改了什么**

- **H1 的修法**：问题描述是"每个 token 触发全量重渲染 + Markdown 全量重解析"。加 `React.memo` 只能省前者，救不了后者；最终改成**合帧缓冲**（50ms 合帧，done/error/finally 强制 flush），从源头把解析次数降下来。
- **并行改动**：整改期间 `App.tsx` 被另一条线改过（F-07 onBoundary、F-08 重试 appendUser）。规矩由此定下：**改动前先读当前文件，不凭记忆里的版本改**。

**验证**　`pnpm build` 通过；Playwright 截图核对 1440 / 390 两档；D1 端到端 56 字回复无截断。

**未做（如实记）**　H3 生产环境 nginx 压缩、H4 localStorage 持久化、H5 流式中切换会话的 patch 寻址、M2–M4。

---

## 阶段三 · 10-28 ~ 11-06 视觉重构

**目标**　从"能用的工作台"做到"敢拿去演示的产品"：设计系统、微交互、品牌、背景。

**AI 产出**

- **设计令牌重构**：`canvas / subtle / surface / line / ink / muted / faint / accent` 八色体系，组件全量替换；旧的深色审查结论随之作废（这条我在日志里专门标注了，避免后人拿旧结论改新代码）。
- **微交互**：输入框呼吸光环（3.4s，box-shadow 动画含原阴影防跳变）、"正在思考"三点、按钮按压反馈、空态能力卡片 45ms 错峰 fade-up、异常状态点 pulse-soft。
- **布局对齐 DeepSeek 网页端**：侧栏 260px、顶栏信息收进设置抽屉、空态输入框居中、对话后沉底。
- **流动背景**：`WaveBackground.tsx`，GLSL fbm + 域扭曲，DPR×0.55 降采样（1440×900 → 792×495）、30fps 上限、对话开始即停 rAF、`visibilitychange` / `ResizeObserver`、`prefers-reduced-motion` 只画一帧、无 WebGL 或 <768px 走 CSS 色雾。
- **品牌**：定名「知言」（知其所问，言必有据），图标「矢入框」双变体。

**我拦下/改了什么**

- **图标方案**：第一版线性图标在 48px 下像「→0」、19px 下发糊。要求改双变体（≥28px 线条 / <28px 实底），并在 19 / 26 / 48 三档放大核对后才收。
- **背景的"静"**：参考站默认只画一帧、鼠标移入才醒。聊天页没有 hero，我改成"空态缓慢流动（速度降到 1/4），进入对话淡出到 0.35 并停 rAF"——否则读答案时背景还在动，注意力被抢。
- **`prefers-reduced-motion` 回退**：重构时丢过一次，是补回后才过的验收——降级能力最容易在"换设计系统"时被顺手删掉。

**验证**　每次改完 `pnpm build` + 1440/390 截图 + 控制台零报错；背景项额外核对画布尺寸与像素量（约原生 1/3）。

---

## 阶段四 · 11-06 交付自检

**目标**　换评委视角，从零走一遍"拿到仓库能不能跑、能不能信"。

**做法**　先定口径：**只认命令输出，不认文档描述**。让助手按 README 从零执行，我在旁边盯"哪一步和文档不一致"。

**查出四类问题**

1. **契约漂移**：`shared` 10 类事件，导出物 9 类（见 [cases.md](cases.md) 案例 7）。
2. **文档命令不可用**：RAG 单测那条照抄就 `ImportError`（见 [cases.md](cases.md) 案例 8）。
3. **内部材料混进仓库**：路线规划、两份审查报告、课程作业 PDF 都被 git 跟踪；而审查报告首页自己写着"不随作品提交"。
4. **Docker 口径过虚**：文档说"未经任何验证"，其实 CI 里就有 `docker compose build`——**该验的没验，能说的没说**。

**处理**　前三条当天修完并提交（`4b000ba`），第四条留到阶段五用 CI 结果说话。

**验证**　`pnpm -r typecheck` 4 包通过；`pnpm test` 57 条；`pnpm test:rag` 26 条；e2e 8/8；eval 36 条数字与 README 逐项对上。

---

## 阶段五 · 11-08 上线与实证

**目标**　推到 GitHub，让"能跑"这件事由平台而不是由我说了算。

**AI 产出**

- 建远端、推 `main` 与 `v1.0-final`、补仓库描述与 topics；
- 回写 README §4.5 与 `docs/tech-review.md` 的 Docker 口径；
- 自动化录屏脚本（Playwright 驱动真实前端跑完 D1–D7，导出 1440×900 / 32s 的 mp4）。

**CI 实证**（两次运行均 success）

| job | 内容 | 结果 |
| --- | --- | --- |
| Node | `install --frozen-lockfile` → typecheck → 57 条单测 → 契约漂移检查 | ✅ |
| Python 3.13 | `unittest` 26 条 | ✅ |
| Docker | `docker compose build` 四个镜像 | ✅ |

**我拦下/改了什么**

- **"构建"不等于"能跑"**：CI 只 build 不 up，所以 README 里我把结论收在"build 已验、运行态未验"，没有顺手写成"部署已就绪"。
- **断链预判被推翻**：`tech-review.md` 曾判断"跨阶段复制 pnpm 符号链接的 node_modules 很可能断链"，CI 实跑没断。**预判也要有验证，否则就是另一种想当然**——这条我按"已消除"改了状态，但保留了原判断，方便对照。

**验证**　<https://github.com/yuweiduan05/glowing-journey/actions>；`作品演示录屏.mp4`（32s，D1–D7 实跑画面）。
