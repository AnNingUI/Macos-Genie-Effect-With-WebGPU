# AI Agent 使用指南

本文档说明此项目的实际结构、必须遵守的约束，以及修改后如何验证。

## 项目概述

用 WebGPU 在浏览器里实现 macOS 窗口最小化的 Genie Effect。窗口内容是真实 HTML，
经 HTML-in-Canvas 捕获为纹理，形变由 WGSL 片元着色器逐像素完成。

## 技术栈

- TypeScript（无前端框架）+ Vite 7
- WebGPU（顶点 / 片元管线）
- WGSL
- HTML-in-Canvas（`canvas content="drawable"`）

## 目录

```
index.html                      页面：canvas[content=drawable]、两个 App 窗口、菜单栏、Dock、控制区
src/
├── main.ts                     GenieApp：多窗口渲染、DPR、拖拽/缩放/交通灯/Dock/菜单栏
├── app-window.ts               单窗口封装：纹理 + uniform + 几何 + 最小化状态
├── genie.ts                    纯计算：packGenieUniforms / computeVisibleBounds
├── html-in-canvas.ts           能力探测、三代上传 API 降级、几何同步
├── style.css
├── wgsl.d.ts
└── shaders/effect/
    ├── Genie.vertex.wgsl       Params 结构体 + 顶点 → NDC
    └── Genie.fragment.wgsl     曲线收窄 + 位移 + discard
scripts/
├── genie-check.mjs             纯函数测试（无需浏览器）
├── check.mjs                   CDP 冒烟：状态、截图、控制台报错
└── dpr-check.mjs               CDP：DPR 1/2/3 尺寸校验
vite.config.ts                  端口 5201（strictPort）
```

## 运行与验证

```bash
pnpm dev                       # http://localhost:5201
node scripts/genie-check.mjs   # 纯函数测试，改 genie.ts 后必须跑
node scripts/check.mjs         # 需先启动 dev server
node scripts/dpr-check.mjs     # 需先启动 dev server
```

类型检查：`node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

## 关键约束（改动前必读）

1. **`Params` 只能声明一次**。`Genie.vertex.wgsl` 与 `Genie.fragment.wgsl` 拼接成
   同一个 shader module，结构体与 `@group(0) @binding(0)` 只在顶点文件里声明。

2. **uniform 布局双份维护**。改字段必须同时改 `Genie.vertex.wgsl` 的 `Params`
   和 `src/genie.ts` 的 `packGenieUniforms`，并更新
   `scripts/genie-check.mjs` 里的字段断言。当前是 24 个 float（96 字节）：

   | 下标 | 字段 | 含义 |
   |---|---|---|
   | 0–1 | `viewport` | 画布后备缓冲尺寸（物理像素） |
   | 2–3 | `_pad0` | 对齐填充 |
   | 4–7 | `rect` | 源窗口矩形 x, y, w, h |
   | 8–11 | `targetRect` | 目标矩形（Dock 图标位置与尺寸） |
   | 12–15 | `quad` | 绘制四边形 = 源 ∪ 目标（外扩 2px） |
   | 16–19 | `timing` | time, curveDuration, translationStart, translationDuration |
   | 20–23 | `dir` | 行进方向 xy + 垂直方向 xy |

   ⚠️ **WGSL 保留字**：`target` 和 `time` 都不能做结构体成员名，编译会直接报错，
   所以字段叫 `targetRect`，时间放进 `timing.x`。

3. **纹理必须含 `COPY_DST`**，否则上传静默失败；换纹理后 bind group 必须重建
   （`createTexture` 里已经这么做，改这块时别丢）。

4. **首帧空纹理**。新纹理创建后要立刻 `uploadTexture()`，否则首帧采样到全空，画面全黑。

5. **不要给 `#genie-window` 设 `opacity: 0`**。它会让捕获出的纹理变空（实测过）。
   `pointer-events` 反过来由代码控制：`draw()` 在 `progress > 0` 时写入
   `pointer-events: none`、回到 0 时清空，原因是命中区只有包围盒精度，
   而着色器已经 discard 了漏斗外的像素，那些像素不该再抢点击。
   **改这块时注意两点**：① 只在 `progress <= 0` 恢复，命中测试才有意义；
   ② `pointer-events` 改变不会触发 `paint`，所以它绝不能出现在「靠 paint 刷新画面」的路径上。

6. **几何同步用包围盒近似**。`syncElementGeometry` 接收的是 `computeVisibleBounds`
   的结果（采样若干行后取包围盒），按分轴缩放 + 平移同步命中区。
   动画中命中区是包围盒而非真正的漏斗，这是刻意取舍；
   已丢弃像素的可点问题由上一条的 `pointer-events` 兜住。

7. **尺寸变化必须主动重绘**。`resize` / DPR 变化由 `setupResize()` 监听，
   回调里 `applyCanvasSize()` → `onResize()`（重建所有窗口纹理 + `present()`）。
   `ensureTexture` 在尺寸未变时会提前返回且不出图，所以 `onResize` 末尾必须补一次
   `present()`，否则静止态改尺寸会一直显示被拉伸的旧画面。

   ⚠️ **DPR 不能用 `matchMedia('(resolution: Xdppx)')` 监听**：
   `devicePixelRatio` 常常是 `1.2000000476837158` 这类值，拼进媒体查询后永远不匹配，
   change 事件再也不会触发（实测 DPR 变化完全失灵）。现在用 500ms 轮询读数值。

## 当前能力边界

已实现：

- **行进轴只有 4 个**（上 / 下 / 左 / 右，见 `GENIE_DIRECTIONS`）。
  斜向方向（downLeft 等）刻意映射到最近的主轴，**只改变目标位置**、不旋转坐标系 ——
  真实 macOS 里漏斗永远沿屏幕主轴收窄，斜向只是图标在角落。
- **目标位置与行进轴解耦**：目标由 `targetRect` 决定，可以落任意位置，
  不限于八宫格上的 8 个点（为「Dock 有任意多个图标」留的余地）。
- **非全屏窗口**：窗口尺寸/位置与 canvas 解耦（`layoutWindow` 按 `windowMode` 布局），
  目标贴的是**画布（屏幕）边缘**，不是窗口边缘。
- **多窗口**：Notes + Calculator，各自独立的纹理 / uniform / 最小化状态，
  点 Dock 图标还原自己那个窗口。
- **窗口可交互**：拖标题栏移动、拖右下角缩放、三个交通灯（关 / 最小化 / 最大化）。
- **菜单栏 + Dock 都在 canvas 外面**：它们不参与 genie 形变，也不会被捕获进窗口纹理。
- **全屏 = visible frame**：macOS 的全屏不铺满屏幕，菜单栏和 Dock 常驻；
  `visibleFrame()` 同时约束拖拽、缩放、绿灯最大化，窗口永远盖不住这两条栏。
- 内容压缩进漏斗，终点落成图标大小并留在屏幕上。
- 两段动画重叠 0.1（曲线 0→0.5，位移 0.4→1）。
- 左右不对称收缩、DPR / 窗口尺寸跟随、真实 DOM 交互（静止态）、手动进度拖动。
- 动画循环带 `setTimeout` 兜底：rAF 被节流/暂停时仍会推进。

已实现的反向动画：点 Dock 图标还原时，把 `playhead` 从 1 倒放到 0，
同一套 shader 自然反向播放（不需要单独的还原公式）。

未实现（不要在本项目里假设其存在）：

- 与真实系统 Dock 联动：图标位置由页面内的 Dock 决定，
  勾「非对称目标」可把目标改成按方向贴画布边缘。
- CPU 侧网格顶点数组（`computeGenieMesh` / `createGridTemplate` 之类的 API 本项目没有）；
  `genie.ts` 只推导参数，形变仍在片元里完成。

## 多窗口架构的三个坑（都已踩过）

1. **纹理尺寸要在元素布局之后量**。`applyRect` 只写 style，而 `elementImageSize`
   读 `offsetWidth` —— 不强制一次 reflow 会拿到 800×600（画布尺寸），
   于是小窗口的纹理内容被拉成整个画布。`ensureTexture` 里先读一次
   `el.offsetWidth` 并用实测值兜底纠正。
2. **Dock 的 `data-dock` 与窗口 `name` 必须分开**。窗口显示名是 `"Notes"`，
   Dock 选择器的值是 `"notes"`，用同一个字段会导致目标解析永远失败
   （表现为「点黄灯却收了另一个窗口」）。现在分成 `dockId` / `name`。
3. **Dock 必须在画布范围内**。Dock 若挂在画布下方（`bottom: -72px`），
   目标点会跑到画布外，漏斗收进画布外面看不见。现在 Dock 浮在画布内底部。

## 非全屏窗口的三个坑（都已踩过）

1. **`layoutWindow` 不能用 `renderScale.cssW` 当基准**。resize 过程中它可能还没更新，
   会用旧尺寸把窗口设错（画布 800 而窗口 1100）。基准取 `canvas.getBoundingClientRect()`。
2. **canvas 需要 `contain: layout paint`**。窗口是 canvas 的子元素（`content="drawable"`），
   非全屏时窗口尺寸由 JS 写入，不隔离会反向撑大画布形成循环。
   ⚠️ 不能加 `size` —— 那会让 canvas 不再跟随 `width/height:100%` 重新布局，后备缓冲卡死。
3. **目标必须相对画布算**。旧实现拿 `windowRect` 推目标，窗口一小目标就跑到窗口边上；
   真实场景里 Dock 在屏幕边缘，与窗口大小无关。

## 常见问题

### 页面提示"需要支持 HTML-in-Canvas 的浏览器"

`isSupported` 检查 `canvas.requestPaint`，`supportsElementTexture` 检查 queue 上是否有
`drawElementImageToTexture` 或 `copyElementImageToTexture`。Chrome 155+ 默认可用；
135–154 需开 `chrome://flags/#canvas-draw-element`。

### 画面全黑但 DOM 正常

检查是否漏了 `COPY_DST`、是否在 `createTexture` 之后没上传、bind group 是否指向旧纹理视图。

### 点击位置和视觉位置对不上

先确认 `syncElementGeometry` 拿到的是物理像素除以 dpr 后的 CSS 矩形。
静止态（progress = 0）必须精确等于窗口矩形，测试脚本会检查这一点。
