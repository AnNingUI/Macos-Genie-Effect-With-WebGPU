// Genie 形变的纯计算部分（不依赖 WebGPU，可单独测试）。
//
// 这里是 K.md（"Recreating the macOS Genie Effect"）那套网格形变的 CPU 镜像：
//
//   · 网格是 1 列 × N 行 —— 每行只做「沿行进方向的平移 + 垂直方向的贝塞尔收窄」
//   · 形变在片元着色器里以**逆映射**实现（逐像素反算纹理坐标），
//     但这里保存的是**正向**参数，命中区与测试都用它，保证 CPU/GPU 同源
//
// 行进方向用单位向量 dir 表示，perp = (-dir.y, dir.x) 是它的垂直方向。
// 所有几何都在 (along, across) 局部坐标系里计算，因此水平 / 垂直 / 斜向
// 共用同一套公式 —— 不再有「只支持向下」的特例。

/** 画布像素坐标下的矩形。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 二维向量。 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 收缩方向 —— 只有 4 个。
 *
 * 真实 macOS 里漏斗永远沿屏幕的一条主轴收窄，方向由 **Dock 停在哪条边** 决定：
 *   · Dock 在底部 / 顶部 → 窗口往上 / 下收
 *   · Dock 在左侧 / 右侧（GNOME 那种垂直 Dock）→ 窗口往左 / 右收
 *
 * 所以这里不需要斜向，也不需要用户手选方向 —— 方向是 Dock 位置的函数。
 */
export type GenieDirection = 'down' | 'up' | 'left' | 'right';

/** Dock 停靠的边（对应上面 4 个方向）。 */
export type DockEdge = 'bottom' | 'top' | 'left' | 'right';

/** 每个方向的**行进轴**（单位向量，画布坐标系 y 向下）。 */
const DOWN: Vec2 = { x: 0, y: 1 };
const UP: Vec2 = { x: 0, y: -1 };
const LEFT: Vec2 = { x: -1, y: 0 };
const RIGHT: Vec2 = { x: 1, y: 0 };

export const GENIE_DIRECTIONS: Record<GenieDirection, Vec2> = {
  down: DOWN,
  up: UP,
  left: LEFT,
  right: RIGHT,
};

/** Dock 边 → 行进方向。这是唯一的映射来源。 */
export const DOCK_EDGE_TO_DIRECTION: Record<DockEdge, GenieDirection> = {
  bottom: 'down',
  top: 'up',
  left: 'left',
  right: 'right',
};

/** 方向 → 行进主轴（4 个之一，即方向本身）。保留此函数便于外部代码/测试表达意图。 */
export type GenieAxis = GenieDirection;

export function axisOf(dir: GenieDirection): GenieAxis {
  return dir;
}

/**
 * uniform 的 float 数，布局见 shaders/effect/Genie.vertex.wgsl 的 Params：
 *
 *   [0..1]    viewport    画布后备缓冲尺寸（物理像素）
 *   [2..3]    _pad0       对齐填充
 *   [4..7]    rect        源窗口矩形 x, y, w, h（物理像素）
 *   [8..11]   target      目标矩形（Dock 图标位置与尺寸，物理像素）
 *   [12..15]  quad        绘制四边形（源与目标的并集，物理像素）
 *   [16..19]  timing      time, curveDuration, translationStart, translationDuration
 *   [20..23]  dir         行进方向 xy + 垂直方向 xy
 *
 * 合计 24 个 float = 96 字节。
 */
export const GENIE_UNIFORM_FLOATS = 24;

/** 两个阶段的时间参数（都是总时长的比例，0..1）。 */
export interface GenieTiming {
  /** 曲线（收窄）阶段结束时刻。K.md 取 0.5 */
  curvePortion: number;
  /** 位移阶段开始时刻。K.md 取 0.4 —— 比曲线结束更早，两段重叠 */
  translationStart: number;
}

export const DEFAULT_TIMING: GenieTiming = { curvePortion: 0.5, translationStart: 0.4 };

export interface GenieInput extends GenieTiming {
  /** 源窗口矩形（画布像素）。 */
  from: Rect;
  /** 目标矩形：Dock 图标位置与尺寸（画布像素）。 */
  to: Rect;
  /** 行进方向（会按 from→to 的实际朝向自动校正正负）。 */
  dir: Vec2;
  /** 动画进度 0..1。 */
  progress: number;
  /** 动画总时长（秒）。 */
  animationDuration: number;
}

/** 一帧的全部正向形变参数，CPU 与 GPU 共用同一套推导。 */
export interface GenieFrame {
  /** 校正后的行进方向（总是指向目标）。 */
  dir: Vec2;
  /** 垂直于 dir 的方向。 */
  perp: Vec2;
  /** 源 / 目标矩形在 dir 与 perp 上的投影区间。 */
  fromALo: number;
  fromAHi: number;
  toALo: number;
  toAHi: number;
  fromPLo: number;
  fromPHi: number;
  toPLo: number;
  toPHi: number;
  /** 当前帧行进带的两端（已排序，bandLo <= bandHi）。 */
  bandLo: number;
  bandHi: number;
  /** 曲线进度与位移进度。 */
  slide: number;
  trans: number;
  /** 时间字段（秒）。 */
  time: number;
  curveDuration: number;
  translationStartTime: number;
  translationDuration: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 二次缓入缓出，与 K.md 的 quadraticEaseInOut 一致。 */
export function easeInOutQuad(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) ** 2) / 2;
}

/** 矩形四角在给定方向上的投影区间。 */
function projectRect(r: Rect, axis: Vec2): { lo: number; hi: number } {
  const xs = [r.x, r.x + r.w];
  const ys = [r.y, r.y + r.h];
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    for (const y of ys) {
      const v = x * axis.x + y * axis.y;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return { lo, hi };
}

/** 两个矩形的并集。 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}

/**
 * 推导某一帧的全部形变参数（与片元着色器逐行对应）。
 *
 * 行进带（K.md 的做法）：
 *   `far  = fromALo + trans·(toALo − fromALo)`   —— 远端自由平移
 *   `near = min(fromAHi + 同一段位移, toAHi)`   —— 近端跟走但不越过目标
 * 这样内容被**压缩**进逐渐变短的带子，而不是被裁掉。
 */
export function computeGenieFrame(input: GenieInput): GenieFrame {
  const { from, to } = input;
  const p = clamp01(input.progress);
  const curvePortion = Math.min(1, Math.max(1e-4, input.curvePortion));
  const transStart = Math.min(1, Math.max(0, input.translationStart));
  const duration = Math.max(input.animationDuration, 1e-6);

  const time = p * duration;
  const curveDuration = duration * curvePortion;
  const translationStartTime = duration * transStart;
  const translationDuration = Math.max(duration - translationStartTime, 1e-6);

  const slide = clamp01(time / curveDuration);
  const trans = clamp01((time - translationStartTime) / translationDuration);

  // 方向按 from→to 的实际朝向校正（保证 dir 永远指向目标）
  const fromC = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toC = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const len = Math.hypot(input.dir.x, input.dir.y) || 1;
  let dir = { x: input.dir.x / len, y: input.dir.y / len };
  if (dir.x * (toC.x - fromC.x) + dir.y * (toC.y - fromC.y) < 0) {
    dir = { x: -dir.x, y: -dir.y };
  }
  const perp = { x: -dir.y, y: dir.x };

  const fa = projectRect(from, dir);
  const ta = projectRect(to, dir);
  const fp = projectRect(from, perp);
  const tp = projectRect(to, perp);

  // 两端分别朝各自的目标端插值 —— 带子单调收缩，终点精确落在目标跨度上。
  // （K.md 用「共享 translation + clamp 近端」，在 from 与 to 的端点重合时与这里等价；
  //   两端各自插值对一般情况都成立，不会在 trans=0 时就把近端夹到目标。）
  const farA = fa.lo + trans * (ta.lo - fa.lo);
  const nearA = fa.hi + trans * (ta.hi - fa.hi);

  return {
    dir, perp,
    fromALo: fa.lo, fromAHi: fa.hi,
    toALo: ta.lo, toAHi: ta.hi,
    fromPLo: fp.lo, fromPHi: fp.hi,
    toPLo: tp.lo, toPHi: tp.hi,
    bandLo: Math.min(farA, nearA),
    bandHi: Math.max(farA, nearA),
    slide, trans,
    time, curveDuration, translationStartTime, translationDuration,
  };
}

/**
 * 某一行的两侧边距（perp 方向），与片元着色器逐字对应。
 * @param alongA 该行在 dir 上的坐标
 */
export function rowExtents(f: GenieFrame, alongA: number): { lo: number; hi: number } {
  const span = f.fromALo - f.toALo;
  const t = Math.abs(span) < 1e-6 ? 1 : clamp01((alongA - f.toALo) / span);
  const e = easeInOutQuad(t);
  return {
    lo: mix(mix(f.fromPLo, f.toPLo, f.slide), f.fromPLo, e),
    hi: mix(mix(f.fromPHi, f.toPHi, f.slide), f.fromPHi, e),
  };
}

/**
 * 把参数打包成 uniform。传入 `out` 可复用同一个 Float32Array，避免每帧分配。
 */
export function packGenieUniforms(
  input: GenieInput & { viewport: { width: number; height: number } },
  out: Float32Array = new Float32Array(GENIE_UNIFORM_FLOATS),
): Float32Array {
  const f = computeGenieFrame(input);
  // 绘制四边形取源与目标的并集（形变可能超出源矩形），再留 2px 余量
  const u = unionRect(input.from, input.to);

  out[0] = input.viewport.width;
  out[1] = input.viewport.height;
  out[2] = 0;
  out[3] = 0;
  out[4] = input.from.x;
  out[5] = input.from.y;
  out[6] = input.from.w;
  out[7] = input.from.h;
  out[8] = input.to.x;
  out[9] = input.to.y;
  out[10] = input.to.w;
  out[11] = input.to.h;
  out[12] = u.x - 2;
  out[13] = u.y - 2;
  out[14] = u.w + 4;
  out[15] = u.h + 4;
  out[16] = f.time;
  out[17] = f.curveDuration;
  out[18] = f.translationStartTime;
  out[19] = f.translationDuration;
  out[20] = f.dir.x;
  out[21] = f.dir.y;
  out[22] = f.perp.x;
  out[23] = f.perp.y;
  return out;
}

/**
 * 形变后的可见包围盒（画布像素）。
 *
 * 与片元着色器用同一套正向公式采样若干行后取包围盒：这个模型是「压缩 + 贝塞尔收窄」，
 * 不再是旧版的「整块下滑 + 裁掉」，采样比解析解更直观，也更容易和着色器保持一致。
 */
export function computeVisibleBounds(input: GenieInput, samples = 24): Rect {
  const p = clamp01(input.progress);
  if (p <= 0) return { ...input.from };
  if (p >= 1) return { ...input.to };

  const f = computeGenieFrame({ ...input, progress: p });
  const N = Math.max(2, samples);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const emit = (a: number, across: number): void => {
    const x = f.dir.x * a + f.perp.x * across;
    const y = f.dir.y * a + f.perp.y * across;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (let i = 0; i <= N; i++) {
    const alongA = mix(f.bandLo, f.bandHi, i / N);
    const ext = rowExtents(f, alongA);
    emit(alongA, ext.lo);
    emit(alongA, ext.hi);
  }

  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}
