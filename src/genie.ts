// Genie 效果的公共定义 —— 类型与方向常量。
//
// 形变计算在 GPU 上完成（逐像素逆向映射，见 shaders/effect/Genie.fragment.wgsl），
// 这里只保留与渲染无关的共享定义，避免两份几何逻辑产生分歧。
//
// 若确实需要在 CPU 侧计算形变（例如做离线导出、或画布不支持 WebGPU 时的降级），
// 请复用同一套公式：分轴缩放 + 完整二维位移，且注意两个已踩过的坑：
//   1. 缩放比必须按 x / y 分轴算，不能按方向二选一（斜向会算错）
//   2. 位移植必须用完整二维向量，不能沿方向投影后再乘回（斜向会缩水）

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

/** 收缩方向描述。 */
export type GenieDirection =
  | 'down' | 'up' | 'left' | 'right'
  | 'downLeft' | 'downRight' | 'upLeft' | 'upRight';

const S = 0.7071067811865476;   // √2/2

/** 八个方向的单位向量（画布坐标系，y 向下）。 */
export const GENIE_DIRECTIONS: Record<GenieDirection, Vec2> = {
  down: { x: 0, y: 1 },
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  downLeft: { x: -S, y: S },
  downRight: { x: S, y: S },
  upLeft: { x: -S, y: -S },
  upRight: { x: S, y: -S },
};

/** 把方向向量归一化；零向量退化为向下。 */
export function normalizeDir(dir: Vec2): Vec2 {
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) return { x: 0, y: 1 };
  return { x: dir.x / len, y: dir.y / len };
}

/** 两个矩形的并集（用于求覆盖四边形）。 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(a.x + a.w, b.x + b.w);
  const bt = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: r - x, h: bt - y };
}
