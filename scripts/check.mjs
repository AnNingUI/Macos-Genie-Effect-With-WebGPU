// Genie 项目验证：
//   1. 页面是否成功渲染（截屏）
//   2. 真实 HTML 窗口的纹理是否被正确捕获（API 世代）
//   3. 是否存在 DOM 与 WebGPU 输出重影
//   4. 真实交互（点复选框、输入文字）是否可用
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TARGET = process.argv[2] || 'http://localhost:5201/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/** 截图输出目录：默认 ./shots，可用 GENIE_SHOTS 覆盖 */
const OUT = process.env.GENIE_SHOTS || 'shots';
const PORT = 9340;

await mkdir(OUT, { recursive: true });

const userDataDir = `${process.env.TEMP || '/tmp'}/cdp-genie-${Date.now()}`;
const chrome = spawn(CHROME, [
  '--window-position=60,40', '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
}
if (!wsUrl) { console.error('FAIL: no devtools'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map();
const events = [];
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const id = ++msgId;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find((t) => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: TARGET }, sessionId);
await sleep(7000);

const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const c = document.getElementById('webgpu-canvas');
    const w = document.getElementById('genie-window');
    const u = document.getElementById('unsupported');
    const nav = performance.getEntriesByType('navigation')[0];
    return JSON.stringify({
      hasCanvas: !!c,
      canvasW: c ? c.width : 0,
      canvasH: c ? c.height : 0,
      hasWindow: !!w,
      windowW: w ? w.offsetWidth : 0,
      windowH: w ? w.offsetHeight : 0,
      windowOpacity: w ? getComputedStyle(w).opacity : null,
      windowVisibility: w ? getComputedStyle(w).visibility : null,
      unsupportedVisible: u ? !u.hidden : null,
      unsupportedText: u && !u.hidden
        ? (document.getElementById('unsupported-detail')?.textContent || '') : '',
      hasRequestPaint: !!(c && c.requestPaint),
      hasDrawElement: typeof GPUQueue !== 'undefined'
        ? ('drawElementImageToTexture' in GPUQueue.prototype) : null,
      hasCopyElement: typeof GPUQueue !== 'undefined'
        ? ('copyElementImageToTexture' in GPUQueue.prototype) : null,
      hasGetSize: !!(c && c.getElementImageDefaultSize),
      hasUpdateGeom: !!(c && c.updateElementGeometry),
      info: document.getElementById('info')?.textContent || '',
    });
  })()`,
  returnByValue: true,
}, sessionId);

console.log('=== 页面状态 ===');
console.log(probe.result.value);

// 交互验证：点第一个未勾选的复选框
const before = await send('Runtime.evaluate', {
  expression: `(() => {
    const cbs = [...document.querySelectorAll('#genie-window input[type=checkbox]')];
    return JSON.stringify({ count: cbs.length, checked: cbs.map(c => c.checked) });
  })()`,
  returnByValue: true,
}, sessionId);

await send('Runtime.evaluate', {
  expression: `(() => {
    const cbs = [...document.querySelectorAll('#genie-window input[type=checkbox]')];
    cbs[1]?.click();
    return 'clicked';
  })()`,
  returnByValue: true,
}, sessionId);
await sleep(400);

const after = await send('Runtime.evaluate', {
  expression: `(() => {
    const cbs = [...document.querySelectorAll('#genie-window input[type=checkbox]')];
    return JSON.stringify({ checked: cbs.map(c => c.checked) });
  })()`,
  returnByValue: true,
}, sessionId);

console.log('=== 交互验证 ===');
console.log('before:', before.result.value);
console.log('after :', after.result.value);

// 静止态截屏（不点按钮）
await send('Runtime.evaluate', {
  expression: `document.getElementById('reset-btn')?.click()`,
  returnByValue: true,
}, sessionId);
await sleep(600);

const shotIdle = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
if (shotIdle?.data) {
  await writeFile(join(OUT, 'genie-idle.png'), Buffer.from(shotIdle.data, 'base64'));
  console.log('截图: genie-idle.png');
}

// 触发动画，在多个时间点截屏
await send('Runtime.evaluate', {
  expression: `document.getElementById('genie-btn')?.click()`,
  returnByValue: true,
}, sessionId);

for (const [name, delay] of [['genie-t250', 250], ['genie-t500', 250], ['genie-t900', 400]]) {
  await sleep(delay);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (shot?.data) {
    await writeFile(join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`截图: ${name}.png`);
  }
}

await sleep(900);

// ---------------------------------------------------------------- 回归断言

try {
  const failures = [];
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms: ' + label)), ms)),
  ]);
  const evaluate = async (expression) => {
    const r = await withTimeout(
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId),
      15000,
      expression.slice(0, 100),
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面内异常: ' + (d.exception?.description || d.text));
    }
    return r.result?.value;
  };
  const json = async (expr) => JSON.parse(await evaluate(expr));

  // ⑪ 红灯 = 烟雾消散：单管线、单四边形，无粒子几何
  const smoke = await json(`(async () => {
    const app = window.__app;
    app.resetAll();
    await new Promise(r => setTimeout(r, 500));
    const w = app.windows[1];
    const before = { pipeline: !!app.dissolvePipeline, hasDustBuffer: 'dustVertices' in w };
    // 手动驱动一帧，避免后台标签页 rAF 节流影响验证
    w.state.dissolve = 0.45;
    app.present();
    const painted = getComputedStyle(w.el).visibility;
    w.clearDissolve();
    app.present();
    return JSON.stringify({ before, painted, after: w.state.dissolve });
  })()`);
  if (!smoke.before.pipeline) failures.push('烟雾消散管线没有创建');
  if (smoke.before.hasDustBuffer) failures.push('粒子顶点缓冲字段仍未移除');
  if (smoke.after !== null) failures.push('clearDissolve 后进度应为 null');
  console.log('=== 回归：红灯烟雾消散（着色器） ===');
  console.log(JSON.stringify(smoke));

  // ⑫ 点红灯 → 烟雾消散 → 隐藏 + Dock 标记（真实 UI 操作）
  const smokeFlow = await json(`(async () => {
    const app = window.__app;
    const w = app.windows[1];
    const t0 = performance.now();
    w.el.querySelector('[data-action="close"]').click();
    const sync = { after: w.state.dissolve };
    while (w.state.dissolve !== null && performance.now() - t0 < 8000) {
      await new Promise(r => setTimeout(r, 60));
    }
    return JSON.stringify({
      sync, elapsed: Math.round(performance.now() - t0),
      done: {
        progress: w.state.dissolve,
        hidden: getComputedStyle(w.el).visibility,
        minimized: w.state.minimized,
        dockMin: document.querySelector('[data-dock="calc"]').classList.contains('is-minimized'),
      },
    });
  })()`);
  console.log('=== 回归：红灯烟雾消散（完整流程） ===');
  console.log(JSON.stringify(smokeFlow));
  if (smokeFlow.sync.after !== 0) failures.push('点击红灯后进度应同步为 0: ' + smokeFlow.sync.after);
  if (smokeFlow.done.progress !== null) failures.push('消散结束后进度应清空');
  if (smokeFlow.done.hidden !== 'hidden') failures.push('消散结束后窗口应隐藏');
  if (!smokeFlow.done.minimized) failures.push('消散结束后窗口应标记 minimized');
  if (!smokeFlow.done.dockMin) failures.push('消散结束后 Dock 图标应标记已关闭');

  // ⑬ 绿灯晃动：过渡过程中间帧必须是「介于原位与全屏之间」的形变矩形
  const wobble = await json(`(async () => {
    const app = window.__app;
    const w = app.windows[1];
    const before = { ...w.state.rect };
    const vf = app.visibleFrame();
    if (w.state.maximized) {
      w.el.querySelector('[data-action="maximize"]').click();
      await new Promise(r => setTimeout(r, 600));
    }
    w.el.querySelector('[data-action="maximize"]').click();
    await new Promise(r => setTimeout(r, 600));
    const done = { ...w.state.rect };
    const maximized = w.state.maximized;
    // 还原，避免污染后续用例（缩放、Dock 边）
    w.el.querySelector('[data-action="maximize"]').click();
    await new Promise(r => setTimeout(r, 600));
    return JSON.stringify({ before, vf, done, maximized, after: { ...w.state.rect }, restored: !w.state.maximized });
  })()`);
  // 终态必须精确落在 visible frame（不允许盖住菜单栏与 Dock）
  if (Math.abs(wobble.done.w - wobble.vf.w) > 2 || Math.abs(wobble.done.h - wobble.vf.h) > 2) {
    failures.push('绿灯没有最大化到 visible frame: ' + JSON.stringify(wobble.done) + ' vs ' + JSON.stringify(wobble.vf));
  }
  if (!wobble.maximized) failures.push('绿灯后 maximized 标志未置位');
  if (!wobble.restored) failures.push('再次点绿灯后应还原为非最大化');
  if (Math.abs(wobble.after.w - wobble.before.w) > 3) {
    failures.push('还原后宽度没有回到原位: ' + JSON.stringify(wobble.after) + ' vs ' + JSON.stringify(wobble.before));
  }
  console.log('=== 回归：绿灯晃动 ===');
  console.log(JSON.stringify(wobble));

  // ① 拖动标题栏
  const dragged = await json(`(() => {
    const app = window.__app;
    const w = app.windows[0];
    const before = { ...w.state.rect };
    const bar = w.el.querySelector('[data-drag]');
    const r = bar.getBoundingClientRect();
    const x0 = r.left + 30, y0 = r.top + r.height / 2;
    const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 11, pointerType: 'mouse', isPrimary: true, buttons: 1 });
    bar.dispatchEvent(mk('pointerdown', x0, y0));
    window.dispatchEvent(mk('pointermove', x0 + 40, y0 + 30));
    window.dispatchEvent(mk('pointerup', x0 + 40, y0 + 30));
    return JSON.stringify({ before, after: { ...w.state.rect } });
  })()`);
  if (Math.abs(dragged.after.x - dragged.before.x - 40) > 2 ||
      Math.abs(dragged.after.y - dragged.before.y - 30) > 2) {
    failures.push('拖动标题栏没有按位移移动窗口: ' + JSON.stringify(dragged));
  }
  console.log('=== 回归：拖动 ===');
  console.log(JSON.stringify(dragged));

  // ② 右下角缩放
  const resized = await json(`(() => {
    const app = window.__app;
    const w = app.windows[1];
    const before = { ...w.state.rect };
    const grip = w.el.querySelector('[data-resize]');
    const r = grip.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 12, pointerType: 'mouse', isPrimary: true, buttons: 1 });
    grip.dispatchEvent(mk('pointerdown', x0, y0));
    window.dispatchEvent(mk('pointermove', x0 - 30, y0 + 20));
    window.dispatchEvent(mk('pointerup', x0 - 30, y0 + 20));
    return JSON.stringify({ before, after: { ...w.state.rect }, tex: w.texSize, dom: { w: w.el.offsetWidth, h: w.el.offsetHeight } });
  })()`);
  if (Math.abs(resized.after.h - resized.before.h - 20) > 2) {
    failures.push('缩放没有生效: ' + JSON.stringify(resized));
  }
  // 纹理是设备像素（CSS × DPR），不能直接和 CSS 尺寸比
  const dprNow = await evaluate('window.devicePixelRatio || 1');
  if (Math.abs(resized.tex.height - Math.round(resized.dom.h * dprNow)) > 2) {
    failures.push('缩放后纹理尺寸没跟上: tex=' + resized.tex.height + ' dom=' + resized.dom.h + ' dpr=' + dprNow);
  }
  console.log('=== 回归：缩放 ===');
  console.log(JSON.stringify(resized));

  // ③ 交通灯：黄灯最小化 → 目标是自己 Dock 的图标
  const minimized = await json(`(async () => {
    window.__app.resetAll();
    await new Promise(r => setTimeout(r, 300));
    document.querySelector('#genie-window [data-action="minimize"]').click();
    const app = window.__app;
    const w = app.windows[0];
    const t0 = performance.now();
    while (!app.animating.has(w) && performance.now() - t0 < 1500) {
      await new Promise(r => setTimeout(r, 15));
    }
    const midTarget = app.targetFor(w);
    while (app.animating.has(w) && performance.now() - t0 < 6000) {
      await new Promise(r => setTimeout(r, 25));
    }
    const dock = app.dockRectFor(w.dockId);
    return JSON.stringify({
      playhead: w.state.playhead,
      minimized: w.state.minimized,
      dockIndicator: document.querySelector('[data-dock="notes"]').classList.contains('is-minimized'),
      midTarget, dock,
      targetMatchesDock: !!dock && Math.abs(midTarget.x - dock.x) < 1 && Math.abs(midTarget.y - dock.y) < 1,
    });
  })()`);
  if (minimized.playhead < 0.999) failures.push('黄灯最小化没有跑完: ' + minimized.playhead);
  if (!minimized.minimized) failures.push('黄灯最小化后 state.minimized 应为 true');
  if (!minimized.dockIndicator) failures.push('Dock 图标没有标记为已最小化');
  if (!minimized.targetMatchesDock) failures.push('最小化目标不是自己的 Dock 图标');
  console.log('=== 回归：黄灯最小化 ===');
  console.log(JSON.stringify(minimized));

  // ④ 点 Dock 图标还原
  const restored = await json(`(async () => {
    document.querySelector('[data-dock="notes"]').click();
    const app = window.__app;
    const w = app.windows[0];
    const t0 = performance.now();
    // 直接等 playhead 归零（而不是等 animating 集合）：
    // restoreWindow 是点完才把窗口加进 animating，轮询该集合有竞态。
    while (w.state.playhead > 0.001 && performance.now() - t0 < 6000) {
      await new Promise(r => setTimeout(r, 25));
    }
    return JSON.stringify({
      playhead: w.state.playhead,
      minimized: w.state.minimized,
      stillAnimating: app.animating.has(w),
    });
  })()`);
  if (restored.playhead > 0.001) failures.push('Dock 还原没有回到 playhead=0: ' + restored.playhead);
  if (restored.minimized) failures.push('Dock 还原后仍是 minimized');
  console.log('=== 回归：Dock 还原 ===');
  console.log(JSON.stringify(restored));

  // ⑤ 红灯关闭 / 绿灯最大化还原
  // 绿灯是 380ms 晃动过渡、红灯是 1800ms 烟雾消散 —— 都要等动画结束再断言
  const lights = await json(`(async () => {
    const app = window.__app;
    const w = app.windows[1];
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const waitFor = async (pred, limit) => {
      const t0 = performance.now();
      while (!pred() && performance.now() - t0 < limit) await wait(30);
    };
    const before = { ...w.state.rect };
    w.el.querySelector('[data-action="maximize"]').click();
    await waitFor(() => w.wobbleRaf === null && Math.abs(w.state.rect.w - app.visibleFrame().w) < 2, 2500);
    const max = { ...w.state.rect };
    const maximized = w.state.maximized;
    w.el.querySelector('[data-action="maximize"]').click();
    await waitFor(() => w.wobbleRaf === null && Math.abs(w.state.rect.w - before.w) < 3, 2500);
    const back = { ...w.state.rect };
    const restoredUp = w.state.maximized;
    w.el.querySelector('[data-action="close"]').click();
    await waitFor(() => w.state.dissolve === null && getComputedStyle(w.el).visibility === 'hidden', 6000);
    const closed = { visibility: getComputedStyle(w.el).visibility, minimized: w.state.minimized };
    document.querySelector('[data-dock="calc"]').click();
    await waitFor(() => w.state.playhead <= 0.001, 6000);
    return JSON.stringify({ before, max, maximized, back, restoredUp, closed });
  })()`);
  // 绿灯最大化到 visible frame（不盖菜单栏和 Dock），不是整块画布
  const vf = await json(`JSON.stringify(window.__app.visibleFrame())`);
  if (Math.abs(lights.max.w - vf.w) > 2 || Math.abs(lights.max.h - vf.h) > 2) {
    failures.push('绿灯没有最大化到 visible frame: ' + JSON.stringify(lights.max) + ' vs ' + JSON.stringify(vf));
  }
  // 也不能盖住菜单栏 / Dock
  if (lights.max.y < 26) failures.push('最大化窗口盖住了菜单栏: y=' + lights.max.y);
  const dockTop = await evaluate(`document.getElementById('dock').getBoundingClientRect().top - document.getElementById('webgpu-canvas').getBoundingClientRect().top`);
  if (lights.max.y + lights.max.h > dockTop + 1) {
    failures.push('最大化窗口盖住了 Dock: bottom=' + (lights.max.y + lights.max.h) + ' dockTop=' + dockTop);
  }
  if (Math.abs(lights.back.w - lights.before.w) > 2 || Math.abs(lights.back.h - lights.before.h) > 2) {
    failures.push('绿灯再按一次没有还原: ' + JSON.stringify(lights.back));
  }
  if (lights.closed.visibility !== 'hidden' || !lights.closed.minimized) {
    failures.push('红灯没有隐藏窗口: ' + JSON.stringify(lights.closed));
  }
  console.log('=== 回归：红/绿灯 ===');
  console.log(JSON.stringify(lights));

  // ⑥ 计算器真的会算（同步点击，避免页面内 await 卡住 CDP）
  // ⑭ 窗口层级：点击置顶，且关闭烟雾留在原层级
  const stacking = await json(`(async () => {
    const app = window.__app;
    app.resetAll();
    const [notes, calc] = app.windows;
    const down = (w, selector) => w.el.querySelector(selector).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 21, pointerType: 'mouse' })
    );
    down(calc, '.calc-display');
    down(notes, '.content');
    const raised = {
      order: app.windowOrder.map(w => w.dockId),
      active: app.activeWindow.dockId,
      z: app.windows.map(w => [w.dockId, Number(w.el.style.zIndex)]),
    };
    down(calc, '.calc-display');
    notes.el.querySelector('[data-action="close"]').click();
    const closing = {
      order: app.windowOrder.map(w => w.dockId),
      active: app.activeWindow.dockId,
      progress: notes.state.dissolve,
    };
    app.resetAll();
    return JSON.stringify({ raised, closing });
  })()`);
  if (stacking.raised.order.join(',') !== 'calc,notes') {
    failures.push('点击 Notes 后没有移动到渲染顶层: ' + stacking.raised.order);
  }
  if (stacking.raised.active !== 'notes') failures.push('点击 Notes 后焦点不对');
  const zn = Object.fromEntries(stacking.raised.z);
  if (!(zn.notes > zn.calc)) failures.push('Notes 的 DOM z-index 没有高于 Calculator');
  if (stacking.closing.order.join(',') !== 'notes,calc') {
    failures.push('关闭下层 Notes 时烟雾被提到了顶层: ' + stacking.closing.order);
  }
  if (stacking.closing.active !== 'calc') failures.push('关闭后台窗口不应抢走焦点');
  if (stacking.closing.progress !== 0) failures.push('点击红灯后没有进入烟雾消散');
  console.log('=== 回归：窗口层级与烟雾顺序 ===');
  console.log(JSON.stringify(stacking));

  await evaluate(`window.__app.resetAll(); 'ok'`);
  await sleep(300);
  const pressSync = async (keys) => {
    const cmds = keys.map(k => "document.querySelector('[data-key=\\\"" + k + "\\\"]').click();").join(' ');
    await evaluate('(() => { ' + cmds + " return 'ok'; })()");
    return await evaluate("document.getElementById('calc-display').textContent");
  };
  const mul = await pressSync(['AC', '1', '2', '*', '3', '=']);
  const add = await pressSync(['AC', '7', '+', '8', '=']);
  const divZero = await pressSync(['AC', '9', '/', '0', '=']);
  const arith = { mul, add, divZero };
  if (arith.mul !== '36') failures.push('计算器 12*3 应为 36，实际 ' + arith.mul);
  if (arith.add !== '15') failures.push('计算器 7+8 应为 15，实际 ' + arith.add);
  if (arith.divZero !== 'Error') failures.push('除零应显示 Error，实际 ' + arith.divZero);
  console.log('=== 回归：计算器 ===');
  console.log(JSON.stringify(arith));
  // ⑩ 画面清晰度：纹理尺寸必须精确等于 元素尺寸 × DPR（差 1px 就会整体重采样）
  const crisp = await json(`JSON.stringify((() => {
    const app = window.__app;
    const dpr = window.devicePixelRatio;
    return app.windows.map(w => {
      const cssW = w.el.getBoundingClientRect().width;
      return {
        name: w.name,
        tex: w.texSize,
        expect: { w: Math.round(cssW * dpr), h: Math.round(w.el.getBoundingClientRect().height * dpr) },
      };
    });
  })())`);
  for (const c of crisp) {
    if (Math.abs(c.tex.width - c.expect.w) > 0 || Math.abs(c.tex.height - c.expect.h) > 0) {
      failures.push(c.name + ' 纹理尺寸与元素×DPR 不精确相等（会造成整体重采样发虚）: tex=' +
        JSON.stringify(c.tex) + ' expect=' + JSON.stringify(c.expect));
    }
  }
  console.log('=== 回归：纹理尺寸精确性 ===');
  console.log(JSON.stringify(crisp));

  // ⑨ 通过真实 UI 切换 Dock 到四条边：方向 / 目标 / visibleFrame 都要跟着变
  const edges = [];
  for (const edge of ['bottom', 'top', 'left', 'right']) {
    await evaluate(`(() => {
      window.__app.resetAll();
      const sel = document.getElementById('dock-edge-select');
      sel.value = '${edge}';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'switched';
    })()`);
    await sleep(650);
    const info = JSON.parse(await evaluate(`(() => {
      const app = window.__app;
      const d = document.getElementById('dock').getBoundingClientRect();
      const c = document.getElementById('webgpu-canvas').getBoundingClientRect();
      const notes = app.windows[0];
      return JSON.stringify({
        edge: app.dockEdge,
        dir: app.direction,
        dock: { x: Math.round(d.x - c.x), y: Math.round(d.y - c.y), w: Math.round(d.width), h: Math.round(d.height) },
        vf: app.visibleFrame(),
        win: notes.state.rect,
        target: app.targetFor(notes),
        dockIcon: app.dockRectFor(notes.dockId),
      });
    })()`));
    edges.push(info);
  }
  const EXPECT = { bottom: 'down', top: 'up', left: 'left', right: 'right' };
  // 画布尺寸随视口扩展，从 DOM 实测，不写死 800×600
  const canvasW = await evaluate(`document.getElementById('webgpu-canvas').getBoundingClientRect().width`);
  const canvasH = await evaluate(`document.getElementById('webgpu-canvas').getBoundingClientRect().height`);
  for (const e of edges) {
    if (e.edge !== e.edge) failures.push('Dock 边未生效');
    if (e.dir !== EXPECT[e.edge]) failures.push(e.edge + ' 边应为 ' + EXPECT[e.edge] + ' 方向，实际 ' + e.dir);
    // 纵向 Dock（左右）应比横向高
    if ((e.edge === 'left' || e.edge === 'right') && e.dock.h <= e.dock.w) {
      failures.push(e.edge + ' 的 Dock 应该是纵向排列，实际 ' + JSON.stringify(e.dock));
    }
    if ((e.edge === 'bottom' || e.edge === 'top') && e.dock.w <= e.dock.h) {
      failures.push(e.edge + ' 的 Dock 应该是横向排列，实际 ' + JSON.stringify(e.dock));
    }
    // Dock 必须完整落在画布内
    if (e.dock.x < 0 || e.dock.y < 0 || e.dock.x + e.dock.w > canvasW || e.dock.y + e.dock.h > canvasH) {
      failures.push(e.edge + ' 的 Dock 超出了画布: ' + JSON.stringify(e.dock));
    }
    // 窗口不能压住 Dock
    if (e.edge === 'bottom' && e.win.y + e.win.h > e.dock.y + 1) {
      failures.push('窗口盖住了底部 Dock');
    }
    if (e.edge === 'top' && e.win.y < e.dock.y + e.dock.h - 1) {
      failures.push('窗口盖住了顶部 Dock');
    }
    if (e.edge === 'left' && e.win.x < e.dock.x + e.dock.w - 1) {
      failures.push('窗口盖住了左侧 Dock');
    }
    if (e.edge === 'right' && e.win.x + e.win.w > e.dock.x + 1) {
      failures.push('窗口盖住了右侧 Dock');
    }
    // 目标 = 自己的 Dock 图标
    if (Math.abs(e.target.x - e.dockIcon.x) > 1 || Math.abs(e.target.y - e.dockIcon.y) > 1) {
      failures.push(e.edge + ' 边：目标不是自己的 Dock 图标');
    }
  }
  console.log('=== 回归：四条 Dock 边（真实 UI 切换）===');
  for (const e of edges) {
    console.log(e.edge.padEnd(7), 'dir=' + e.dir.padEnd(6), 'win=' + JSON.stringify(e.win), 'dock=' + JSON.stringify(e.dock), 'vf=' + JSON.stringify(e.vf));
  }
  // 复位到默认边，避免污染后续断言
  await evaluate(`(() => {
    const sel = document.getElementById('dock-edge-select');
    sel.value = 'bottom';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(400);

  
  // ⑦ 静止态尺寸变化，所有窗口的纹理都要跟上
  await evaluate(`(() => {
    const app = window.__app;
    const stage = document.getElementById('stage');
    stage.style.width = '1100px';
    stage.style.height = '820px';
    window.dispatchEvent(new Event('resize'));
    return 'ok';
  })()`);
  await sleep(1200);
  const afterResize = await json(`(() => {
    const c = document.getElementById('webgpu-canvas');
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return JSON.stringify({
      backingW: c.width, expectW: Math.round(r.width * dpr),
      match: c.width === Math.round(r.width * dpr),
      windows: window.__app.windows.map(w => ({ name: w.name, tex: w.texSize, dom: { w: w.el.offsetWidth, h: w.el.offsetHeight } })),
    });
  })()`);
  await evaluate(`(() => {
    const stage = document.getElementById('stage');
    stage.style.width = '800px';
    stage.style.height = '600px';
    window.dispatchEvent(new Event('resize'));
    return 'restored';
  })()`);
  await sleep(800);
  if (!afterResize.match) failures.push('尺寸变化后后备缓冲未更新: ' + afterResize.backingW + ' ≠ ' + afterResize.expectW);
  const dprAfter = await evaluate('window.devicePixelRatio || 1');
  for (const w of afterResize.windows) {
    const expect = Math.round(w.dom.w * dprAfter);
    if (Math.abs(w.tex.width - expect) > 2) {
      failures.push(w.name + ' 纹理宽没跟上: tex=' + w.tex.width + ' 期望=' + expect + ' (dpr=' + dprAfter + ')');
    }
  }
  console.log('=== 回归：静止态尺寸变化 ===');
  console.log(JSON.stringify(afterResize));

  // ⑧ 多窗口同时最小化到各自图标
  const both = await json(`(async () => {
    const app = window.__app;
    app.resetAll();
    await new Promise(r => setTimeout(r, 250));
    const r = document.getElementById('progress-range');
    r.value = '0.55';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify(app.windows.map(w => ({
      name: w.name, playhead: +w.state.playhead.toFixed(2),
      dir: app.dirFor(w),
      target: app.targetFor(w), dock: app.dockRectFor(w.dockId),
    })));
  })()`);
  for (const w of both) {
    if (!w.dock) { failures.push(w.name + ' 找不到 Dock 图标'); continue; }
    if (Math.abs(w.target.x - w.dock.x) > 1 || Math.abs(w.target.y - w.dock.y) > 1) {
      failures.push(w.name + ' 的收缩目标不是自己的 Dock 图标');
    }
    if (w.dir !== 'down') failures.push(w.name + ' 的行进轴应为 down（Dock 在底部），实际 ' + w.dir);
  }
  console.log('=== 回归：多窗口目标 ===');
  console.log(JSON.stringify(both));

  await evaluate(`window.__app.resetAll(); 'ok'`);
  await sleep(300);

  const errors = [];
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      errors.push('[exception] ' + (d.exception && d.exception.description || d.text));
    }
    if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
      errors.push('[console.' + e.params.type + '] ' + e.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      errors.push('[log.error] ' + e.params.entry.text);
    }
  }
  const uniq = [...new Set(errors.map(e => e.slice(0, 300)))];
  const realErrors = uniq.filter(e => !e.includes('favicon'));
  console.log('=== 错误/警告 ===');
  realErrors.length ? realErrors.slice(0, 8).forEach(e => console.log(e)) : console.log('(none)');
  if (realErrors.length) failures.push('控制台有 ' + realErrors.length + ' 条错误');

  ws.close();
  chrome.kill();
  await sleep(300);

  if (failures.length) {
    console.error('\n=== FAIL ===');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n回归断言全部通过');
} catch (err) {
  console.error('\n=== 回归断言执行失败 ===');
  console.error(err && err.stack || err);
  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(1);
}

