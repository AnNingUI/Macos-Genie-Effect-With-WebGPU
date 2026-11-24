// 单个「App 窗口」的封装 = 一个可被 HTML-in-Canvas 捕获的真实 DOM 元素。
//
// 每个窗口自带：
//   · 一块纹理（窗口尺寸 × DPR）
//   · 一份 uniform buffer + bind group
//   · 自己的最小化进度（playhead）、目标 Dock 图标、拖拽/缩放状态
//
// 渲染由 GenieApp 统一驱动：每帧遍历所有窗口，画到同一张画布上。
// 这样 Genie 动画可以同时作用于多个窗口，而它们各自独立。

import {
  GENIE_UNIFORM_FLOATS,
  computeVisibleBounds,
  packGenieUniforms,
  type GenieInput,
  type Rect,
} from "./genie";
import {
  drawElementToTexture,
  elementImageSize,
  syncElementGeometry,
} from "./html-in-canvas";

export interface WindowState {
  /** 窗口矩形（画布 CSS 像素） */
  rect: Rect;
  /** 0 = 原样，1 = 收进 Dock */
  playhead: number;
  /** 最小化动画是否已跑完 */
  minimized: boolean;
  /** 是否最大化 */
  maximized: boolean;
  /** 最大化前的矩形，用于还原 */
  restoreRect: Rect | null;
  /** 关窗烟雾消散进度：0 = 完好，1 = 完全消失；null 表示没在播放 */
  dissolve: number | null;
}

let uid = 0;

export class AppWindow {
  readonly id: string;
  readonly el: HTMLDivElement;
  /** 对应 Dock 图标的 data-dock（'notes' / 'calc'） */
  readonly dockId: string;
  /** 显示名（日志 / tooltip） */
  readonly name: string;

  texture: GPUTexture | null = null;
  textureView: GPUTextureView | null = null;
  texSize = { width: 1, height: 1 };

  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup | null = null;

  /** 绿灯晃动的 rAF 句柄 */
  wobbleRaf: number | null = null;
  /** 晃动被 rAF 节流时的兜底定时器 */
  wobbleFallback: number | null = null;

  state: WindowState;

  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private uniformScratch = new Float32Array(GENIE_UNIFORM_FLOATS);
  /** 每个窗口固定且可复现的烟雾噪声种子 */
  private dissolveSeed: number;

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    el: HTMLDivElement,
    dockId: string,
    name: string,
    rect: Rect,
  ) {
    this.id = `win-${++uid}`;
    this.dissolveSeed = (uid * 0.731) % 10;
    this.device = device;
    this.canvas = canvas;
    this.el = el;
    this.dockId = dockId;
    this.name = name;
    this.state = {
      rect: { ...rect },
      playhead: 0,
      minimized: false,
      maximized: false,
      restoreRect: null,
      dissolve: null,
    };

    this.uniformBuffer = device.createBuffer({
      size: GENIE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.applyRect(rect);
  }


  /** 把矩形写到 DOM（窗口坐标是相对 canvas 的 CSS 像素）。 */
  /**
   * 把矩形写到 DOM。
   *
   * ⚠️ 位置和尺寸都对齐到**整数设备像素**。原因是清晰度：
   * 纹理是按 CSS 尺寸 × DPR 抓的，如果元素落在 x.35 这种半像素位置，
   * GPU 输出的四边形就会被浏览器重采样到非整数像素格上，
   * 1px 细节（文字描边）会被线性插值抹成灰阶 —— 整块画面"发虚"。
   * 对齐到设备像素后，1:1 采样才是真正的逐像素命中。
   */
  applyRect(rect: Rect): void {
    // devicePixelRatio 常常是 1.0000000158945716 这类"近似 1"的值。
    // 若直接按 1/dpr 网格吸附，会得到 784.1666 这种跨度 —— 元素变成小数尺寸，
    // 纹理又是整数，两者不等 → 抓取时整体重采样 → 画面发虚。
    // 所以只在 DPR 明显不是 1 时才吸附到设备像素网格；近似 1 时直接用整数 CSS 像素。
    const raw = window.devicePixelRatio || 1;
    const dpr = Math.abs(raw - 1) < 0.01 ? 1 : raw;
    const snap = (v: number): number => Math.round(v * dpr) / dpr;
    const snapped: Rect = {
      x: snap(rect.x),
      y: snap(rect.y),
      w: Math.max(1, snap(rect.w)),
      h: Math.max(1, snap(rect.h)),
    };
    this.state.rect = snapped;
    this.el.style.left = `${snapped.x}px`;
    this.el.style.top = `${snapped.y}px`;
    this.el.style.width = `${snapped.w}px`;
    this.el.style.height = `${snapped.h}px`;
  }

  /**
   * 创建 / 重建纹理（尺寸变化时）。返回是否重建了。
   * 重建后 bind group 必须失效（它指向旧的纹理视图）。
   */
  ensureTexture(pipeline: GPURenderPipeline, sampler: GPUSampler): boolean {
    // ⚠️ 读一次 offsetWidth 强制同步布局：applyRect 只写了 style，
    // 而 elementImageSize 读的是 offsetWidth —— 不 reflow 会拿到窗口
    // 没有任何尺寸时的 0 或上一次的值，纹理尺寸就错了。
    const measured = { w: this.el.offsetWidth, h: this.el.offsetHeight };
    const dpr = window.devicePixelRatio || 1;

    // 纹理尺寸必须是**整数设备像素**：state.rect 已经对齐到设备像素，
    // 所以 rect × dpr 就是整数。用 elementImageSize 的返回值反而可能带小数
    // （它是 CSS 像素），非整数尺寸 = 采样时必然插值 → 画面发虚。
    // ⚠️ 必须用 Math.round，不能用 Math.ceil：
    // devicePixelRatio 常见 1.0000000158945716 这种值，
    // 256 * dpr = 256.000004，ceil 会得到 257 —— 纹理比元素宽 1 像素，
    // 于是整块内容被横向拉伸 0.4%，所有 1px 细节都被插值抹平（画面发虚）。
    let w = Math.max(1, Math.round(this.state.rect.w * dpr));
    let h = Math.max(1, Math.round(this.state.rect.h * dpr));

    // 兜底：实测尺寸与 state.rect 偏差过大时（如字体/滚动条），用实测值
    if (Math.abs(w - Math.round(measured.w * dpr)) > 2) w = Math.max(1, Math.round(measured.w * dpr));
    if (Math.abs(h - Math.round(measured.h * dpr)) > 2) h = Math.max(1, Math.round(measured.h * dpr));
    void elementImageSize;

    if (this.texture && w === this.texSize.width && h === this.texSize.height) return false;

    this.texture?.destroy();
    this.texture = this.device.createTexture({
      size: { width: w, height: h, depthOrArrayLayers: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST |
             GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.textureView = this.texture.createView();
    this.texSize = { width: w, height: h };

    this.rebuildBindGroup(pipeline, sampler);
    // 新纹理是空的，立刻填一次，否则首帧采样到全空 → 黑屏
    this.upload();
    return true;
  }

  rebuildBindGroup(pipeline: GPURenderPipeline, sampler: GPUSampler): void {
    if (!this.textureView) return;
    this.bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.textureView },
        { binding: 2, resource: sampler },
      ],
    });
  }

  upload(): void {
    if (!this.texture) return;
    drawElementToTexture(
      this.device.queue, this.el, this.texture,
      this.texSize.width, this.texSize.height,
    );
  }

  /**
   * 写 uniform + 同步命中几何。
   * @param input 除 from / progress 外的形变参数（from 与 progress 从自身状态取）
   */
  prepare(
    input: Omit<GenieInput, "from" | "progress">,
    dpr: number,
    viewport: { width: number; height: number },
  ): void {
    const fromPx: Rect = {
      x: this.state.rect.x * dpr, y: this.state.rect.y * dpr,
      w: this.state.rect.w * dpr, h: this.state.rect.h * dpr,
    };
    const frameInput: GenieInput & { viewport: { width: number; height: number } } = {
      ...input,
      from: fromPx,
      to: {
        x: input.to.x * dpr, y: input.to.y * dpr,
        w: input.to.w * dpr, h: input.to.h * dpr,
      },
      progress: this.state.playhead,
      viewport,
    };

    if (this.uniformBuffer) {
      const f = packGenieUniforms(frameInput, this.uniformScratch);
      this.device.queue.writeBuffer(this.uniformBuffer, 0, f);
    }

    const vb = computeVisibleBounds(frameInput);
    syncElementGeometry(
      this.canvas, this.el,
      vb.x / dpr, vb.y / dpr, vb.w / dpr, vb.h / dpr,
    );
  }

  // ------------------------------------------------------------ 烟雾消散

  /**
   * 烟雾消散期间写 uniform。
   *
   * 与 Genie 共用同一个 24 float 的 uniform buffer；字段切换到 Smoke.wgsl：
   * viewport / css / rect / motion(progress, seed)。单四边形，无额外几何。
   */
  prepareDissolveUniforms(
    dpr: number,
    viewport: { width: number; height: number },
  ): void {
    const f = this.uniformScratch;
    const r = this.state.rect;
    f.fill(0);
    f[0] = viewport.width;
    f[1] = viewport.height;
    f[2] = r.w;
    f[3] = r.h;
    f[4] = r.x * dpr;
    f[5] = r.y * dpr;
    f[6] = r.w * dpr;
    f[7] = r.h * dpr;
    f[8] = this.state.dissolve ?? 0;
    f[9] = this.dissolveSeed;
    if (this.uniformBuffer) {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, f);
    }
  }

  /** 消散结束或还原窗口时清除进度。 */
  clearDissolve(): void {
    this.state.dissolve = null;
  }
}
