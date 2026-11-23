// Genie 片元着色器：把 K.md 的网格形变写成逐像素**逆映射**。
//
// 正向模型（K.md / SKWarpGeometryGrid，1 列 × N 行）：
//   对每一行 along = a，两侧边距是
//     lo(a) = mix( mix(fromPLo, toPLo, slide), fromPLo, ease(t) )
//     hi(a) = mix( mix(fromPHi, toPHi, slide), fromPHi, ease(t) )
//   其中 t = (a - toALo) / (fromALo - toALo) 是「离目标远近」的归一化值。
//
// 片元要回答的是反问题：屏幕上这个像素该采样源纹理的哪个点？
//   1. 把 canvasPx 投影到 (dir, perp) 局部坐标系，得到 (a, c)
//   2. 若 a 落在当前带 [bandLo, bandHi] 之外 → discard
//   3. 由 a 反解 t，再算该行的 lo(a) / hi(a)
//   4. 若 c 落在 [lo, hi] 之外 → discard（漏斗外）
//   5. across / along 归一化后回查源矩形，得到纹理坐标
//
// 关键：内容是被**压缩**进逐渐变短的带子里的（K.md 网格形变的本质），
// 不再是旧实现的「整块下滑 + 裁掉顶部」。
//
// ⚠️ Params 结构体与 p 绑定声明在 Genie.vertex.wgsl（同 module 不能重复声明）。
// ⚠️ 局部变量不要用 time / target / sample 等名字：前两个是保留字，
//    后者会与 textureSample 的内置函数名混淆。
//
// timing.x = 当前时间（秒）
// timing.y = 曲线阶段时长（秒）
// timing.z = 位移阶段开始时刻（秒）
// timing.w = 位移阶段时长（秒）

@group(0) @binding(1) var t : texture_2d<f32>;
@group(0) @binding(2) var s : sampler;

struct FSIn {
  @location(0) canvasPx : vec2f,
};

// 二次缓入缓出，与 src/genie.ts 的 easeInOutQuad 逐字对应
fn easeInOutQuad(x : f32) -> f32 {
  let c = clamp(x, 0.0, 1.0);
  if (c < 0.5) {
    return 2.0 * c * c;
  }
  return 1.0 - pow(-2.0 * c + 2.0, 2.0) * 0.5;
}

@fragment
fn main_fragment(input : FSIn) -> @location(0) vec4f {
  let dir = p.dir.xy;
  let perp = p.dir.zw;

  let totalCurve = max(p.timing.y, 1e-5);
  let transStart = p.timing.z;
  let totalTrans = max(p.timing.w, 1e-5);

  let now = max(p.timing.x, 0.0);
  let slide = clamp(now / totalCurve, 0.0, 1.0);
  let trans = clamp((now - transStart) / totalTrans, 0.0, 1.0);

  // ---- 源 / 目标在局部坐标系下的投影 ----
  let fromC = p.rect.xy + p.rect.zw * 0.5;
  let toC = p.targetRect.xy + p.targetRect.zw * 0.5;

  let fromHalfA = abs(dir.x) * p.rect.z * 0.5 + abs(dir.y) * p.rect.w * 0.5;
  let toHalfA = abs(dir.x) * p.targetRect.z * 0.5 + abs(dir.y) * p.targetRect.w * 0.5;
  let fromHalfP = abs(perp.x) * p.rect.z * 0.5 + abs(perp.y) * p.rect.w * 0.5;
  let toHalfP = abs(perp.x) * p.targetRect.z * 0.5 + abs(perp.y) * p.targetRect.w * 0.5;

  let fromA = dot(fromC, dir);
  let toA = dot(toC, dir);
  let fromP = dot(fromC, perp);
  let toP = dot(toC, perp);

  let fromALo = fromA - fromHalfA;
  let fromAHi = fromA + fromHalfA;
  let toALo = toA - toHalfA;
  let toAHi = toA + toHalfA;
  let fromPLo = fromP - fromHalfP;
  let fromPHi = fromP + fromHalfP;
  let toPLo = toP - toHalfP;
  let toPHi = toP + toHalfP;

  // ---- 当前帧的行进带 ----
  // 两端分别朝各自的目标端插值 —— 带子单调收缩，终点精确落在目标跨度上。
  let farA = fromALo + trans * (toALo - fromALo);
  let nearA = fromAHi + trans * (toAHi - fromAHi);
  let bandLo = min(farA, nearA);
  let bandHi = max(farA, nearA);

  // ---- 当前像素落到局部坐标系 ----
  let a = dot(input.canvasPx, dir);
  let c = dot(input.canvasPx, perp);

  if (a < bandLo || a > bandHi) {
    discard;
  }

  // ---- 该行的两侧边距 ----
  let span = fromALo - toALo;
  var rowT = 1.0;
  if (abs(span) > 1e-6) {
    rowT = clamp((a - toALo) / span, 0.0, 1.0);
  }
  let e = easeInOutQuad(rowT);

  let rowLo = mix(mix(fromPLo, toPLo, slide), fromPLo, e);
  let rowHi = mix(mix(fromPHi, toPHi, slide), fromPHi, e);

  if (rowHi - rowLo <= 1e-4) {
    discard;
  }
  if (c < rowLo || c > rowHi) {
    discard;
  }

  // ---- 归一化回源矩形 → 纹理坐标 ----
  let acrossNorm = (c - rowLo) / (rowHi - rowLo);
  let alongNorm = (a - bandLo) / max(bandHi - bandLo, 1e-6);

  let srcAlong = fromALo + alongNorm * (fromAHi - fromALo);
  let srcAcross = fromPLo + acrossNorm * (fromPHi - fromPLo);

  // 换回画布坐标，再映射到纹理 UV
  let srcPx = dir * srcAlong + perp * srcAcross;
  let uv = (srcPx - p.rect.xy) / p.rect.zw;

  if (uv.x < -0.002 || uv.x > 1.002 || uv.y < -0.002 || uv.y > 1.002) {
    discard;
  }

  return textureSample(t, s, uv);
}
