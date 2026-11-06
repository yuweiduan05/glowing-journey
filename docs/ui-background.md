# 背景波动 + 配色改造方案

> 参考对象：`deepseek.com/platform`（同源技术见 deepseek.com 首页）
> 目标：把"单调白底"换成有生命感的流动背景，同时保留浅色、克制的品牌基调
> 状态：**已落地**（2026-11-06，最终采用方案 A 深海蓝；实施明细见 §8）

---

## 1. 先搞清楚参考站做了什么

DeepSeek 首页/平台的背景**不是 CSS 渐变，也不是粒子库**，而是一个 WebGL 片元着色器：

| 要素 | 做法 | 对我们的意义 |
| --- | --- | --- |
| 形态 | fbm（分形布朗噪声）叠加多层不同频率的噪声 → curl 流场 → 流体状纹理 | 这才是"波动"的来源，纯 CSS 做不出这种有机形态 |
| 节奏 | **默认只画一帧，完全静止**；鼠标移入才缓慢唤醒 | 高级感的本质是"静"，不是"一直在动" |
| 成本 | 静止时不跑 `requestAnimationFrame`，空闲 GPU 占用≈0 | 聊天页长时间挂着，这条必须抄 |
| 配色 | 深蓝底 + 低饱和冷色噪声，文字永远静止 | 背景负责"活"，文字负责"稳" |
| 配套 | 玻璃拟态卡片（`backdrop-filter: blur(12px)` + 半透明边框） | 面板浮在背景上时才有层次 |

**关键判断**：我们不是官网落地页，没有"鼠标移入 hero 才唤醒"的语义。聊天页的合理改编是——
**只在空态（还没有对话时）让背景缓慢流动（速度降到官网的 1/4），一旦开始对话就淡出到接近静止。** 这样既有辨识度，又不会在用户读答案时抢注意力。

---

## 2. 三种实现强度（按投入排序）

### 方案 A · WebGL 流体背景（推荐，最接近参考站）

- **技术**：`<canvas>` + 内联 GLSL（顶点直通 + 片元 fbm），无第三方依赖，单文件约 200 行
- **视觉**：真正的流体波动，边缘柔和、有层次，和 DeepSeek 同一种技术路线
- **成本控制**（逐条对应官网的坑）：
  - `dpr = Math.min(devicePixelRatio, 2)`，避免 4K 屏像素爆炸
  - 帧率上限 30fps（`accumulated time > 1/30` 才 draw）
  - `IntersectionObserver`：背景不在视口时停止
  - `visibilitychange`：标签页隐藏时停止
  - `preserveDrawingBuffer: true`，否则切标签页回来会变白
  - `ResizeObserver` 触发重绘，否则拉伸后模糊
  - `prefers-reduced-motion` → 只渲染一帧静态图
  - WebGL 不可用 → 自动降级到方案 C 的 CSS 版本
- **工作量**：约 2–3 小时（含调参）
- **风险**：中。着色器参数需要现场调（速度、噪声尺度、色带宽度），一次未必到位

### 方案 B · Canvas 2D 噪声场（折中）

- **技术**：320×180 离屏 canvas 逐像素算 3 层 fbm，CSS `filter: blur(40px)` 放大
- **视觉**：接近流体，但细节少一档，更像"云雾"而非"流场"
- **成本**：每帧 5.7 万像素 × 3 octave，12–15fps 可跑；必须降分辨率否则卡
- **工作量**：约 1 小时
- **风险**：低。没有 WebGL 兼容性问题，但 CPU 占用比 A 高

### 方案 C · 纯 CSS 极光（保底）

- **技术**：3 个 radial-gradient 色块 + SVG `feTurbulence` 噪点 + 慢速 `transform` 位移
- **视觉**：柔和的色雾漂移，不是真正的"波动"，但在低透明度下观感不差
- **成本**：GPU 合成，几乎零开销
- **工作量**：20 分钟
- **风险**：低。适合做 A 的降级路径

**推荐：A 为主 + C 兜底**（同一个组件内做能力探测，一套代码两种表现）。B 不建议——它付出了接近 A 的复杂度，却拿不到 A 的质感。

---

## 3. 配色方案（三选一）

配色不改结构，只换 token 值。现有 `tailwind.config.js` 的语义命名（canvas / subtle / surface / line / ink / muted / faint / accent）保持不变，所以**改色 = 改 8 个十六进制值**，组件零改动。

| 方案 | 气质 | 画布 | 次级底 | 分隔线 | 主文字 | 强调色 | 适合 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A 深海蓝**（推荐） | 冷静、科技、贴近 DeepSeek | `#FFFFFF` | `#F5F8FF` | `#E1E8F5` | `#0F172A` | `#4D6BFE` | 想让"AI 感"最强 |
| **B 石墨靛蓝** | 中性、克制、现有方案精修 | `#FFFFFF` | `#FAFAFA` | `#E8E8EC` | `#1D1E20` | `#4F46E5` | 不想大改，只加背景 |
| **C 青瓷** | 冷静中带一点温度、不容易撞脸 | `#FBFDFC` | `#F1F6F4` | `#DCE7E3` | `#10231E` | `#0E9384` | 想和企业客服场景更贴 |

**背景色带**（以 A 为例，用于 shader 的 3 个 uniform）：
- 底色 `#F7FAFF`（比画布更淡的冷白）
- 色带 1 `#C9D2FF`（强调色的浅调，透明度 0.10）
- 色带 2 `#DCE7E3`（取青瓷的灰绿，做色相错位，透明度 0.08）
- 高光 `#FFFFFF`（噪声峰值处提亮，让流体有"体积感"）

> 判断标准：截图后把背景区去色，如果文字区对比度低于 7:1 就是过强，继续降透明度而不是改颜色。

---

## 4. 落地改动清单（方案 A + A 配色）

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/components/WaveBackground.tsx` | **新增**。canvas + GLSL + 生命周期管理 + 降级逻辑；props：`colors`、`speed`、`paused` | 低，独立组件 |
| `src/App.tsx` | 根节点插入 `<WaveBackground paused={messages.length > 0} />`，`relative isolate` 建立层叠上下文 | 低，2 行 |
| `src/index.css` | 加 `.wave-layer { position: fixed; inset: 0; z-index: -1; pointer-events: none; }`；背景底色从 `--canvas` 改为 `--bg-base` | 低 |
| `tailwind.config.js` | 换 8 个颜色 token；新增 `bg-base` 语义 | 低，全局生效需回归 |
| `src/components/Sidebar.tsx` | `bg-subtle` → `bg-white/60 backdrop-blur-xl`（玻璃拟态，让背景从侧栏透出来） | 中，需确认文字对比度 |
| `src/components/ChatPanel.tsx` | Composer 从 `bg-white` → `bg-white/85 backdrop-blur` | 中，同上 |
| `SettingsSheet.tsx` | 同步玻璃拟态，避免风格割裂 | 低 |

**不动的东西**：所有交互逻辑、SSE 流式、组件层级、路由结构。背景层 `pointer-events: none`，不会拦截任何点击。

---

## 5. 性能与无障碍红线

1. 空闲/暂停时**必须停止 rAF**（对话开始后暂停渲染，只保留最后一帧）
2. 移动端（`innerWidth < 768`）默认降级为方案 C，省电
3. `prefers-reduced-motion: reduce` → 单帧静态图
4. 背景亮度上限：最亮处与 `#FFFFFF` 的差值不超过 6%，保证正文对比度
5. 首屏不阻塞：canvas 挂载后异步初始化，失败静默降级

---

## 6. 验收方式

| # | 项 | 通过标准 |
| --- | --- | --- |
| 1 | 视觉 | 1440/390 两张截图，空态可见缓慢流动，对话态背景静止 |
| 2 | 对比度 | 背景最亮处取样，正文 `#0F172A` 对比度 ≥ 7:1 |
| 3 | 性能 | DevTools Performance：空闲 5 秒内无持续 rAF；流式输出时主线程帧率不低于改动前 |
| 4 | 降级 | 手动禁用 WebGL（`chrome://flags`）→ 显示 CSS 版，不报错 |
| 5 | 无障碍 | 系统开启"减少动态效果"→ 背景静止 |
| 6 | 回归 | `pnpm build` 通过；发送/停止/重试/附件/引用展开全部正常 |

---

## 7. 待你拍板

1. **配色**：A 深海蓝 / B 石墨靛蓝 / C 青瓷
2. **实现强度**：A（WebGL，最像）/ C（CSS，最稳）/ A+C（推荐）
3. **玻璃拟态**：要不要连带把侧栏和输入框改成半透明（更像 DeepSeek，但浅色下对比度要重新校）

---

## 8. 实施记录（2026-11-06 已落地）

**选定**：A 深海蓝配色 + WebGL/CSS 双路径 + 整体玻璃拟态。

| 文件 | 改动 |
| --- | --- |
| `src/components/WaveBackground.tsx` | 新增。GLSL fbm + 域扭曲；DPR×0.55 降采样（1440×900 下画布仅 792×495 ≈ 39 万像素）；30fps 上限；`paused` 精确启停；`visibilitychange` / `ResizeObserver`；`prefers-reduced-motion` 单帧；WebGL 不可用或 <768px 走 CSS 色雾 |
| `src/App.tsx` | 挂载 `<WaveBackground paused={messages.length > 0} />`，根节点改 `bg-transparent` |
| `tailwind.config.js` | 8 个 token 换为深海蓝；新增 `base` 画布色 |
| `src/index.css` | 新增 `.wave-layer` / `.wave-canvas` / `.wave-fallback` + `wave-drift`；滚动条与 Markdown 硬编码色同步 |
| `Sidebar.tsx` | `bg-white/70 backdrop-blur-xl` |
| `ChatPanel.tsx` | Composer `bg-white/85 backdrop-blur-md` |
| `SettingsSheet.tsx` | `bg-white/85 backdrop-blur-xl` |

**关键决策**：着色器把流动感推向四周、中心保持干净（falloff 基于到中心的距离），文字永远落在最淡处；进入对话后整层 `opacity: 0.35` 并停止 rAF。

**验证结果**：`pnpm build` 通过；1440 / 390 截图正常；控制台零报错；画布 792×495（CSS 1440×900），像素量约为原生 1/3。
