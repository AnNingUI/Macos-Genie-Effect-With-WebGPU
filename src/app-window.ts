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

  state: WindowState;

  private device: GPUDevice;
  private canvas: HTMLCanvasElement;
  private uniformScratch = new Float32Array(GENIE_UNIFORM_FLOATS);

  constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    el: HTMLDivElement,
    dockId: string,
    name: string,
    rect: Rect,
  ) {
    this.id = `win-${++uid}`;
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
    };

    this.uniformBuffer = device.createBuffer({
      size: GENIE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.applyRect(rect);
  }

  /** 把矩形写到 DOM（窗口坐标是相对 canvas 的 CSS 像素）。 */
  applyRect(rect: Rect): void {
    this.state.rect = { ...rect };
    this.el.style.left = `${Math.round(rect.x)}px`;
    this.el.style.top = `${Math.round(rect.y)}px`;
    this.el.style.width = `${Math.round(rect.w)}px`;
    this.el.style.height = `${Math.round(rect.h)}px`;
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
    const s = elementImageSize(this.canvas, this.el);
    let w = Math.max(1, Math.ceil(s.width));
    let h = Math.max(1, Math.ceil(s.height));

    // elementImageSize 在元素还没有 paint 记录时会回退到 offsetWidth × dpr；
    // 但如果它返回的尺寸明显不是这个元素的（比如等于画布尺寸），用实测值纠正。
    const dpr = window.devicePixelRatio || 1;
    const expectW = Math.max(1, Math.round(measured.w * dpr));
    const expectH = Math.max(1, Math.round(measured.h * dpr));
    if (Math.abs(w - expectW) > 2 || Math.abs(h - expectH) > 2) {
      w = expectW;
      h = expectH;
    }

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
}
