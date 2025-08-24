
struct FragmentInput {
    @location(0) uv : vec2<f32>, // UV from vertex shader (0-1 across window)
};
// Uniforms for animation control
struct Uniforms {
    time : f32, // Animation time in seconds
    curve_duration : f32, // Duration for curve animation (seconds)
    translation_duration : f32, // Duration for translation (suck) animation (seconds)
    left_max_end : f32, // Final max value for left curve
    right_min_end : f32, // Final min value for right curve
    target_x : f32, // Target X position for genie effect (dock location)
    target_width : f32, // Target width for genie effect
};
@group(0) @binding(0) var<uniform> uniforms : Uniforms;
// Texture and sampler
@group(0) @binding(1) var t : texture_2d<f32>;
@group(0) @binding(2) var s : sampler;
@fragment
fn main_fragment(input: FragmentInput) -> @location(0) vec4<f32> {
    let pi = 3.14159265359;
    // 1. Calculate animation progress
    let total_curve_duration = uniforms.curve_duration;
    let total_translation_duration = uniforms.translation_duration;
    let total_animation_duration = total_curve_duration + total_translation_duration;
    // Clamp time to animation duration
    let clamped_time = clamp(uniforms.time, 0.0, total_animation_duration);
    // 2. Top Narrowing (Curve Animation) happens first
    // Calculate progress for curve animation (0.0 to 1.0)
    let curve_progress = clamp(clamped_time / total_curve_duration, 0.0, 1.0);
    
    // Calculate current curve parameters based on progress
    let left_max = curve_progress * uniforms.left_max_end;
    let right_min = 1.0 - curve_progress * (1.0 - uniforms.right_min_end);
    // Calculate A and D for left curve: A * sin(PI * y - PI/2) + D (top narrowing)
    // D - A = 0, D + A = left_max => D = A = left_max / 2
    let left_D = left_max / 2.0;
    let left_A = left_D;
    let left_curve_x = left_A * sin(pi * input.uv.y - pi * 0.5) + left_D;
    // Calculate A and D for right curve: A * sin(PI * y + PI/2) + D (top narrowing)
    // D - A = right_min, D + A = 1 => D = (right_min + 1) / 2, A = 1 - D
    let right_D = (right_min + 1.0) / 2.0;
    let right_A = 1.0 - right_D;
    let right_curve_x = right_A * sin(pi * input.uv.y + pi * 0.5) + right_D;
    // 3. Downward Expansion (Translation Animation) happens after curve animation starts
    // Calculate progress for translation animation (0.0 to 1.0)
    var translation_progress = 0.0;
    if (clamped_time > total_curve_duration) {
        translation_progress = clamp((clamped_time - total_curve_duration) / total_translation_duration, 0.0, 1.0);
    }
    // 4. Apply transformations to UV
    // Remap UV.x based on current left/right curve boundaries
    var transformed_uv_x = input.uv.x;
    if (right_curve_x > left_curve_x) { // Avoid division by zero or negative width
        transformed_uv_x = (input.uv.x - left_curve_x) / (right_curve_x - left_curve_x);
    } else {
        // If curves have crossed or met, make it transparent
        discard;
    }
    // Apply vertical translation (move upward to simulate downward expansion from bottom)
    let transformed_uv_y = input.uv.y - translation_progress;
    let transformed_uv = vec2<f32>(transformed_uv_x, transformed_uv_y);
    // 5. Discard pixels outside the transformed boundaries or moved off-screen
    if (input.uv.x < left_curve_x || input.uv.x > right_curve_x || transformed_uv_y < 0.0) {
        discard; // Make pixel transparent
    }
    // 6. Sample the texture with the transformed UV
    return textureSample(t, s, transformed_uv);
}