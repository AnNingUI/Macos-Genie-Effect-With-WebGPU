// 纯函数测试：uniform 布局 + 正向形变 + 可见包围盒。
//
// 直接 import src/genie.ts —— Node 22.6+/24 原生支持类型剥离，
// 不需要 esbuild 或任何构建步骤。
//
//   node scripts/genie-check.mjs
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMING,
  DOCK_EDGE_TO_DIRECTION,
  GENIE_DIRECTIONS,
  GENIE_UNIFORM_FLOATS,
  axisOf,
  computeGenieFrame,
  computeVisibleBounds,
  easeInOutQuad,
  packGenieUniforms,
} from '../src/genie.ts';

const cases = [];
const check = (name, fn) => {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (err) {
    cases.push({ name, ok: false, message: err.message });
  }
};

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// 基准场景：800×600 的窗口在画布 (0,0)，Dock 图标 48×48 贴在底边居中
const FROM = { x: 0, y: 0, w: 800, h: 600 };
const ICON = 48;
const TO_DOWN = { x: 400 - ICON / 2, y: 600 - 24 - ICON, w: ICON, h: ICON };

const base = (over = {}) => ({
  from: FROM,
  to: TO_DOWN,
  dir: GENIE_DIRECTIONS.down,
  progress: 0,
  animationDuration: 1,
  ...DEFAULT_TIMING,
  ...over,
});

// ---------------------------------------------------------------- uniform 布局
check('uniform 长度与 WGSL 的 24 个 float 一致', () => {
  assert.equal(GENIE_UNIFORM_FLOATS, 24);
  const out = packGenieUniforms({ ...base(), viewport: { width: 1600, height: 1200 } });
  assert.equal(out.length, GENIE_UNIFORM_FLOATS);
  assert.equal(out.byteLength, 96);
});

check('字段顺序：viewport / rect / target / quad / timing / dir', () => {
  const f = packGenieUniforms({ ...base({ progress: 0.5 }), viewport: { width: 1600, height: 900 } });
  assert.ok(near(f[0], 1600) && near(f[1], 900), 'viewport');
  assert.ok(near(f[2], 0) && near(f[3], 0), 'pad0');
  assert.ok(near(f[4], 0) && near(f[5], 0) && near(f[6], 800) && near(f[7], 600), 'rect');
  assert.ok(near(f[8], TO_DOWN.x) && near(f[9], TO_DOWN.y), 'target 位置');
  assert.ok(near(f[10], ICON) && near(f[11], ICON), 'target 尺寸');
  assert.ok(near(f[16], 0.5), 'time = progress × duration');
  assert.ok(near(f[17], 0.5) && near(f[18], 0.4) && near(f[19], 0.6), 'curve / transStart / transDur');
  assert.ok(near(f[20], 0) && near(f[21], 1), 'dir = down');
});

check('dir 的垂直方向是 (dir.y, -dir.x) 的符号一致版本', () => {
  const f = packGenieUniforms({ ...base(), viewport: { width: 800, height: 600 } });
  const dot = f[20] * f[22] + f[21] * f[23];
  assert.ok(near(dot, 0), 'dir 与 perp 正交');
  assert.ok(near(Math.hypot(f[22], f[23]), 1), 'perp 是单位向量');
});

// ---------------------------------------------------------------- 方向
check('dir 会自动校正为「指向目标」', () => {
  // 目标是向下的，却传了 up —— 应当被翻转回来
  const f = computeGenieFrame(base({ dir: GENIE_DIRECTIONS.up, progress: 0.5 }));
  assert.ok(near(f.dir.y, 1), 'dir 应被翻转为向下');
});

check('向上收缩：带子朝 y 变小的方向收', () => {
  const toUp = { x: 400 - ICON / 2, y: 24, w: ICON, h: ICON };
  const f0 = computeGenieFrame(base({ to: toUp, dir: GENIE_DIRECTIONS.up, progress: 0 }));
  const f1 = computeGenieFrame(base({ to: toUp, dir: GENIE_DIRECTIONS.up, progress: 1 }));
  assert.ok(near(f0.bandHi - f0.bandLo, 600), '起点跨度 = 窗口高度');
  const span = f1.bandHi - f1.bandLo;
  assert.ok(near(span, ICON, 1e-6), `终点跨度应 = 图标高度，实际 ${span}`);
});

// ---------------------------------------------------------------- 方向 = Dock 边
check('只有 4 个方向，且每个都是单位向量', () => {
  const keys = Object.keys(GENIE_DIRECTIONS);
  assert.equal(keys.length, 4, '方向应只有 4 个');
  assert.deepEqual(keys.sort(), ['down', 'left', 'right', 'up']);
  for (const [name, v] of Object.entries(GENIE_DIRECTIONS)) {
    assert.ok(near(Math.hypot(v.x, v.y), 1, 1e-9), name + ' 不是单位向量');
  }
});

check('Dock 边 → 方向 的映射完整且正确', () => {
  assert.equal(DOCK_EDGE_TO_DIRECTION.bottom, 'down');
  assert.equal(DOCK_EDGE_TO_DIRECTION.top, 'up');
  assert.equal(DOCK_EDGE_TO_DIRECTION.left, 'left');
  assert.equal(DOCK_EDGE_TO_DIRECTION.right, 'right');
  // 四条边都要有映射
  assert.equal(Object.keys(DOCK_EDGE_TO_DIRECTION).length, 4);
});

check('四个方向的终点都精确落在各自目标矩形上', () => {
  const targets = {
    down: { x: 376, y: 528, w: ICON, h: ICON },
    up: { x: 376, y: 24, w: ICON, h: ICON },
    left: { x: 24, y: 276, w: ICON, h: ICON },
    right: { x: 728, y: 276, w: ICON, h: ICON },
  };
  for (const [dir, to] of Object.entries(targets)) {
    const b = computeVisibleBounds(base({ to, dir: GENIE_DIRECTIONS[dir], progress: 1 }));
    assert.deepEqual(b, to, dir + ' 的终点包围盒应精确等于目标');
  }
});

check('顶部 Dock：带子朝 y 变小的方向收（up）', () => {
  const toTop = { x: 400 - ICON / 2, y: 24, w: ICON, h: ICON };
  const f0 = computeGenieFrame(base({ to: toTop, dir: GENIE_DIRECTIONS.up, progress: 0 }));
  const f1 = computeGenieFrame(base({ to: toTop, dir: GENIE_DIRECTIONS.up, progress: 1 }));
  assert.ok(near(f0.bandHi - f0.bandLo, 600), '起点跨度 = 窗口高度');
  assert.ok(near(f1.bandHi - f1.bandLo, ICON, 1e-6), '终点跨度 = 图标尺寸');
});

check('左侧 Dock：带子朝 x 变小的方向收（left）', () => {
  const toLeft = { x: 24, y: 300 - ICON / 2, w: ICON, h: ICON };
  const f1 = computeGenieFrame(base({ to: toLeft, dir: GENIE_DIRECTIONS.left, progress: 1 }));
  assert.ok(near(f1.bandHi - f1.bandLo, ICON, 1e-6), '终点跨度 = 图标尺寸');
});

check('右侧 Dock：带子朝 x 变大的方向收（right）', () => {
  const toRight = { x: 800 - 24 - ICON, y: 300 - ICON / 2, w: ICON, h: ICON };
  const f1 = computeGenieFrame(base({ to: toRight, dir: GENIE_DIRECTIONS.right, progress: 1 }));
  assert.ok(near(f1.bandHi - f1.bandLo, ICON, 1e-6), '终点跨度 = 图标尺寸');
});

// ---------------------------------------------------------------- 非全屏窗口
check('非全屏窗口：目标贴画布边缘而不是窗口边缘', () => {
  // 窗口居中且比画布小
  const from = { x: 112, y: 84, w: 576, h: 432 };
  const canvasW = 800;
  const canvasH = 600;
  const icon = 48;
  // 目标贴画布底边（y = 600 - 24 - 48 = 528），而不是窗口底边（84+432=516）
  const to = { x: canvasW / 2 - icon / 2, y: canvasH - 24 - icon, w: icon, h: icon };
  const b = computeVisibleBounds(base({ from, to, progress: 1 }));
  assert.deepEqual(b, to, '终点应等于目标矩形');
  assert.ok(to.y > 516, '目标应落在窗口底边之下（贴画布底边）');
});

check('非全屏窗口：起点包围盒等于窗口本身，不是整块画布', () => {
  const from = { x: 112, y: 84, w: 576, h: 432 };
  const b = computeVisibleBounds(base({ from, progress: 0 }));
  assert.deepEqual(b, from);
});

check('非全屏窗口：中间态不越出 源∪目标 的范围', () => {
  const from = { x: 112, y: 84, w: 576, h: 432 };
  const to = { x: 376, y: 528, w: ICON, h: ICON };
  const u = {
    x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    r: Math.max(from.x + from.w, to.x + to.w),
    b: Math.max(from.y + from.h, to.y + to.h),
  };
  for (let i = 1; i < 20; i++) {
    const b = computeVisibleBounds(base({ from, to, progress: i / 20 }));
    assert.ok(b.x >= u.x - 2 && b.x + b.w <= u.r + 2, `p=${i / 20} 横向越界`);
    assert.ok(b.y >= u.y - 2 && b.y + b.h <= u.b + 2, `p=${i / 20} 纵向越界`);
  }
});

check('向右收缩：沿 x 方向，带子横向收窄', () => {
  const toRight = { x: 800 - 24 - ICON, y: 300 - ICON / 2, w: ICON, h: ICON };
  const f1 = computeGenieFrame(base({ to: toRight, dir: GENIE_DIRECTIONS.right, progress: 1 }));
  assert.ok(f1.bandLo >= 800 - 24 - ICON - 1 && f1.bandHi <= 800 - 24 + 1, '终点贴右边');
});

// ---------------------------------------------------------------- 行进带
check('起点：行进带等于源窗口的完整跨度', () => {
  const f = computeGenieFrame(base({ progress: 0 }));
  assert.ok(near(f.bandLo, 0), 'bandLo');
  assert.ok(near(f.bandHi, 600), 'bandHi');
});

check('终点：行进带等于目标矩形的跨度（不会被压成 0）', () => {
  const f = computeGenieFrame(base({ progress: 1 }));
  const span = f.bandHi - f.bandLo;
  assert.ok(span > 0, '终点跨度必须为正 —— 这是与旧实现的关键区别');
  assert.ok(near(span, ICON, 1e-6), `跨度应等于图标高度 ${ICON}，实际 ${span}`);
});

check('位移阶段带子单调变短', () => {
  let prev = Infinity;
  for (let i = 0; i <= 20; i++) {
    const f = computeGenieFrame(base({ progress: 0.4 + (0.6 * i) / 20 }));
    const span = f.bandHi - f.bandLo;
    assert.ok(span <= prev + 1e-6, `进度 ${0.4 + (0.6 * i) / 20} 时跨度反而变大了`);
    prev = span;
  }
});

check('两段动画重叠：0.4~0.5 之间曲线和位移同时在动', () => {
  const f = computeGenieFrame(base({ progress: 0.45 }));
  assert.ok(f.slide > 0 && f.slide < 1, `slide=${f.slide} 应处于曲线阶段中间`);
  assert.ok(f.trans > 0 && f.trans < 1, `trans=${f.trans} 应已开始位移`);
});

check('曲线在 curvePortion 处结束，位移在 translationStart 处开始', () => {
  const before = computeGenieFrame(base({ progress: 0.35 }));
  const after = computeGenieFrame(base({ progress: 0.55 }));
  assert.ok(before.slide < 1, '0.35 时曲线未完成');
  assert.ok(after.slide === 1, '0.55 时曲线已完成');
  assert.ok(before.trans === 0, '0.35 时位移尚未开始');
  assert.ok(after.trans > 0, '0.55 时位移已开始');
});

// ---------------------------------------------------------------- 曲线形状
check('easeInOutQuad 端点与中点正确', () => {
  assert.ok(near(easeInOutQuad(0), 0));
  assert.ok(near(easeInOutQuad(0.5), 0.5));
  assert.ok(near(easeInOutQuad(1), 1));
});

check('远离目标的一侧保持满宽（漏斗的宽口）', () => {
  // 向下收缩时 dir=(0,1)，远离目标 = along 小的一端 = 屏幕上方 = 窗口顶边
  const f = computeGenieFrame(base({ progress: 0.5 }));
  // 源矩形远离目标的那个端点：此处 ease(1)=1，没有任何收窄
  const ext = rowSpan(f, f.fromALo);
  assert.ok(near(ext, 800, 1), `宽口应保持 800，实际 ${ext}`);
});

check('窄口收拢到图标宽度：终点整条带子都等于图标宽度', () => {
  const f = computeGenieFrame(base({ progress: 1 }));
  // 终点 slide=1，所有行都已插值到目标跨度，任何一行都应是图标宽度
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const along = f.bandLo + (f.bandHi - f.bandLo) * frac;
    const ext = rowSpan(f, along);
    assert.ok(near(ext, ICON, 0.5), `终点 frac=${frac} 行宽应 = ${ICON}，实际 ${ext}`);
  }
});

// 取某一行在 perp 方向的宽度
function rowSpan(f, alongA) {
  const span = f.fromALo - f.toALo;
  const t = Math.abs(span) < 1e-6 ? 1 : Math.min(1, Math.max(0, (alongA - f.toALo) / span));
  const e = easeInOutQuad(t);
  const lo = f.fromPLo + (f.toPLo - f.fromPLo) * f.slide;
  const hi = f.fromPHi + (f.toPHi - f.fromPHi) * f.slide;
  const rowLo = lo + (f.fromPLo - lo) * e;
  const rowHi = hi + (f.fromPHi - hi) * e;
  return rowHi - rowLo;
}

// ---------------------------------------------------------------- 可见包围盒
check('进度 0：包围盒精确等于窗口矩形', () => {
  const b = computeVisibleBounds(base({ progress: 0 }));
  assert.deepEqual(b, FROM);
});

check('进度 1：包围盒精确等于目标矩形', () => {
  const b = computeVisibleBounds(base({ progress: 1 }));
  assert.deepEqual(b, TO_DOWN);
});

check('中间态包围盒非空且不超出源与目标的并集', () => {
  const union = {
    x: Math.min(FROM.x, TO_DOWN.x),
    y: Math.min(FROM.y, TO_DOWN.y),
    r: Math.max(FROM.x + FROM.w, TO_DOWN.x + TO_DOWN.w),
    b: Math.max(FROM.y + FROM.h, TO_DOWN.y + TO_DOWN.h),
  };
  for (let i = 1; i < 20; i++) {
    const b = computeVisibleBounds(base({ progress: i / 20 }));
    assert.ok(b.w > 0 && b.h > 0, `进度 ${i / 20} 包围盒为空`);
    assert.ok(b.x >= union.x - 2 && b.x + b.w <= union.r + 2, '横向越界');
    assert.ok(b.y >= union.y - 2 && b.y + b.h <= union.b + 2, '纵向越界');
  }
});

check('包围盒单调收缩（位移阶段）', () => {
  let prev = Infinity;
  for (let i = 0; i <= 10; i++) {
    const b = computeVisibleBounds(base({ progress: 0.4 + 0.06 * i }));
    assert.ok(b.h <= prev + 2, '高度应单调减小');
    prev = b.h;
  }
});

check('越界进度被夹住，不抛错也不返回负数', () => {
  assert.deepEqual(computeVisibleBounds(base({ progress: -5 })), FROM);
  assert.deepEqual(computeVisibleBounds(base({ progress: 5 })), TO_DOWN);
});

check('复用同一个 Float32Array，不额外分配', () => {
  const scratch = new Float32Array(GENIE_UNIFORM_FLOATS);
  const got = packGenieUniforms({ ...base(), viewport: { width: 1, height: 1 } }, scratch);
  assert.equal(got, scratch);
});


// ---------------------------------------------------------------- 输出
const width = Math.max(...cases.map((c) => c.name.length));
for (const c of cases) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(width)}${c.ok ? '' : '  → ' + c.message}`);
}
const failed = cases.filter((c) => !c.ok).length;
console.log(`\n${cases.length - failed} / ${cases.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
