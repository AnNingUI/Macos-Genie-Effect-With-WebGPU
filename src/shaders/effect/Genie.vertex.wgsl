// 顶点着色器：把「源矩形 ∪ 目标矩形」的并集铺成两个三角形，并把画布像素坐标传给片元。
//
// 几何只是一个盖住并集的四边形，所有形变都在片元里做逐像素逆映射
// —— 这样才能逐像素得到光滑曲线，而不是靠细分网格逼近。
//
// ⚠️ 本文件与 Genie.fragment.wgsl 拼成同一个 module，
//    Params 结构体与 uniform 绑定只能声明一次。
//
// ⚠️ 字段不能用 target：它是 WGSL 保留字（编译直接报错）。

struct Params {
  viewport : vec2f,                 // 画布后备缓冲（物理像素）
  _pad0 : vec2f,                    // 填充到 16 字节
  rect : vec4f,                     // 源窗口矩形 x, y, w, h（物理像素）
  targetRect : vec4f,               // 目标矩形（Dock 图标）x, y, w, h
  quad : vec4f,                     // 绘制四边形 = 源 ∪ 目标，x, y, w, h
  timing : vec4f,                   // time, curveDuration, translationStart, translationDuration
  dir : vec4f,                      // 行进方向 xy，垂直方向 xy
};

@group(0) @binding(0) var<uniform> p : Params;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) canvasPx : vec2f,    // 画布像素坐标
};

@vertex
fn main_vertex(@builtin(vertex_index) vi : u32) -> VSOut {
  // 两个三角形拼成一个矩形，UV 原点在左上
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );

  let c = corners[vi];
  let px = p.quad.x + c.x * p.quad.z;
  let py = p.quad.y + c.y * p.quad.w;

  var out : VSOut;
  let xNdc = (px / p.viewport.x) * 2.0 - 1.0;
  let yNdc = 1.0 - (py / p.viewport.y) * 2.0;
  out.pos = vec4f(xNdc, yNdc, 0.0, 1.0);
  out.canvasPx = vec2f(px, py);
  return out;
}
