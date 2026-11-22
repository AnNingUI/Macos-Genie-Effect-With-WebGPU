// Genie 片元着色器 —— 完全沿用最初版的形变数学，仅做坐标泛化。
//
// 最初版的公式（一字未改）：
//   left_curve_x  = A·sin(π·y - π/2) + D    （D = A = left_max/2）
//   right_curve_x = A·sin(π·y + π/2) + D    （D = (right_min+1)/2, A = 1-D）
//   left_max  = curve_progress · left_max_end
//   right_min = 1 - curve_progress · (1 - right_min_end)
//   transformed_uv_x = (uv.x - left_curve_x) / (right_curve_x - left_curve_x)
//   transformed_uv_y = uv.y - translation_progress
//   越界的像素 discard
//
// 泛化只有三处，都不改公式本身：
//   1. 输入 UV 由「整块画布」改为「窗口矩形」——顶点着色器已把 uv 设为窗口内 0..1
//   2. left_max_end / right_min_end 由目标宽度推导，不再写死
//   3. 位移终点由 targetX/targetY 给出，不再固定往画布底边
//
// ⚠️ Params 结构体与 `p` 绑定声明在 Genie.vertex.wgsl（同 module 不能重复声明）。

@group(0) @binding(1) var t : texture_2d<f32>;
@group(0) @binding(2) var s : sampler;

struct FSIn {
  @location(0) uv : vec2f,
};

@fragment
fn main_fragment(input : FSIn) -> @location(0) vec4f {
  let pi = 3.14159265359;

  // 1. 动画进度
  let total_curve = p.curveDuration;
  let total_translation = p.translationDuration;
  let total_animation = total_curve + total_translation;
  let clamped_time = clamp(p.time, 0.0, total_animation);

  // 2. 曲线阶段（上边收窄）
  let curve_progress = clamp(clamped_time / total_curve, 0.0, 1.0);

  // left_max_end / right_min_end 由 draw() 按目标宽度算好传入
  let left_max_end = (1.0 - p.targetWidth / max(p.rect.z, 1.0)) * 0.5;
  let right_min_end = 1.0 - left_max_end;

  let left_max = curve_progress * left_max_end;
  let right_min = 1.0 - curve_progress * (1.0 - right_min_end);

  let left_D = left_max / 2.0;
  let left_A = left_D;
  let left_curve_x = left_A * sin(pi * input.uv.y - pi * 0.5) + left_D;

  let right_D = (right_min + 1.0) / 2.0;
  let right_A = 1.0 - right_D;
  let right_curve_x = right_A * sin(pi * input.uv.y + pi * 0.5) + right_D;

  // 3. 位移阶段
  var translation_progress = 0.0;
  if (clamped_time > total_curve) {
    translation_progress = clamp((clamped_time - total_curve) / total_translation, 0.0, 1.0);
  }

  // 4. 重映射 UV.x
  var transformed_uv_x = input.uv.x;
  if (right_curve_x > left_curve_x) {
    transformed_uv_x = (input.uv.x - left_curve_x) / (right_curve_x - left_curve_x);
  } else {
    discard;
  }

  let transformed_uv_y = input.uv.y - translation_progress;
  let transformed_uv = vec2f(transformed_uv_x, transformed_uv_y);

  // 5. 裁剪
  if (input.uv.x < left_curve_x || input.uv.x > right_curve_x || transformed_uv_y < 0.0) {
    discard;
  }

  // 6. 采样
  return textureSample(t, s, transformed_uv);
}
