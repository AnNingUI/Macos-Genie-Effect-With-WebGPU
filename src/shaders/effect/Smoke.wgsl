// 关窗烟雾消散（移植自用户提供的 niri close_color）。
// 单四边形、逐像素 FBM：湍流位移 + 噪声溶解 + 边界烟絮 + 去饱和。
// 不再有粒子几何、粒子管线或 CPU 格子烘焙。
struct SmokeParams {
  viewport : vec2<f32>,  // [0..1] 画布后备缓冲，物理像素
  css : vec2<f32>,       // [2..3] 窗口 CSS 尺寸
  rect : vec4<f32>,      // [4..7] 窗口在画布里的物理像素矩形
  motion : vec4<f32>,    // [8..11] progress, randomSeed, 0, 0
  spare0 : vec4<f32>,
  spare1 : vec4<f32>,
  spare2 : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : SmokeParams;
@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var smp : sampler;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> VSOut {
  var q = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0)
  );
  let c = q[i];
  let px = u.rect.xy + c * u.rect.zw;
  var out : VSOut;
  out.position = vec4<f32>(
    (px.x / u.viewport.x) * 2.0 - 1.0,
    1.0 - (px.y / u.viewport.y) * 2.0,
    0.0, 1.0
  );
  out.uv = c;
  return out;
}

fn hash_noise(p : vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn value_noise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash_noise(i), hash_noise(i + vec2<f32>(1.0, 0.0)), f.x),
    mix(hash_noise(i + vec2<f32>(0.0, 1.0)), hash_noise(i + vec2<f32>(1.0, 1.0)), f.x),
    f.y
  );
}

fn fbm(p0 : vec2<f32>) -> f32 {
  var p = p0;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) {
    v += a * value_noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

@fragment
fn fs_main(input : VSOut) -> @location(0) vec4<f32> {
  let p = u.motion.x;
  let seed = u.motion.y;
  let uv = input.uv;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    discard;
  }

  // 烟雾位移：像素随湍流漂移，并整体向上（uv 的 y 向下，所以取负）。
  let turb = fbm(uv * 5.0 + vec2<f32>(p * 2.0, -p * 3.0)) - 0.5;
  let turb2 = fbm(uv * 3.0 + vec2<f32>(-p * 1.5, -p * 2.0) + seed) - 0.5;
  let driftX = turb * 0.15 * p * p;
  let driftY = -p * p * 0.2 + turb2 * 0.12 * p;
  let displaced = clamp(uv + vec2<f32>(driftX, driftY), vec2<f32>(0.0), vec2<f32>(1.0));

  var color = textureSample(src, smp, displaced);

  // 每个像素在自己的噪声阈值消失；p*1.2 保证结尾完全透明。
  let n = fbm(uv * 6.0 + seed * 3.0);
  let visible = 1.0 - smoothstep(n - 0.1, n + 0.1, p * 1.2);

  // 溶解边界上的烟絮。
  let edge = abs(p * 1.2 - n);
  let wisp = exp(-edge * edge * 100.0) * p;
  let smokeColor = vec3<f32>(0.55, 0.55, 0.6);
  color = vec4<f32>(mix(color.rgb, smokeColor, wisp * 0.7), color.a);

  // 消散过程中逐渐去饱和。
  let luma = dot(color.rgb, vec3<f32>(0.299, 0.587, 0.114));
  color = vec4<f32>(mix(color.rgb, vec3<f32>(luma), p * 0.3), color.a);

  // 捕获的纹理是 straight alpha；画到 premultiplied canvas 前手动预乘。
  let a = color.a * visible;
  return vec4<f32>(color.rgb * a, a);
}
