# AI Agent 使用指南

本文档为 AI Agent 提供了关于此 MacOS Genie Effect 项目的详细信息和操作指南。

## 项目概述

这是一个使用 WebGPU 技术在浏览器中实现 MacOS Genie Effect 动画效果的前端项目。MacOS Genie Effect 是苹果操作系统中窗口最小化时的经典动画，窗口会像被"吸入"Dock一样进行变形收缩。

## 核心功能

1. 使用 WebGPU 渲染技术实现高性能图形动画
2. 实现了经典的 MacOS Genie Effect 动画效果
3. 提供交互式控制界面

## 项目结构

```
.
├── index.html              # 主页面文件
├── package.json            # 项目配置和依赖
├── tsconfig.json           # TypeScript 配置
├── src/
│   ├── main.ts             # 主入口文件，包含 WebGPU 初始化和渲染逻辑
│   ├── wgsl.d.ts           # WGSL 模块声明文件
│   └── shaders/
│       └── effect/
│           ├── Genie.fragment.wgsl   # 片段着色器
│           └── Genie.vertex.wgsl     # 顶点着色器
├── llms.md                 # 技术实现细节文档
└── README.md               # 项目说明文档
```

## 技术栈

- TypeScript: 主要编程语言
- WebGPU: 图形渲染 API
- WGSL: WebGPU 着色器语言
- Vite: 构建工具

## 核心实现文件

### index.html

包含页面结构和基础样式，定义了:
- WebGPU 画布元素 (`#webgpu-canvas`)
- 控制按钮 (`#genie-btn` 和 `#reset-btn`)
- 基础 CSS 样式

### src/main.ts

这是项目的核心文件，包含以下主要功能:

1. WebGPU 初始化
2. 着色器代码加载
3. 几何体创建（全屏四边形、Dock、图标）
4. 纹理创建
5. 渲染管线配置
6. 动画循环实现
7. 用户交互处理

### 着色器文件

#### Genie.vertex.wgsl

顶点着色器，主要功能:
- 将顶点坐标从像素坐标转换为标准化设备坐标(NDC)
- 传递 UV 坐标到片段着色器

#### Genie.fragment.wgsl

片段着色器，实现 Genie Effect 的核心逻辑:
- 根据动画进度计算窗口变形
- 实现正弦曲线变形效果
- 处理纹理采样

## 运行项目

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm dev
```

### 构建项目

```bash
pnpm build
```

## 关键代码说明

### WebGPU 初始化

在 [src/main.ts](file:///c%3A/Users/AnNingUI/Downloads/t/macos-genie-webgpu/src/main.ts) 中，首先检查浏览器是否支持 WebGPU，然后初始化设备和上下文：

```typescript
async function initWebGPU(): Promise<{
    device: GPUDevice;
    context: GPUCanvasContext;
    canvasFormat: GPUTextureFormat;
    canvas: HTMLCanvasElement;
} | null> {
    if (!navigator.gpu) {
        alert("WebGPU not supported!");
        return null;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        alert("No appropriate GPUAdapter found.");
        return null;
    }
    const device = await adapter.requestDevice();
    const canvas = document.getElementById("webgpu-canvas") as HTMLCanvasElement;
    const context = canvas.getContext("webgpu") as GPUCanvasContext;

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: device,
        format: canvasFormat,
        alphaMode: "opaque",
    });

    return { device, context, canvasFormat, canvas };
}
```

### 动画实现

动画通过修改 Uniform Buffer 中的参数实现，主要包括:

1. `progress`: 动画进度 (0.0-1.0)
2. `leftMax`: 左侧最大变形参数
3. `rightMin`: 右侧最小变形参数
4. `verticalShift`: 垂直位移参数

### 着色器中的变形计算

在片段着色器中，根据当前像素的 Y 坐标和动画参数计算变形后的纹理坐标：

```wgsl
// 应用水平变形（曲线收缩）
// 使用正弦函数创建曲线效果
let y_norm = uv.y;
var left_max = params.leftMax;
var right_min = params.rightMin;

// 左侧曲线: x = A * sin(PI * y - PI/2) + D
let left_D = left_max / 2.0;
let left_A = left_D;
var new_x_left = left_A * sin(PI * y_norm - PI / 2.0) + left_D;

// 右侧曲线: x = A * sin(PI * y + PI/2) + D
let right_D = (right_min + 1.0) / 2.0;
let right_A = 1.0 - right_D;
var new_x_right = right_A * sin(PI * y_norm + PI / 2.0) + right_D;

// 根据当前x坐标在原窗口中的相对位置，插值计算变形后的位置
let x_ratio = (uv.x - new_x_left) / (new_x_right - new_x_left);
var transformed_x = left_max + x_ratio * (right_min - left_max);

// 应用垂直移动（向下收缩）
let progress = params.progress;
let vertical_shift = progress * y_norm;
var transformed_y = uv.y - vertical_shift;
```

## 可能的修改和扩展

1. 调整动画参数以改变效果强度和时间
2. 修改着色器以实现不同的变形曲线
3. 添加更多交互控制（如调整变形方向、速度等）
4. 实现多个窗口的动画效果
5. 添加音效配合动画

## 常见问题

### WebGPU 兼容性

WebGPU 是一项较新的技术，需要现代浏览器支持。如果遇到兼容性问题，请确保使用最新版本的 Chrome、Edge 或 Firefox（需开启实验性功能）。

### 性能问题

如果动画不够流畅，可能是由于设备性能不足或浏览器限制。可以尝试降低画布分辨率或简化着色器逻辑。

## 参考资料

- [llms.md](./llms.md) - 技术实现细节文档
- [细说如何完美实现 macOS 中的神奇效果](https://daniate.github.io/2021/07/27/%E7%BB%86%E8%AF%B4%E5%A6%82%E4%BD%95%E5%AE%8C%E7%BE%8E%E5%AE%9E%E7%8E%B0macOS%E4%B8%AD%E7%9A%84%E7%A5%9E%E5%A5%87%E6%95%88%E6%9E%9C/)