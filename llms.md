# MacOS Genie Effect 实现原理详解：跨平台、跨 API 的通用实现方案

> 参考: [细说如何完美实现 macOS 中的神奇效果](https://daniate.github.io/2021/07/27/%E7%BB%86%E8%AF%B4%E5%A6%82%E4%BD%95%E5%AE%8C%E7%BE%8E%E5%AE%9E%E7%8E%B0macOS%E4%B8%AD%E7%9A%84%E7%A5%9E%E5%A5%87%E6%95%88%E6%9E%9C/)

## 摘要

本文详细阐述了 MacOS Genie Effect 的数学原理和实现方法，提供了一套完整的、与平台无关的实现方案。通过深入解析 WebGPU 中的 WGSL 实现，本文将帮助任何 AI 模型或开发者在任意图形 API（包括 WebGPU、OpenGL、DirectX、Metal 等）和环境中复现这一经典动画效果。

## 1. 引言

MacOS Genie Effect 是苹果操作系统中一个标志性的窗口最小化动画效果，窗口在最小化时会像被"吸入"Dock 一样进行变形收缩。该效果因其流畅自然的动画而广受赞誉。本文将从数学原理出发，深入解析该效果的实现细节，提供一套可跨平台、跨 API 复现的通用方案。

## 2. 实现原理概述

Genie Effect 的实现可以分解为两个关键阶段：

1. **水平变形（曲线收缩）**：窗口顶部逐渐变窄，形成曲线形状
2. **垂直移动（向下收缩）**：窗口内容向目标位置移动并收缩

这两个动画阶段在时间上略有重叠，创造出流畅自然的视觉效果。

## 3. 数学原理详解

### 3.1 曲线变形原理

曲线变形通过正弦函数实现，对于窗口的每一行（垂直位置 y），计算该行左侧和右侧的新边界位置。

#### 左侧曲线函数：

```
x_left = A * sin(π * y - π/2) + D
```

#### 右侧曲线函数：

```
x_right = A * sin(π * y + π/2) + D
```

其中：

- `A` 是振幅参数，控制曲线的弯曲程度
- `D` 是偏移参数，控制曲线的中心位置
- `y` 是当前像素的垂直归一化坐标 (0.0-1.0)

### 3.2 参数计算

在动画过程中，参数 A 和 D 需要根据动画进度动态计算：

#### 左侧曲线参数：

```
left_D = left_max / 2.0
left_A = left_D
```

#### 右侧曲线参数：

```
right_D = (right_min + 1.0) / 2.0
right_A = 1.0 - right_D
```

其中 `left_max` 和 `right_min` 是根据动画进度插值得到的参数。

### 3.3 垂直移动原理

垂直移动通过简单地将纹理坐标向上偏移实现：

```
y_transformed = y_original - translation_progress
```

## 4. 核心实现代码解析

### 4.1 顶点着色器实现

顶点着色器的主要任务是将顶点坐标从像素坐标转换为标准化设备坐标(NDC)：

```wgsl
struct VertexInput {
    @location(0) position : vec2<f32>,
    @location(1) uv : vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};

struct CanvasDimensions {
    width : f32,
    height : f32,
};

@group(1) @binding(0) var<uniform> canvas_dims : CanvasDimensions;

@vertex
fn main_vertex(input: VertexInput) -> VertexOutput {
    var output : VertexOutput;
    // Convert from pixel coordinates (0-width, 0-height) to NDC (-1 to 1)
    let x_ndc = (input.position.x / canvas_dims.width) * 2.0 - 1.0;
    let y_ndc = 1.0 - (input.position.y / canvas_dims.height) * 2.0; // Flip Y
    output.position = vec4<f32>(x_ndc, y_ndc, 0.0, 1.0);
    output.uv = input.uv;
    return output;
}
```

### 4.2 片段着色器实现

片段着色器包含了 Genie Effect 的核心实现逻辑：

```wgsl
struct FragmentInput {
    @location(0) uv : vec2<f32>,
};

struct Uniforms {
    time : f32,
    curve_duration : f32,
    translation_duration : f32,
    left_max_end : f32,
    right_min_end : f32,
    target_x : f32,
    target_width : f32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var t : texture_2d<f32>;
@group(0) @binding(2) var s : sampler;

@fragment
fn main_fragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let pi = 3.14159265359;

    // 计算动画总时长
    let total_curve_duration = uniforms.curve_duration;
    let total_translation_duration = uniforms.translation_duration;
    let total_animation_duration = total_curve_duration + total_translation_duration;

    // 限制时间在动画范围内
    let clamped_time = clamp(uniforms.time, 0.0, total_animation_duration);

    // 1. 顶部收缩动画（曲线变形）
    let curve_progress = clamp(clamped_time / total_curve_duration, 0.0, 1.0);

    // 计算当前曲线参数
    let left_max = curve_progress * uniforms.left_max_end;
    let right_min = 1.0 - curve_progress * (1.0 - uniforms.right_min_end);

    // 左侧曲线参数计算
    let left_D = left_max / 2.0;
    let left_A = left_D;
    let left_curve_x = left_A * sin(pi * input.uv.y - pi * 0.5) + left_D;

    // 右侧曲线参数计算
    let right_D = (right_min + 1.0) / 2.0;
    let right_A = 1.0 - right_D;
    let right_curve_x = right_A * sin(pi * input.uv.y + pi * 0.5) + right_D;

    // 2. 垂直移动动画
    var translation_progress = 0.0;
    if (clamped_time > total_curve_duration) {
        translation_progress = clamp((clamped_time - total_curve_duration) / total_translation_duration, 0.0, 1.0);
    }

    // 3. 应用变换到UV坐标
    var transformed_uv_x = input.uv.x;
    if (right_curve_x > left_curve_x) {
        transformed_uv_x = (input.uv.x - left_curve_x) / (right_curve_x - left_curve_x);
    } else {
        // 曲线交叉时丢弃像素
        discard;
    }

    // 应用垂直变换
    let transformed_uv_y = input.uv.y - translation_progress;
    let transformed_uv = vec2<f32>(transformed_uv_x, transformed_uv_y);

    // 4. 丢弃屏幕外的像素
    if (input.uv.x < left_curve_x || input.uv.x > right_curve_x || transformed_uv_y < 0.0) {
        discard;
    }

    // 5. 采样纹理
    return textureSample(t, s, transformed_uv);
}
```

## 5. 跨平台移植指南

要将此实现在其他图形 API（如 OpenGL、DirectX、Metal 等）中重现，请遵循以下步骤：

### 5.1 顶点着色器移植

1. 将像素坐标转换为对应 API 的顶点坐标系统
2. 传递 UV 坐标到片段着色器

### 5.2 片段着色器移植

1. 实现相同的正弦曲线计算逻辑
2. 使用对应 API 的纹理采样函数
3. 正确处理像素丢弃操作（在某些 API 中可能需要其他方式实现）

### 5.3 参数传递

1. 将 uniform 参数传递给着色器（时间、持续时间、目标位置等）
2. 传递纹理和采样器对象

### 5.4 数学函数

1. 确保使用相同的数学函数（sin、clamp 等）
2. 保持 π 值的一致性（建议使用 3.14159265359）

## 6. 动画参数说明

- `time`：当前动画时间（秒）
- `curve_duration`：曲线变形动画持续时间
- `translation_duration`：垂直移动动画持续时间
- `left_max_end`：左侧曲线最终收缩位置
- `right_min_end`：右侧曲线最终收缩位置
- `target_x`：目标位置 X 坐标
- `target_width`：目标宽度

## 7. 实现细节和优化建议

### 7.1 时间控制

动画分为两个阶段：

1. 曲线变形阶段（先开始）
2. 垂直移动阶段（稍后开始）

两个阶段有部分重叠以获得更自然的效果。

### 7.2 边界处理

当左右曲线相交或交叉时，应丢弃像素以避免视觉异常：

```wgsl
if (right_curve_x > left_curve_x) {
    // 正常处理
} else {
    discard;
}
```

### 7.3 坐标系统一致性

确保所有坐标系统的一致性：

- UV 坐标范围：[0.0, 1.0]
- 屏幕坐标转换正确处理
- Y 轴方向在不同 API 中可能需要翻转

## 8. 总结

通过使用正弦函数和时间参数，我们可以创建出流畅自然的 Genie Effect 动画。该实现的核心在于：

1. 使用正弦函数创建自然的曲线变形
2. 分阶段处理动画，使效果更加流畅
3. 正确处理纹理坐标变换和像素丢弃

这种实现方式不仅适用于 WebGPU，也可以轻松移植到其他图形 API 中。通过调整参数，可以创建出不同风格的 Genie Effect，满足各种设计需求。

本文提供了一套完整的、与平台无关的实现方案，任何 AI 模型或开发者都可以基于此方案在任意支持着色器的平台和环境中复现 MacOS Genie Effect 效果。
