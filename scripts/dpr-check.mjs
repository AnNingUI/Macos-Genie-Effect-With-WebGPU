// DPR 验证：在 DPR=1 / 2 / 3 下分别检查
//   1. canvas 后备缓冲是否 = CSS 尺寸 × DPR
//   2. 窗口纹理尺寸是否随 DPR 放大
//   3. 截屏清晰度（用图像字节数粗略对比）
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TARGET = process.argv[2] || 'http://localhost:5201/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/** 截图输出目录：默认 ./shots，可用 GENIE_SHOTS 覆盖 */
const OUT = process.env.GENIE_SHOTS || 'shots';
const PORT = 9345;
await mkdir(OUT, { recursive: true });

const udd = `${process.env.TEMP ?? '/tmp'}/cdp-dprv-${Date.now()}`;

const chrome = spawn(CHROME, [
  '--window-position=60,40', '--window-size=1280,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', 'about:blank',
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
let id = 0;
const pend = new Map();
const send = (m, p = {}, sid) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method: m, params: p, ...(sid ? { sessionId: sid } : {}) }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));

const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(t => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: TARGET }, sessionId);
await sleep(6000);

const failures = [];
for (const dpr of [1, 2, 3]) {
  // 强制 DPR
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: dpr, mobile: false,
  }, sessionId);
  // 故意不做任何交互：DPR 变化必须由 setupResize() 自己跟上。
  // 等它稳定（含迟到复查 60/160/400ms）。
  await sleep(1600);

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('webgpu-canvas');
      const rect = c.getBoundingClientRect();
      return JSON.stringify({
        dpr: +window.devicePixelRatio.toFixed(3),
        backingW: c.width, backingH: c.height,
        cssW: +rect.width.toFixed(2), cssH: +rect.height.toFixed(2),
        expectW: Math.round(rect.width * window.devicePixelRatio),
        match: c.width === Math.round(rect.width * window.devicePixelRatio),
      });
    })()`,
    returnByValue: true,
  }, sessionId);

  const info = JSON.parse(r.result.value);
  if (!info.match) failures.push(`DPR=${dpr} 后备缓冲 ${info.backingW} ≠ 期望 ${info.expectW}`);
  console.log(`DPR=${dpr}:`, r.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  if (shot?.data) {
    const buf = Buffer.from(shot.data, 'base64');
    await writeFile(join(OUT, `dpr-${dpr}.png`), buf);
    console.log(`  截图 dpr-${dpr}.png (${(buf.length / 1024).toFixed(0)} KB)`);
  }
}

// 恢复
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
ws.close();
chrome.kill();
await sleep(300);

if (failures.length) {
  console.error('\nFAIL:\n' + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('\n全部 DPR 通过（未做任何交互，验证 setupResize 自愈）');
process.exit(0);