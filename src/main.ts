import genie_f from "./shaders/effect/Genie.fragment.wgsl?raw";
import genie_v from "./shaders/effect/Genie.vertex.wgsl?raw";
import {
  DEFAULT_TIMING,
  DOCK_EDGE_TO_DIRECTION,
  GENIE_DIRECTIONS,
  type DockEdge,
  type GenieDirection,
  type Rect,
} from "./genie";
import { AppWindow } from "./app-window";
import {
  isSupported,
  onPaint,
  requestPaint,
  supportsElementTexture,
} from "./html-in-canvas";
import "./style.css";

// --- 设计基准（CSS 像素）---
const DESIGN_W = 800;
const DESIGN_H = 600;

interface RenderScale {
  dpr: number; cssW: number; cssH: number; pxW: number; pxH: number;
}
const renderScale: RenderScale = {
  dpr: 1, cssW: DESIGN_W, cssH: DESIGN_H, pxW: DESIGN_W, pxH: DESIGN_H,
};

/** 菜单栏高度（CSS 像素），与 style.css 的 #menubar 保持一致 */
const MENUBAR_H = 26;
/** Dock 停在下/上边时占用的高度（含内边距） */
const DOCK_AREA = 76;
/** Dock 停在左/右边时占用的宽度 */
const DOCK_SIDE_AREA = 76;

const DOCK_EDGE_LABELS: Record<DockEdge, string> = {
  bottom: "底部（默认）",
  top: "顶部",
  left: "左侧",
  right: "右侧",
};

const canvasEl = document.getElementById("webgpu-canvas") as HTMLCanvasElement;
const dockEl = document.getElementById("dock") as HTMLDivElement;
const notesEl = document.getElementById("genie-window") as HTMLDivElement;
const calcEl = document.getElementById("calc-window") as HTMLDivElement;
const genieBtn = document.getElementById("genie-btn") as HTMLButtonElement;
const resetBtn = document.getElementById("reset-btn") as HTMLButtonElement;
const dockEdgeSelect = document.getElementById("dock-edge-select") as HTMLSelectElement | null;
const targetInput = document.getElementById("target-input") as HTMLInputElement | null;
const windowSelect = document.getElementById("window-select") as HTMLSelectElement | null;
const progressRange = document.getElementById("progress-range") as HTMLInputElement | null;
const progressValue = document.getElementById("progress-value") as HTMLOutputElement | null;
const infoEl = document.getElementById("info") as HTMLDivElement;
const mbAppEl = document.getElementById("mb-app");
const mbClockEl = document.getElementById("mb-clock");
const unsupported = document.getElementById("unsupported") as HTMLDivElement;
const unsupportedDetail = document.getElementById("unsupported-detail") as HTMLParagraphElement;

function fail(reason: string): never {
  unsupported.hidden = false;
  unsupportedDetail.textContent = reason;
  throw new Error(reason);
}

if (!isSupported(canvasEl)) {
  fail("当前浏览器未提供 canvas.requestPaint()，无法使用 HTML-in-Canvas。");
}

function applyCanvasSize(force = false): boolean {
  const rect = canvasEl.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || DESIGN_W));
  const cssH = Math.max(1, Math.round(rect.height || DESIGN_H));
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));

  const changed = force ||
    renderScale.pxW !== pxW || renderScale.pxH !== pxH ||
    renderScale.cssW !== cssW || renderScale.cssH !== cssH ||
    renderScale.dpr !== dpr;
  if (!changed) return false;

  canvasEl.width = pxW;
  canvasEl.height = pxH;
  renderScale.dpr = dpr;
  renderScale.cssW = cssW;
  renderScale.cssH = cssH;
  renderScale.pxW = pxW;
  renderScale.pxH = pxH;
  return true;
}

async function initWebGPU() {
  if (!navigator.gpu) { fail("此浏览器不支持 WebGPU。"); return null; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { fail("未找到可用的 GPUAdapter。"); return null; }
  const device = await adapter.requestDevice();

  if (!supportsElementTexture(device.queue)) {
    fail("WebGPU 已就绪，但 queue 上缺少 drawElementImageToTexture / copyElementImageToTexture。"
      + "请使用 Chrome 155+，或 Chrome 138+ 并开启 chrome://flags/#canvas-draw-element。");
  }

  const canvas = canvasEl;
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: "opaque" });
  return { device, context, canvasFormat, canvas };
}

class GenieApp {
  device: GPUDevice;
  context: GPUCanvasContext;
  canvasFormat: GPUTextureFormat;
  canvas: HTMLCanvasElement;

  pipeline: GPURenderPipeline | null = null;
  sampler: GPUSampler | null = null;

  /** 所有 App 窗口（数组顺序即绘制顺序） */
  windows: AppWindow[] = [];
  /** 当前聚焦窗口：最小化按钮 / 滑杆作用于它 */
  activeWindow: AppWindow | null = null;

  animationDuration = 1.0;
  timing = { ...DEFAULT_TIMING };
  /** Dock 停靠边 —— 方向由它推导，不再由用户单独选方向 */
  dockEdge: DockEdge = "bottom";
  /** 当前行进方向（= DOCK_EDGE_TO_DIRECTION[dockEdge]），保留为派生值便于调试 */
  get direction(): GenieDirection {
    return DOCK_EDGE_TO_DIRECTION[this.dockEdge];
  }
  targetPlacement: "dock" | "free" = "dock";
  windowMode: "full" | "windowed" | "offset" = "full";

  private animating = new Set<AppWindow>();
  private animationId: number | null = null;
  private animationFallbackId: number | null = null;
  private resizeRaf: number | null = null;
  /** DPR 轮询定时器（matchMedia 的精确分辨率匹配不可靠） */
  private dprWatchId: number | null = null;
  private resizeTimers: number[] = [];
  private isResizing = false;
  private zCounter = 10;

  constructor(
    device: GPUDevice, context: GPUCanvasContext,
    canvasFormat: GPUTextureFormat, canvas: HTMLCanvasElement,
  ) {
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;
    this.canvas = canvas;
  }

  async init(): Promise<void> {
    applyCanvasSize(true);

    this.sampler = this.device.createSampler({
      magFilter: "linear", minFilter: "linear",
    });

    const module = this.device.createShaderModule({ code: genie_v + genie_f });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "main_vertex" },
      fragment: {
        module, entryPoint: "main_fragment",
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.createWindows();
    this.layoutWindows();

    // ⚠️ 必须强制一次同步布局再量尺寸：applyRect 只写了 style，
    // 而 elementImageSize 读的是 offsetWidth —— 不强制 reflow 会拿到窗口
    // 默认的 800×600，导致每个窗口的纹理尺寸都错成画布大小。
    void this.canvas.offsetWidth;

    onPaint(this.canvas, () => {
      for (const w of this.windows) w.upload();
      this.present();
    });

    this.applyDockEdge();
    this.setupUI();
    this.setupMenubar();
    this.setupDock();
    this.setupInteractions();
    this.setupResize();

    for (const w of this.windows) this.refreshWindowTexture(w);
    this.present();
  }

  // ---------------------------------------------------------------- 窗口

  private createWindows(): void {
    this.windows = [
      new AppWindow(this.device, this.canvas, notesEl, "notes", "Notes", { x: 0, y: 0, w: 640, h: 440 }),
      new AppWindow(this.device, this.canvas, calcEl, "calc", "Calculator", { x: 0, y: 0, w: 260, h: 360 }),
    ];
    this.activeWindow = this.windows[0];
    this.windows[0].el.classList.add("is-focused");
  }

  /**
   * 按 windowMode 摆放所有窗口。
   *
   * 基准取**画布的实际显示框**（renderScale 在 resize 期间可能滞后）。
   */
  layoutWindows(): void {
    // 统一以 visibleFrame 为基准 —— 它已经按 Dock 停靠边让出了空间
    const vf = this.visibleFrame();
    const W = Math.max(1, Math.round(this.canvas.getBoundingClientRect().width || DESIGN_W));

    if (this.windowMode === "full") {
      this.windows[0].applyRect({ ...vf });
      this.windows[1].applyRect({
        x: vf.x + vf.w - 268,
        y: vf.y + Math.round(vf.h * 0.1),
        w: 260,
        h: Math.min(360, vf.h - 20),
      });
    } else if (this.windowMode === "windowed") {
      const w = Math.round(W * 0.68);
      const h = Math.round(vf.h * 0.82);
      this.windows[0].applyRect({
        x: vf.x + Math.round((vf.w - w) / 2),
        y: vf.y + Math.round((vf.h - h) / 2),
        w, h,
      });
      this.windows[1].applyRect({
        x: vf.x + vf.w - 268,
        y: vf.y + Math.round(vf.h * 0.08),
        w: 260,
        h: Math.min(360, vf.h - 20),
      });
    } else {
      this.windows[0].applyRect({
        x: vf.x + Math.round(vf.w * 0.05),
        y: vf.y + Math.round(vf.h * 0.06),
        w: Math.round(vf.w * 0.62),
        h: Math.round(vf.h * 0.7),
      });
      this.windows[1].applyRect({
        x: vf.x + Math.round(vf.w * 0.52),
        y: vf.y + Math.round(vf.h * 0.34),
        w: 260,
        h: Math.min(360, Math.round(vf.h * 0.6)),
      });
    }

    for (const w of this.windows) {
      w.state.maximized = false;
      w.state.restoreRect = null;
    }
  }

  /**
   * 窗口可用的最大矩形（= macOS 的 visible frame）。
   * 绿灯最大化、拖拽/缩放的边界都用它，保证不会盖住菜单栏与 Dock。
   */
  /**
   * Dock 在画布坐标系里实际占用的矩形（含它自己的 padding）。
   * 用它让位比写死常量可靠 —— Dock 的高度/宽度会随图标数量和方向变化。
   */
  dockBounds(): Rect {
    const c = this.canvas.getBoundingClientRect();
    const d = dockEl.getBoundingClientRect();
    const pad = 6;   // 额外留一点呼吸空间
    return {
      x: d.x - c.x - pad,
      y: d.y - c.y - pad,
      w: d.width + pad * 2,
      h: d.height + pad * 2,
    };
  }

  visibleFrame(): Rect {
    const box = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(box.width || DESIGN_W));
    const H = Math.max(1, Math.round(box.height || DESIGN_H));

    const gap = 8;
    let left = gap;
    let right = gap;
    let top = MENUBAR_H + gap;
    let bottom = gap;

    // 按 Dock 实际占位让出空间。用「Dock 中心落在画面的哪一侧」判定，
    // 避免 padding / transition 让边界判断抖动。
    const d = this.dockBounds();
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const dist = {
      bottom: H - cy,
      top: cy - MENUBAR_H,
      left: cx,
      right: W - cx,
    };
    const nearest = (Object.keys(dist) as Array<keyof typeof dist>)
      .sort((a, b) => dist[a] - dist[b])[0];

    if (nearest === "bottom") bottom = Math.max(bottom, H - d.y);
    else if (nearest === "top") top = Math.max(top, d.y + d.h);
    else if (nearest === "left") left = Math.max(left, d.x + d.w);
    else right = Math.max(right, W - d.x);

    return {
      x: left,
      y: top,
      w: Math.max(80, W - left - right),
      h: Math.max(120, H - top - bottom),
    };
  }

  /** Dock 图标在画布坐标系下的矩形。 */
  dockRectFor(name: string): Rect | null {
    const item = dockEl.querySelector<HTMLElement>('[data-dock="' + name + '"]');
    if (!item) return null;
    const c = this.canvas.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    const icon = r.height * 0.6;
    return {
      x: r.left - c.left + (r.width - icon) / 2,
      y: r.top - c.top + (r.height - icon) / 2,
      w: icon,
      h: icon,
    };
  }

  /** 沿行进轴贴画布边缘的目标（演示用，不依赖 Dock）。 */
  /**
   * 按当前 Dock 停靠边算一个「贴边居中」的目标（非对称目标模式用）。
   * Dock 在底部/顶部 → 贴水平边；在左/右 → 贴垂直边。
   */
  edgeTargetFor(edge: DockEdge = this.dockEdge): Rect {
    const box = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(box.width || DESIGN_W));
    const H = Math.max(1, Math.round(box.height || DESIGN_H));
    const icon = Math.max(24, Math.round(Math.min(W, H) * 0.08));
    const margin = 24;

    switch (edge) {
      case "top":
        return { x: W / 2 - icon / 2, y: margin, w: icon, h: icon };
      case "left":
        return { x: margin, y: H / 2 - icon / 2, w: icon, h: icon };
      case "right":
        return { x: W - margin - icon, y: H / 2 - icon / 2, w: icon, h: icon };
      default:
        return { x: W / 2 - icon / 2, y: H - margin - icon, w: icon, h: icon };
    }
  }

  /**
   * 该窗口此刻的收缩目标。
   *
   * 两种模式：
   *   · 默认（Dock 模式）—— 目标恒为**自己的 Dock 图标**，行进轴由图标相对窗口的
   *     方位推导。这才是 macOS 的真实行为，也让「拖进度滑杆」时目标保持一致。
   *   · 非对称目标（free）—— 目标按方向下拉贴画布边缘，用于演示 shader 的轴向。
   */
  targetFor(w: AppWindow): Rect {
    if (this.targetPlacement === "dock") {
      const dock = this.dockRectFor(w.dockId);
      if (dock) return dock;
    }
    return this.edgeTargetFor(this.dockEdge);
  }

  /** 行进方向 —— 由 Dock 停靠边决定（不再依赖「图标在窗口哪一侧」）。 */
  dirFor(_w: AppWindow): GenieDirection {
    return this.direction;
  }

  private refreshWindowTexture(w: AppWindow): void {
    if (!this.pipeline || !this.sampler) return;
    // 强制同步布局：ensureTexture 依赖 offsetWidth，刚写完 style 时需要一次 reflow
    void w.el.offsetWidth;
    const rebuilt = w.ensureTexture(this.pipeline, this.sampler);
    if (rebuilt) requestPaint(this.canvas);
  }

  // ---------------------------------------------------------------- UI

  setupUI(): void {
    genieBtn.addEventListener("click", () => {
      const target = this.activeWindow ?? this.windows[0];
      if (target.state.minimized) this.restoreWindow(target);
      else this.minimizeWindow(target);
    });
    resetBtn.addEventListener("click", () => this.resetAll());

    if (dockEdgeSelect) {
      dockEdgeSelect.innerHTML = "";
      for (const edge of Object.keys(DOCK_EDGE_TO_DIRECTION) as DockEdge[]) {
        const opt = document.createElement("option");
        opt.value = edge;
        opt.textContent = DOCK_EDGE_LABELS[edge];
        opt.selected = edge === this.dockEdge;
        dockEdgeSelect.append(opt);
      }
      dockEdgeSelect.addEventListener("change", () => {
        this.dockEdge = dockEdgeSelect.value as DockEdge;
        this.applyDockEdge();
        this.present();
      });
    }

    if (windowSelect) {
      windowSelect.value = this.windowMode;
      windowSelect.addEventListener("change", () => {
        this.windowMode = windowSelect.value as "full" | "windowed" | "offset";
        this.layoutWindows();
        for (const w of this.windows) this.refreshWindowTexture(w);
        requestPaint(this.canvas);
        this.present();
      });
    }

    if (targetInput) {
      targetInput.addEventListener("input", () => {
        this.targetPlacement = targetInput.checked ? "free" : "dock";
        this.present();
      });
    }

    if (progressRange) {
      progressRange.addEventListener("input", () => {
        this.stopAnimation();
        genieBtn.disabled = false;
        const v = Number(progressRange.value);
        for (const w of this.windows) w.state.playhead = v;
        this.present();
        infoEl.textContent = "Progress " + v.toFixed(2);
      });
    }
  }

  /**
   * 把 Dock 摆到对应的边，并调整它的排列方向。
   *
   *   bottom / top → 横向排列
   *   left / right → 纵向排列（类似 GNOME 的垂直 Dock）
   *
   * 布局用 CSS 类控制（见 style.css 的 #dock.edge-*），
   * 这里只负责切换类名 + 让窗口让出空间。
   */
  applyDockEdge(): void {
    dockEl.classList.remove("edge-bottom", "edge-top", "edge-left", "edge-right");
    dockEl.classList.add("edge-" + this.dockEdge);
    dockEl.dataset.edge = this.dockEdge;

    // CSS 对 Dock 的位置有 180ms transition，必须等它落位后再量尺寸布局，
    // 否则 visibleFrame 会读到动画中途的坐标。
    // 用 transitionend 精确定位结束点，再补一次定时兜底（transition 可能被取消）。
    const relayout = (): void => {
      this.layoutWindows();
      for (const w of this.windows) this.refreshWindowTexture(w);
      requestPaint(this.canvas);
      this.present();
    };

    dockEl.addEventListener("transitionend", relayout, { once: true });
    window.setTimeout(relayout, 260);
    relayout();
  }

  /** 菜单栏：显示当前聚焦 App 名 + 实时时钟。 */
  setupMenubar(): void {
    const tick = (): void => {
      if (!mbClockEl) return;
      const d = new Date();
      mbClockEl.textContent =
        d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" })
        + " " + d.toTimeString().slice(0, 5);
    };
    tick();
    window.setInterval(tick, 15000);
  }

  private syncMenubar(): void {
    if (mbAppEl) mbAppEl.textContent = this.activeWindow?.name ?? "Finder";
  }

  /** Dock 交互：点图标 = 最小化 / 还原对应窗口。 */
  setupDock(): void {
    for (const item of dockEl.querySelectorAll<HTMLElement>("[data-dock]")) {
      const name = item.dataset.dock!;
      item.addEventListener("click", () => {
        const w = this.windows.find((x) => x.dockId === name);
        if (!w) return;
        if (w.state.minimized) this.restoreWindow(w);
        else this.minimizeWindow(w);
      });
    }
    this.updateDockIndicators();
  }

  updateDockIndicators(): void {
    for (const item of dockEl.querySelectorAll<HTMLElement>("[data-dock]")) {
      const name = item.dataset.dock!;
      const w = this.windows.find((x) => x.dockId === name);
      item.classList.toggle("is-open", !!w && !w.state.minimized);
      item.classList.toggle("is-minimized", !!w && w.state.minimized);
    }
  }

  // ---------------------------------------------------------------- 交互

  setupInteractions(): void {
    for (const w of this.windows) {
      // 交通灯
      for (const light of w.el.querySelectorAll<HTMLButtonElement>("[data-action]")) {
        light.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const action = light.dataset.action;
          if (action === "minimize") this.minimizeWindow(w);
          else if (action === "close") this.closeWindow(w);
          else if (action === "maximize") this.toggleMaximize(w);
        });
      }

      // 拖标题栏移动
      const dragHandle = w.el.querySelector<HTMLElement>("[data-drag]");
      if (dragHandle) {
        dragHandle.addEventListener("pointerdown", (ev) => {
          if ((ev.target as HTMLElement).closest("[data-action]")) return;
          this.focusWindow(w);
          this.beginDrag(w, ev);
        });
      }

      // 拖右下角缩放
      const grip = w.el.querySelector<HTMLElement>("[data-resize]");
      if (grip) {
        grip.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          this.focusWindow(w);
          this.beginResize(w, ev);
        });
      }

      // 点任意位置提升焦点
      w.el.addEventListener("pointerdown", () => this.focusWindow(w));

      // 内容变化要重新捕获纹理
      for (const type of ["input", "change", "click"] as const) {
        w.el.addEventListener(type, () => requestPaint(this.canvas));
      }
    }

    this.setupCalculator();
  }

  /** 计算器：真实的 DOM 按钮 + 简单四则运算。 */
  setupCalculator(): void {
    const display = document.getElementById("calc-display");
    let acc: number | null = null;
    let pending: string | null = null;
    let current = "0";
    let resetNext = false;

    const render = (): void => {
      if (display) display.textContent = current;
    };

    const apply = (a: number, b: number, op: string): number => {
      if (op === "+") return a + b;
      if (op === "-") return a - b;
      if (op === "*") return a * b;
      if (op === "/") return b === 0 ? NaN : a / b;
      return b;
    };

    for (const key of calcEl.querySelectorAll<HTMLButtonElement>("[data-key]")) {
      key.addEventListener("click", () => {
        const k = key.dataset.key!;
        if (k >= "0" && k <= "9") {
          current = resetNext || current === "0" ? k : current + k;
          resetNext = false;
        } else if (k === ".") {
          if (!current.includes(".")) current = resetNext ? "0." : current + ".";
          resetNext = false;
        } else if (k === "AC") {
          acc = null;
          pending = null;
          current = "0";
          resetNext = false;
        } else if (k === "+/-") {
          current = current.startsWith("-") ? current.slice(1) : "-" + current;
        } else if (k === "%") {
          current = String(Number(current) / 100);
        } else if (k === "=") {
          if (pending !== null && acc !== null) {
            const v = apply(acc, Number(current), pending);
            current = Number.isFinite(v) ? String(Number(v.toPrecision(12))) : "Error";
            acc = null;
            pending = null;
            resetNext = true;
          }
        } else {
          if (pending !== null && acc !== null && !resetNext) {
            acc = apply(acc, Number(current), pending);
            current = Number.isFinite(acc) ? String(Number(acc.toPrecision(12))) : "Error";
          } else {
            acc = Number(current);
          }
          pending = k;
          resetNext = true;
        }
        render();
        requestPaint(this.canvas);
      });
    }
  }

  private beginDrag(w: AppWindow, ev: PointerEvent): void {
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const orig = { ...w.state.rect };
    // 合成事件 / 某些浏览器下会抛 InvalidPointerId；捕获失败不影响拖拽逻辑
    try { w.el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }

    const move = (e: PointerEvent): void => {
      const vf = this.visibleFrame();
      // 允许拖出可见区域一部分（和 macOS 一致），但始终留一条可抓的边
      const nx = Math.min(
        Math.max(orig.x + (e.clientX - startX), vf.x - orig.w + 80),
        vf.x + vf.w - 80,
      );
      const ny = Math.min(
        Math.max(orig.y + (e.clientY - startY), vf.y),
        vf.y + vf.h - 30,
      );
      w.applyRect({ x: nx, y: ny, w: orig.w, h: orig.h });
      requestPaint(this.canvas);
      this.present();
    };

    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  private beginResize(w: AppWindow, ev: PointerEvent): void {
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const orig = { ...w.state.rect };
    try { w.el.setPointerCapture(ev.pointerId); } catch { /* ignore */ }

    const move = (e: PointerEvent): void => {
      const vf = this.visibleFrame();
      const nw = Math.min(Math.max(orig.w + (e.clientX - startX), 220), vf.x + vf.w - orig.x);
      const nh = Math.min(Math.max(orig.h + (e.clientY - startY), 160), vf.y + vf.h - orig.y);
      w.applyRect({ x: orig.x, y: orig.y, w: nw, h: nh });
      this.refreshWindowTexture(w);
      requestPaint(this.canvas);
      this.present();
    };

    const up = (): void => {
      this.refreshWindowTexture(w);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  focusWindow(w: AppWindow): void {
    if (this.activeWindow === w) return;
    this.activeWindow = w;
    for (const other of this.windows) {
      other.el.classList.toggle("is-focused", other === w);
    }
    w.el.style.zIndex = String(++this.zCounter);
    this.updateDockIndicators();
    this.syncMenubar();
  }

  // ---------------------------------------------------------------- 窗口动作

  toggleMaximize(w: AppWindow): void {
    if (w.state.maximized && w.state.restoreRect) {
      w.applyRect(w.state.restoreRect);
      w.state.maximized = false;
      w.state.restoreRect = null;
    } else {
      // 最大化到 visible frame，而不是整块画布 —— 不盖菜单栏和 Dock
      w.state.restoreRect = { ...w.state.rect };
      w.applyRect(this.visibleFrame());
      w.state.maximized = true;
    }
    this.refreshWindowTexture(w);
    requestPaint(this.canvas);
    this.present();
  }

  /** 红灯：隐藏窗口，并在 Dock 上标记为已最小化（可直接点图标还原）。 */
  closeWindow(w: AppWindow): void {
    w.el.style.visibility = "hidden";
    w.state.minimized = true;
    w.state.playhead = 1;
    infoEl.textContent = w.name + " 已关闭 —— 点 Dock 图标可重新打开。";
    this.updateDockIndicators();
    requestPaint(this.canvas);
    this.present();
  }

  minimizeWindow(w: AppWindow): void {
    if (this.animating.has(w)) return;
    if (w.state.minimized) return;
    this.focusWindow(w);
    this.animating.add(w);
    genieBtn.disabled = true;
    infoEl.textContent = w.name + " 正在收进 Dock…";
    w.state.playhead = 0;

    const start = performance.now();
    const dur = this.animationDuration * 1000;

    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / dur);
      w.state.playhead = t;
      this.present();
      if (t < 1) this.animationId = requestAnimationFrame(tick);
      else this.finishMinimize(w);
    };
    this.animationId = requestAnimationFrame(tick);

    this.clearAnimationFallback();
    const fallback = (): void => {
      if (!this.animating.has(w)) return;
      if (w.state.playhead * dur < performance.now() - start - 120) tick();
      this.animationFallbackId = window.setTimeout(fallback, 50);
    };
    this.animationFallbackId = window.setTimeout(fallback, 50);
  }

  private finishMinimize(w: AppWindow): void {
    this.animating.delete(w);
    this.clearAnimationFallback();
    w.state.playhead = 1;
    w.state.minimized = true;
    genieBtn.disabled = false;
    infoEl.textContent = w.name + " 已收进 Dock —— 点 Dock 图标可以还原。";
    this.updateDockIndicators();
    this.present();
  }

  /** 从 Dock 还原：playhead 从 1 倒放到 0（genie 反向）。 */
  restoreWindow(w: AppWindow): void {
    if (this.animating.has(w)) return;
    this.focusWindow(w);
    w.el.style.visibility = "";
    this.animating.add(w);
    genieBtn.disabled = true;
    infoEl.textContent = w.name + " 正在从 Dock 展开…";

    const start = performance.now();
    const dur = this.animationDuration * 1000;

    const tick = (): void => {
      const t = 1 - Math.min(1, (performance.now() - start) / dur);
      w.state.playhead = t;
      this.present();
      if (t > 0) this.animationId = requestAnimationFrame(tick);
      else this.finishRestore(w);
    };
    this.animationId = requestAnimationFrame(tick);

    this.clearAnimationFallback();
    const fallback = (): void => {
      if (!this.animating.has(w)) return;
      if ((1 - w.state.playhead) * dur < performance.now() - start - 120) tick();
      this.animationFallbackId = window.setTimeout(fallback, 50);
    };
    this.animationFallbackId = window.setTimeout(fallback, 50);
  }

  private finishRestore(w: AppWindow): void {
    this.animating.delete(w);
    this.clearAnimationFallback();
    w.state.playhead = 0;
    w.state.minimized = false;
    genieBtn.disabled = false;
    infoEl.textContent = w.name + " 已展开。";
    this.updateDockIndicators();
    this.present();
  }

  private clearAnimationFallback(): void {
    if (this.animationFallbackId !== null) {
      clearTimeout(this.animationFallbackId);
      this.animationFallbackId = null;
    }
  }

  private stopAnimation(): void {
    this.animating.clear();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.clearAnimationFallback();
  }

  resetAll(): void {
    this.stopAnimation();
    for (const w of this.windows) {
      w.state.playhead = 0;
      w.state.minimized = false;
      w.el.style.visibility = "";
    }
    this.layoutWindows();
    for (const w of this.windows) this.refreshWindowTexture(w);
    genieBtn.disabled = false;
    infoEl.textContent = "已重置。拖标题栏移动窗口，拖右下角缩放，点黄灯收进 Dock。";
    this.updateDockIndicators();
    this.syncMenubar();
    requestPaint(this.canvas);
    this.present();
  }

  // ---------------------------------------------------------------- resize

  setupResize(): void {
    const RECHECK_DELAYS = [60, 160, 400];

    const recheck = (): void => {
      if (applyCanvasSize()) this.onResize();
    };

    const scheduleRechecks = (): void => {
      for (const t of this.resizeTimers.splice(0)) clearTimeout(t);
      for (const delay of RECHECK_DELAYS) {
        this.resizeTimers.push(window.setTimeout(recheck, delay));
      }
    };

    const schedule = (): void => {
      recheck();
      scheduleRechecks();
      if (this.resizeRaf !== null) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = null;
        recheck();
      });
    };

    window.addEventListener("resize", schedule);

    // ⚠️ 不要用 matchMedia('(resolution: Xdppx)') 来监听 DPR 变化：
    // devicePixelRatio 常常是 1.2000000476837158 这种值，把它拼进媒体查询后
    // 永远匹配不上，change 事件就再也不会触发。
    // 改成轻量轮询 —— 每秒读一次 number，代价可以忽略。
    let lastDpr = window.devicePixelRatio || 1;
    this.dprWatchId = window.setInterval(() => {
      const dpr = window.devicePixelRatio || 1;
      if (dpr !== lastDpr) {
        lastDpr = dpr;
        schedule();
      }
    }, 500);
  }

  onResize(): void {
    applyCanvasSize();
    for (const w of this.windows) this.refreshWindowTexture(w);
    if (!this.isResizing) this.present();
  }

  // ---------------------------------------------------------------- 渲染

  present(): void {
    this.draw();
  }

  private draw(): void {
    if (!this.pipeline || !this.sampler) return;

    if (!this.isResizing && applyCanvasSize()) {
      this.isResizing = true;
      try { this.onResize(); } finally { this.isResizing = false; }
    }

    const dpr = renderScale.dpr;
    const viewport = { width: renderScale.pxW, height: renderScale.pxH };

    for (const w of this.windows) {
      const target = this.targetFor(w);
      w.prepare(
        {
          to: target,
          dir: GENIE_DIRECTIONS[this.dirFor(w)],
          animationDuration: this.animationDuration,
          curvePortion: this.timing.curvePortion,
          translationStart: this.timing.translationStart,
        },
        dpr,
        viewport,
      );

      // 形变期间挂起指针事件：命中区只有包围盒精度，着色器又 discard 了漏斗外像素
      const interactive = w.state.playhead <= 0 && !w.state.minimized;
      w.el.style.pointerEvents = interactive ? "" : "none";
    }

    if (progressRange && this.activeWindow) {
      progressRange.value = String(this.activeWindow.state.playhead);
    }
    if (progressValue && this.activeWindow) {
      progressValue.textContent = this.activeWindow.state.playhead.toFixed(2);
    }

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.12, b: 0.18, a: 1.0 },
        loadOp: "clear", storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);

    for (const w of this.windows) {
      if (!w.bindGroup) continue;
      pass.setBindGroup(0, w.bindGroup);
      pass.draw(6);
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

// 这个模块持有 WebGPU 资源与全局监听器，热替换会留下旧实例（点一下触发两次）。
// 声明不可热更新，让 Vite 直接整页刷新。
const hot = (import.meta as unknown as { hot?: { decline(): void } }).hot;
if (hot) hot.decline();

async function run(): Promise<void> {
  const gpu = await initWebGPU();
  if (!gpu) return;
  const app = new GenieApp(gpu.device, gpu.context, gpu.canvasFormat, gpu.canvas);
  await app.init();
  (window as unknown as { __app: GenieApp }).__app = app;
}

run();
