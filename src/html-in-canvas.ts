// HTML-in-Canvas 运行时封装 + 类型补充（从 liquid-glass-cloth 复用，已验证）。
//
// 三代 API（结构完全不同，混用会直接抛错）：
//   1. Chrome 155+  最终版：queue.drawElementImageToTexture({source}, {texture, size})
//   2. Chrome 150-154 中间版：queue.copyElementImageToTexture({source}, {destination:{texture}, width, height})
//   3. Chrome <150   旧版：queue.copyElementImageToTexture(element, width, height, {texture})
//
// 降级策略与官方 jelly-slider 示例一致：用 try/catch 级联，
// 因为「方法存在但签名不符」是真实存在的情况，typeof/fn.length 都不够可靠。

// ------------------------------------------------------------------ 类型

/**
 * drawable 元素的快照引用，可 transfer 到 worker。
 * 规范里它是独立接口（由 canvas.captureElementImage 返回），
 * 目前浏览器类型库尚未收录，这里按不透明句柄声明。
 */
export interface ElementImage {
  readonly __elementImage?: unique symbol;
}

export interface ElementImageDefaultSize {
  width: number;
  height: number;
}

export interface UpdateElementGeometryOptions {
  preserveHitTestOrder?: boolean;
  canvasClip?: DOMRectInit;
  canvasTransform?: DOMMatrixInit;
}

interface DrawElementImageDestination {
  texture: GPUTexture;
  size?: GPUExtent3D;
  origin?: GPUOrigin3D;
  mipLevel?: GPUIntegerCoordinate;
  aspect?: GPUTextureAspect;
  colorSpace?: PredefinedColorSpace;
  premultipliedAlpha?: boolean;
}

interface LegacyCopyDestination {
  destination: { texture: GPUTexture };
  width?: number;
  height?: number;
}

interface DrawElementImageSource {
  source: Element | ElementImage;
  sourceX?: number;
  sourceY?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

interface ElementQueueExtras {
  drawElementImageToTexture?: (
    source: DrawElementImageSource,
    dest: DrawElementImageDestination,
  ) => void;
  copyElementImageToTexture?: (
    (source: DrawElementImageSource, dest: LegacyCopyDestination) => void
  ) & ((element: Element, width: number, height: number, dest: { texture: GPUTexture }) => void);
}

/** canvas 上 HTML-in-Canvas 新增的成员。 */
export interface CanvasExtras {
  content?: 'fallback' | 'drawable';
  onpaint?: ((event: Event) => void) | null;
  requestPaint?(): void;
  captureElementImage?(element: Element): ElementImage;
  updateElementGeometry?(
    element: Element | ElementImage,
    options?: UpdateElementGeometryOptions,
  ): void;
  clearElementGeometry?(element: Element | ElementImage): void;
  getElementTransform?(element: Element, screenSpaceTransform?: DOMMatrix): DOMMatrix;
  getElementImageDefaultSize?(element: Element | ElementImage): ElementImageDefaultSize;
  onelementgeometryupdate?: ((event: Event) => void) | null;
}

/** 实际生效的 API 世代。 */
export type ApiGeneration = 'final' | 'dict' | 'legacy4' | 'none';

// ------------------------------------------------------------------ 探测

export function canvasExtras(canvas: HTMLCanvasElement): CanvasExtras {
  return canvas as unknown as CanvasExtras;
}

function queueExtras(queue: GPUQueue): ElementQueueExtras {
  return queue as unknown as ElementQueueExtras;
}

/** canvas 侧能力（requestPaint 是最基础的入口）。 */
export function isSupported(canvas: HTMLCanvasElement): boolean {
  return typeof canvasExtras(canvas).requestPaint === 'function';
}

/** queue 侧能力：能否把元素画进纹理。 */
export function supportsElementTexture(queue: GPUQueue): boolean {
  const q = queueExtras(queue);
  return (
    typeof q.drawElementImageToTexture === 'function' ||
    typeof q.copyElementImageToTexture === 'function'
  );
}

// ------------------------------------------------------------------ 尺寸

/**
 * 元素在 canvas 网格坐标下的像素尺寸。
 * 官方推荐用 getElementImageDefaultSize（已含 DPR 换算），
 * 缺失时回退到 offsetWidth × devicePixelRatio。
 *
 * ⚠️ 实测坑：元素还没有任何 paint 记录时，该 API 会抛
 * `InvalidStateError: No cached paint record for element`。
 * 首帧必然命中，必须 try/catch 后回退。
 */
export function elementImageSize(
  canvas: HTMLCanvasElement,
  element: HTMLElement,
): ElementImageDefaultSize {
  const fallback: ElementImageDefaultSize = {
    width: Math.max(1, Math.round(element.offsetWidth * (window.devicePixelRatio || 1))),
    height: Math.max(1, Math.round(element.offsetHeight * (window.devicePixelRatio || 1))),
  };

  const getSize = canvasExtras(canvas).getElementImageDefaultSize;
  if (typeof getSize === 'function') {
    try {
      const s = getSize.call(canvas, element);
      if (s && s.width > 0 && s.height > 0) return s;
    } catch {
      /* 尚无 paint 记录，使用回退值 */
    }
  }

  return fallback;
}

// ------------------------------------------------------------------ 上传

/**
 * 把元素快照画进纹理，返回实际生效的世代。
 * 顺序：最终版 → 中间版 → 旧 4 参数版。
 */
export function drawElementToTexture(
  queue: GPUQueue,
  element: Element,
  texture: GPUTexture,
  width: number,
  height: number,
): ApiGeneration {
  const q = queueExtras(queue);

  if (typeof q.drawElementImageToTexture === 'function') {
    try {
      q.drawElementImageToTexture({ source: element }, { texture, size: { width, height } });
      return 'final';
    } catch {
      /* 降级 */
    }
  }

  if (typeof q.copyElementImageToTexture === 'function') {
    try {
      q.copyElementImageToTexture(
        { source: element },
        { destination: { texture }, width, height },
      );
      return 'dict';
    } catch {
      try {
        q.copyElementImageToTexture(element, width, height, { texture });
        return 'legacy4';
      } catch {
        /* 全部失败 */
      }
    }
  }

  return 'none';
}

/** 请求一次 paint（即使没有 DOM 变化也触发）。 */
export function requestPaint(canvas: HTMLCanvasElement): void {
  canvasExtras(canvas).requestPaint?.();
}

/** 注册 paint 事件（onpaint 优先，回退 addEventListener）。 */
export function onPaint(canvas: HTMLCanvasElement, handler: () => void): void {
  const el = canvasExtras(canvas);
  if ('onpaint' in el) {
    el.onpaint = handler;
  } else {
    canvas.addEventListener('paint', handler);
  }
}

// ------------------------------------------------------------------ 几何同步

/**
 * 把元素的 DOM 几何（命中测试 + 无障碍焦点环）同步到它在 canvas 上的绘制位置。
 *
 * 3D 上下文（WebGL/WebGPU）不会自动同步几何，必须手动调用；
 * 2D 的 drawElementImage 才会自动调用。
 *
 * ⚠️ 用 updateElementGeometry 时不要再写 element.style.transform —— 它同时
 * 负责视觉位置与命中测试。
 *
 * ⚠️ 传给这里的宽高是「可见包围盒」的尺寸：动画中它是一条被裁掉上沿的矩形，
 * 所以命中区是包围盒而不是真正的梯形 —— 动画期间元素本就不可交互，
 * 精度需求集中在首尾两端（0 时精确等于窗口，1 时完全移出画面）。
 */
export function syncElementGeometry(
  canvas: HTMLCanvasElement,
  element: HTMLElement,
  cssX: number,
  cssY: number,
  cssWidth: number,
  cssHeight: number,
): 'updateElementGeometry' | 'transform' {
  const el = canvasExtras(canvas);
  const scaleX = cssWidth / Math.max(1, element.offsetWidth);
  const scaleY = cssHeight / Math.max(1, element.offsetHeight);

  if (typeof el.updateElementGeometry === 'function') {
    el.updateElementGeometry(element, {
      canvasTransform: new DOMMatrix().translate(cssX, cssY).scale(scaleX, scaleY),
    });
    return 'updateElementGeometry';
  }

  element.style.transform = `translate(${cssX}px, ${cssY}px) scale(${scaleX}, ${scaleY})`;
  return 'transform';
}
