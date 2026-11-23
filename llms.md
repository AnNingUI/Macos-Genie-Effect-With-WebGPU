# Genie Effect 实现原理

> 参考：
> - [细说如何完美实现 macOS 中的神奇效果](https://daniate.github.io/2021/07/27/%E7%BB%86%E8%AF%B4%E5%A6%82%E4%BD%95%E5%AE%8C%E7%BE%8E%E5%AE%9E%E7%8E%B0macOS%E4%B8%AD%E7%9A%84%E7%A5%9E%E5%A5%87%E6%95%88%E6%9E%9C/)
> - K.md（mesh transform 与 SpriteKit 视角的综述）
>
> 本文只描述**本仓库实际实现**的部分。文末单列了未实现的内容。

## 1. 效果分解

macOS 的窗口最小化大致分两步：

1. **曲线阶段**：窗口两侧向内收，形成漏斗。
2. **位移阶段**：整条内容被压缩着流向图标，最终落成图标大小。

本项目把真实 DOM 快照成纹理，然后在一个覆盖「源 ∪ 目标」的四边形上逐像素逆向映射 UV
—— 曲线因此是逐像素精确的，不需要细分网格。

方向可以是**八个方向中的任意一个**，目标矩形决定往哪收、收到哪里。

## 2. 坐标系

| 概念 | 单位 | 说明 |
|---|---|---|
| CSS 像素 | CSS px | 布局与 `updateElementGeometry` 使用 |
| 物理像素 | device px | canvas 后备缓冲、uniform、shader 使用 |
| UV | 0..1 | 窗口内归一化，原点左上，y 向下 |

转换只有一处：`renderScale.dpr = devicePixelRatio`，`toPx(v) = v * dpr`。
顶点着色器把物理像素转成 NDC：

```wgsl
xNdc = (px / viewport.x) * 2.0 - 1.0;
yNdc = 1.0 - (py / viewport.y) * 2.0;   // y 向下 → 翻转
```

## 3. 局部坐标系与曲线公式

行进方向是单位向量 `dir`，垂直方向 `perp = (-dir.y, dir.x)`。所有几何都在
`(along, across)` 里算：`a = dot(p, dir)`、`c = dot(p, perp)`。

### 关键：行进轴只有 4 个

`dir` 的取值只有 上 / 下 / 左 / 右 四个。斜向方向（`downLeft` 等）映射到最近的
主轴，**不旋转坐标系**：

```
downLeft  → dir = (0, 1)    // 同 down，只是目标 x 在左边
downRight → dir = (0, 1)    // 同 down，只是目标 x 在右边
upLeft    → dir = (0, -1)   // 同 up
```

真实 macOS 里漏斗永远沿屏幕的一条主轴收窄 —— 图标在角落不代表窗口斜着旋转。
如果把 `dir` 设成 45°，整块窗口会绕对角线扭曲，那是错的。

因此**目标位置与行进轴完全解耦**：目标可以落在任意位置（`targetRect`），
为「Dock 有任意多个图标」留余地，不限于八宫格的 8 个点。

源 / 目标矩形投影到这两个轴上，各得两个区间：`fromALo..fromAHi`、`toALo..toAHi`、
`fromPLo..fromPHi`、`toPLo..toPHi`。

### 坐标系基准是画布（屏幕），不是窗口

窗口可以非全屏（比画布小），此时**目标仍贴画布边缘** —— 因为 Dock 在屏幕边上，
与窗口大小无关。窗口与画布的相对关系由 `layoutWindow()` 按 `windowMode` 决定，
`genie.ts` 只关心「源矩形」和「目标矩形」两个绝对矩形，不关心窗口是否全屏。

### 行进带（位移阶段）

两端分别朝各自的目标端插值：

```
farA  = fromALo + trans · (toALo - fromALo)
nearA = fromAHi + trans · (toAHi - fromAHi)
bandLo = min(farA, nearA)   bandHi = max(farA, nearA)
```

K.md 用的是「共享 translation + 近端 clamp」，在 from / to 的端点重合时与这里等价；
两端各自插值对一般情况都成立，且 `trans = 0` 时不会误夹。

### 每行的两侧边距（曲线阶段）

```
e  = easeInOutQuad((a - toALo) / (fromALo - toALo))     // 0=靠目标, 1=远离目标
e  = e < 0.5 ? 2e² : 1 - (-2e+2)²/2

lo = mix( mix(fromPLo, toPLo, slide), fromPLo, e )
hi = mix( mix(fromPHi, toPHi, slide), fromPHi, e )
```

两个 `mix` 的嵌套是关键：内层按 `slide` 把两侧向目标收拢，外层按 `e` 把**远离目标**
的那一端拉回原位置 —— 于是靠近目标的一端已经收窄、远离目标的一端保持满宽，
轮廓就是漏斗。

## 4. 进度参数

```
slide = clamp(t / curveDuration, 0, 1)              // 曲线阶段：0 → 0.5
trans = clamp((t - transStart) / transDuration, 0, 1) // 位移阶段：0.4 → 1
```

`curvePortion = 0.5`、`translationStart = 0.4`（都是总时长的比例）。
**两段在 0.4 ~ 0.5 重叠 0.1**，这是 K.md 里「液体流过漏斗」连贯感的来源；
旧实现是严格串行（曲线跑完才位移），比现在生硬。

## 5. 压缩而非裁剪

这是与旧实现最本质的差异。片元把屏幕像素映射回源矩形：

```wgsl
acrossNorm = (c - rowLo) / (rowHi - rowLo)
alongNorm  = (a - bandLo) / (bandHi - bandLo)
srcAlong   = fromALo + alongNorm * (fromAHi - fromALo)
srcAcross  = fromPLo + acrossNorm * (fromPHi - fromPLo)
srcPx      = dir * srcAlong + perp * srcAcross
uv         = (srcPx - rect.xy) / rect.zw
```

因为 `alongNorm` 是**归一化到当前带**的，带宽变短时整条内容被压进去，
而不是被裁掉。于是：

- 进度 1 时可见区域 = 目标矩形（Dock 图标大小），**窗口仍然可见**
- 旧实现是 `uv.y' = uv.y - tp` + discard，进度 1 时高度为 0，窗口完全消失

超出源矩形 UV 的像素（浮点误差导致）仍然 `discard`，阈值放宽到 ±0.002。

## 6. uniform 布局

```
float index   field
[0..1]        viewport               画布后备缓冲（物理像素）
[2..3]        _pad0                  对齐填充
[4..7]        rect                   源窗口矩形 x, y, w, h
[8..11]       targetRect             目标矩形（Dock 图标位置与尺寸）
[12..15]      quad                   绘制四边形 = 源 ∪ 目标（外扩 2px）
[16..19]      timing                 time, curveDuration, translationStart, translationDuration
[20..23]      dir                    行进方向 xy + 垂直方向 xy
```

共 96 字节，CPU 侧由 `packGenieUniforms` 写入，测试脚本逐字段核对。

⚠️ `target` 与 `time` 是 **WGSL 保留字**，不能做结构体成员名（编译直接报错），
所以目标叫 `targetRect`、时间放在 `timing.x`。

## 7. 时间线

`animationDuration = 1.0s`，`curvePortion = 0.5`，`translationStart = 0.4`：

| t (s) | slide | trans | 视觉 |
|---|---|---|---|
| 0.000 | 0.00 | 0.00 | 原窗口 |
| 0.200 | 0.40 | 0.00 | 漏斗开始成形 |
| 0.400 | 0.80 | 0.00 | 收窄近尾声；**位移从此刻起跑** |
| 0.500 | 1.00 | 0.17 | 收窄完成，带子开始变短（重叠区结束） |
| 0.700 | 1.00 | 0.50 | 内容压到一半，整体流向图标 |
| 1.000 | 1.00 | 1.00 | 落成 Dock 图标大小，**仍在屏幕上** |

## 8. 移植到其它图形 API

需要移植的只有三件事：顶点变换、片元里的 UV 重映射、uniform 参数。注意差异：

- **NDC 的 y 方向**：WebGPU / Metal / DirectX 的 NDC y 向上，需要翻转。
- **纹理采样坐标系**：WebGPU / D3D / Metal 的 UV 原点在左上，OpenGL 在左下，需要翻转。
- **discard 的等价物**：GLSL / HLSL / MSL 都有 `discard`，行为一致。
- **uniform 对齐**：WGSL 的 `vec4f` 需 16 字节对齐；GLSL 的 `std140` 对 `vec2` 的填充规则不同，
  移植时必须重新核对偏移。

## 9. 未实现的部分

以下内容**不在**当前代码里，写在这里是为了避免误以为已经落地：

1. **与真实 Dock 联动**：演示里目标按方向贴边；勾「非对称目标」可模拟任意落点，
   但不会去读系统 Dock 的位置。
2. **反向动画**：只做最小化方向，没有「从图标还原」的那一套。
3. **CPU 侧网格顶点数组**：`genie.ts` 只推导参数，形变全部在片元里完成；
   仓库里不存在 `computeGenieMesh` / `createGridTemplate` 之类的接口。

