
struct VertexInput {
    @location(0) position : vec2<f32>,
    @location(1) uv : vec2<f32>,
};
struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) uv : vec2<f32>,
};
// Uniforms for canvas dimensions
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