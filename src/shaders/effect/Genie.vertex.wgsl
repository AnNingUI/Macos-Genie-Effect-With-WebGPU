// 顶点着色器：把窗口矩形铺成两个三角形，并把 UV 传给片元。
//
// 与最初版 Genie 的分工一致 —— 几何只是"一个盖住窗口的四边形"，
// 所有形变都在片元里做 UV 重映射（这样才能逐像素得到光滑曲线）。
//
// ⚠️ 本文件与 Genie.fragment.wgsl 拼成同一 module，
//    Params 结构体与 uniform 绑定只能声明一次。

struct Params {
  viewport : vec2f,      // 画布后备缓冲尺寸（物理像素）
  _pad0 : vec2f,
  rect : vec4f,          // 窗口矩形（物理像素）x,y,w,h
  time : f32,            // 动画时间（秒）
  curveDuration : f32,   // 曲线阶段时长（秒）
  translationDuration : f32, // 位移阶段时长（秒）
  targetX : f32,         // 目标中心 X（物理像素）
  targetY : f32,         // 目标中心 Y（物理像素）
  targetWidth : f32,     // 收缩后宽度（物理像素）
  _pad1 : vec2f,
};

@group(0) @binding(0) var<uniform> p : Params;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,   // 窗口内归一化 UV（y 向下）
};

@vertex
fn main_vertex(@builtin(vertex_index) vi : u32) -> VSOut {
  // 两个三角形拼成一个矩形，UV 与最初版一致：(0,0) 左上
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
  );

  let c = corners[vi];
  let px = p.rect.x + c.x * p.rect.z;
  let py = p.rect.y + c.y * p.rect.w;

  var out : VSOut;
  let xNdc = (px / p.viewport.x) * 2.0 - 1.0;
  let yNdc = 1.0 - (py / p.viewport.y) * 2.0;
  out.pos = vec4f(xNdc, yNdc, 0.0, 1.0);
  out.uv = c;
  return out;
}
