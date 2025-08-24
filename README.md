# MacOS Genie Effect with WebGPU

本项目基于 WebGPU 在 web 中实现 `MacOS Genie Effect`，这是 macOS 系统中经典的窗口最小化动画效果。

![MacOS Genie Effect 示例](./assets/genie-effect.gif)

## 介绍

MacOS Genie Effect 是苹果操作系统中一个标志性的窗口最小化动画效果，窗口在最小化时会像被"吸入"Dock一样进行变形收缩。该效果因其流畅自然的动画而广受赞誉。

本项目使用 WebGPU 技术在浏览器中重现了这一经典动画效果，无需任何插件或额外依赖。

## 功能特点

- 还原 MacOS Genie Effect 动画效果

## 快速开始

### 环境要求

- Node.js (推荐 v18+)
- pnpm (或 npm/yarn)
- 支持 WebGPU 的现代浏览器（Chrome 113+, Edge 113+, Firefox Nightly with flag）

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

这将在本地启动开发服务器，通常在 http://localhost:5173

### 构建项目

```bash
pnpm build
```

构建后的文件将位于 `dist` 目录中。

### 预览构建结果

```bash
pnpm preview
```

## 项目结构

```
src/
├── main.ts          # 主入口文件，包含 WebGPU 初始化和渲染逻辑
├── shaders/         # WGSL 着色器文件
│   └── effect/
│       ├── Genie.fragment.wgsl   # 片段着色器
│       └── Genie.vertex.wgsl     # 顶点着色器
├── wgsl.d.ts        # WGSL 模块声明文件
llms.md              # LLMs 技术文档
AGENTS.md            # AI Agent 使用指南
index.html           # HTML 入口文件
```

## 技术细节

更多关于 MacOS Genie Effect 的数学原理和实现细节，请查看 [llms.md](./llms.md) 文件。

## 更多

1. [llms](./llms.md)
2. [agents](./AGENTS.md)

# 感谢

1. [细说如何完美实现 macOS 中的神奇效果](https://daniate.github.io/2021/07/27/%E7%BB%86%E8%AF%B4%E5%A6%82%E4%BD%95%E5%AE%8C%E7%BE%8E%E5%AE%9E%E7%8E%B0macOS%E4%B8%AD%E7%9A%84%E7%A5%9E%E5%A5%87%E6%95%88%E6%9E%9C/)