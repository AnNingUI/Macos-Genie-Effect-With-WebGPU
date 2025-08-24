import genie_f from "./shaders/effect/Genie.fragment.wgsl?raw";
import genie_v from "./shaders/effect/Genie.vertex.wgsl?raw";
// --- Utility Functions ---
function lerp(start: number, end: number, t: number): number {
	return start + (end - start) * t;
}

// --- WebGPU Core ---
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

// --- Shaders ---
// Vertex shader: Simple pass-through, converts quad to NDC using uniforms, passes UVs
const vertexShaderWGSL = genie_v;

// Fragment shader: Implements the Genie effect logic
const fragmentShaderWGSL = genie_f;

// --- Geometry and Textures ---
function createFullscreenQuadBuffer(device: GPUDevice): GPUBuffer {
	// Define a quad covering the window area in pixel coordinates
	// Positions (x,y) and UVs (u,v)
	const vertices = new Float32Array([
		// positions (pixels)  // uvs
		0,
		0,
		0,
		0, // Top-left
		800,
		0,
		1,
		0, // Top-right
		800,
		600,
		1,
		1, // Bottom-right
		0,
		600,
		0,
		1, // Bottom-left
	]);

	const vertexBuffer = device.createBuffer({
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX,
		mappedAtCreation: true,
	});
	new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
	vertexBuffer.unmap();
	return vertexBuffer;
}

function createIndexBuffer(device: GPUDevice): GPUBuffer {
	const indices = new Uint16Array([0, 1, 2, 0, 2, 3]); // Triangle list
	const indexBuffer = device.createBuffer({
		size: indices.byteLength,
		usage: GPUBufferUsage.INDEX,
		mappedAtCreation: true,
	});
	new Uint16Array(indexBuffer.getMappedRange()).set(indices);
	indexBuffer.unmap();
	return indexBuffer;
}

// Create dock geometry
function createDockBuffer(device: GPUDevice): GPUBuffer {
	// Define a dock at the bottom of the screen (800x60)
	const vertices = new Float32Array([
		// positions (pixels)  // uvs
		0,
		540,
		0,
		0, // Top-left
		800,
		540,
		1,
		0, // Top-right
		800,
		600,
		1,
		1, // Bottom-right
		0,
		600,
		0,
		1, // Bottom-left
	]);

	const vertexBuffer = device.createBuffer({
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX,
		mappedAtCreation: true,
	});
	new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
	vertexBuffer.unmap();
	return vertexBuffer;
}

// Create icon geometry
function createIconBuffer(
	device: GPUDevice,
	x: number,
	y: number,
	size: number
): GPUBuffer {
	const halfSize = size / 2;
	const vertices = new Float32Array([
		// positions (pixels)  // uvs
		x - halfSize,
		y - halfSize,
		0,
		0, // Top-left
		x + halfSize,
		y - halfSize,
		1,
		0, // Top-right
		x + halfSize,
		y + halfSize,
		1,
		1, // Bottom-right
		x - halfSize,
		y + halfSize,
		0,
		1, // Bottom-left
	]);

	const vertexBuffer = device.createBuffer({
		size: vertices.byteLength,
		usage: GPUBufferUsage.VERTEX,
		mappedAtCreation: true,
	});
	new Float32Array(vertexBuffer.getMappedRange()).set(vertices);
	vertexBuffer.unmap();
	return vertexBuffer;
}

async function createWindowTexture(
	device: GPUDevice,
	width: number,
	height: number
): Promise<GPUTexture> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");

	if (!ctx) {
		console.error("Could not get 2D context for texture creation");
		// Fallback to a simple color
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 150; // R
			data[i + 1] = 200; // G
			data[i + 2] = 255; // B
			data[i + 3] = 255; // A
		}
		const texture = device.createTexture({
			size: [width, height],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		device.queue.writeTexture(
			{ texture: texture },
			data,
			{ bytesPerRow: width * 4 },
			[width, height]
		);
		return texture;
	}

	// Draw a simple window-like graphic
	// Background
	ctx.fillStyle = "#a0c8ff"; // Light blue
	ctx.fillRect(0, 0, width, height);

	// Title bar
	ctx.fillStyle = "#e0e0e0";
	ctx.fillRect(0, 0, width, 20);

	// Title bar text
	ctx.fillStyle = "#333";
	ctx.font = "12px Arial";
	ctx.fillText("My Window", 10, 15);

	// Close button
	ctx.fillStyle = "#ff5555";
	ctx.fillRect(width - 20, 5, 15, 15);
	ctx.strokeStyle = "#fff";
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(width - 15, 10);
	ctx.lineTo(width - 5, 20);
	ctx.moveTo(width - 5, 10);
	ctx.lineTo(width - 15, 20);
	ctx.stroke();

	// Content area
	ctx.fillStyle = "#000";
	ctx.font = "16px Arial";
	ctx.fillText("This is the window content.", 20, 50);
	ctx.fillText("It will be transformed by the shader.", 20, 80);

	// Create texture from canvas
	const texture = device.createTexture({
		size: [width, height],
		format: "rgba8unorm", // Match canvas format
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});

	// Copy canvas content to texture
	// Note: This assumes the canvas is already drawn
	const imageData = ctx.getImageData(0, 0, width, height);
	device.queue.writeTexture(
		{ texture: texture },
		imageData.data,
		{ bytesPerRow: imageData.width * 4 },
		[imageData.width, imageData.height]
	);

	return texture;
}

// --- Main Application ---
class WebGPUApp {
	device: GPUDevice;
	context: GPUCanvasContext;
	canvasFormat: GPUTextureFormat;
	canvas: HTMLCanvasElement;
	canvasWidth: number;
	canvasHeight: number;

	vertexBuffer: GPUBuffer | null;
	dockBuffer: GPUBuffer | null;
	iconBuffers: GPUBuffer[];
	indexBuffer: GPUBuffer | null;
	pipeline: GPURenderPipeline | null;
	dockPipeline: GPURenderPipeline | null;
	iconPipeline: GPURenderPipeline | null;
	sampler: GPUSampler | null;
	texture: GPUTexture | null;
	uniformBuffer: GPUBuffer | null;
	canvasDimsBuffer: GPUBuffer | null;
	bindGroup0: GPUBindGroup | null;
	dockBindGroup: GPUBindGroup | null;
	iconBindGroup: GPUBindGroup | null;
	bindGroup1: GPUBindGroup | null;

	startTime: number;
	isAnimating: boolean;
	animationId: number | null;
	animationDuration: number;

	// --- Animation Parameters ---
	curveDuration: number;
	translationDuration: number;
	leftMaxEnd: number;
	rightMinEnd: number;
	targetX: number;
	targetWidth: number;

	constructor(
		device: GPUDevice,
		context: GPUCanvasContext,
		canvasFormat: GPUTextureFormat,
		canvas: HTMLCanvasElement
	) {
		this.device = device;
		this.context = context;
		this.canvasFormat = canvasFormat;
		this.canvas = canvas;
		this.canvasWidth = canvas.width;
		this.canvasHeight = canvas.height;

		this.vertexBuffer = null;
		this.dockBuffer = null;
		this.iconBuffers = [];
		this.indexBuffer = null;
		this.pipeline = null;
		this.dockPipeline = null;
		this.iconPipeline = null;
		this.sampler = null;
		this.texture = null;
		this.uniformBuffer = null;
		this.canvasDimsBuffer = null;
		this.bindGroup0 = null;
		this.dockBindGroup = null;
		this.iconBindGroup = null;
		this.bindGroup1 = null;

		this.startTime = 0;
		this.isAnimating = false;
		this.animationId = null;
		this.animationDuration = 0.8; // seconds

		// --- Animation Parameters ---
		this.curveDuration = 0.3; // seconds
		this.translationDuration = 0.5; // seconds (total - curve)
		this.leftMaxEnd = 0.5; // Final max value for left curve
		this.rightMinEnd = 0.6; // Final min value for right curve
		this.targetX = 400; // Default target X position (center)
		this.targetWidth = 60; // Default target width
	}

	async init(): Promise<void> {
		this.vertexBuffer = createFullscreenQuadBuffer(this.device);
		this.dockBuffer = createDockBuffer(this.device);
		this.indexBuffer = createIndexBuffer(this.device);

		// Create icon buffers
		const iconPositions = [
			{ x: 300, y: 570 },
			{ x: 350, y: 570 },
			{ x: 400, y: 570 },
			{ x: 450, y: 570 },
			{ x: 500, y: 570 },
			{ x: 550, y: 570 },
		];

		for (const pos of iconPositions) {
			this.iconBuffers.push(createIconBuffer(this.device, pos.x, pos.y, 40));
		}

		this.sampler = this.device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
		});

		// Create a texture representing the window content
		// We'll make it the size of the initial window area we want to animate
		const windowTextureWidth = this.canvas.width;
		const windowTextureHeight = this.canvas.height;
		this.texture = await createWindowTexture(
			this.device,
			windowTextureWidth,
			windowTextureHeight
		);

		const shaderModule = this.device.createShaderModule({
			code: vertexShaderWGSL + fragmentShaderWGSL,
		});

		// Uniform buffer for animation state
		this.uniformBuffer = this.device.createBuffer({
			size: 7 * 4, // 7 floats: time, curve_duration, translation_duration, left_max_end, right_min_end, target_x, target_width
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		// Uniform buffer for canvas dimensions
		this.canvasDimsBuffer = this.device.createBuffer({
			size: 2 * 4, // 2 floats: width, height
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		// Initialize canvas dimensions buffer
		this.updateCanvasDimsBuffer();

		this.pipeline = this.device.createRenderPipeline({
			layout: "auto",
			vertex: {
				module: shaderModule,
				entryPoint: "main_vertex",
				buffers: [
					{
						arrayStride: 4 * 4, // 4 floats per vertex (x, y, u, v)
						attributes: [
							{
								shaderLocation: 0,
								offset: 0,
								format: "float32x2" as GPUVertexFormat,
							}, // Position
							{
								shaderLocation: 1,
								offset: 2 * 4,
								format: "float32x2" as GPUVertexFormat,
							}, // UV
						],
					},
				],
			},
			fragment: {
				module: shaderModule,
				entryPoint: "main_fragment",
				targets: [{ format: this.canvasFormat }],
			},
			primitive: {
				topology: "triangle-list",
			},
		});

		// Bind group layout must match the bindings in the shader
		this.bindGroup0 = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0), // Group 0 in shader
			entries: [
				{ binding: 0, resource: { buffer: this.uniformBuffer } }, // Uniforms
				{ binding: 1, resource: this.texture.createView() }, // Texture
				{ binding: 2, resource: this.sampler }, // Sampler
			],
		});
		this.bindGroup1 = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(1), // Group 1 in shader
			entries: [
				{ binding: 0, resource: { buffer: this.canvasDimsBuffer } }, // Canvas Dimensions
			],
		});

		this.setupUI();
		this.render(0); // Initial render with time=0
	}

	updateCanvasDimsBuffer(): void {
		if (!this.canvasDimsBuffer) return;
		const dimsData = new Float32Array([this.canvasWidth, this.canvasHeight]);
		this.device.queue.writeBuffer(this.canvasDimsBuffer, 0, dimsData);
	}

	setupUI(): void {
		const genieBtn = document.getElementById("genie-btn");
		const resetBtn = document.getElementById("reset-btn");
		
		if (genieBtn) {
			genieBtn.addEventListener("click", () => this.startAnimation());
		}
		if (resetBtn) {
			resetBtn.addEventListener("click", () => this.reset());
		}
	}

	startAnimation(): void {
		if (this.isAnimating) return;
		this.isAnimating = true;
		this.startTime = performance.now() / 1000.0; // Start time in seconds

		const animate = () => {
			const currentTime = performance.now() / 1000.0; // Current time in seconds
			const elapsedTime = currentTime - this.startTime;

			this.render(elapsedTime);

			if (elapsedTime < this.animationDuration) {
				this.animationId = requestAnimationFrame(animate);
			} else {
				this.finishAnimation();
			}
		};
		this.animationId = requestAnimationFrame(animate);
	}

	finishAnimation(): void {
		this.isAnimating = false;
		if (this.animationId !== null) {
			cancelAnimationFrame(this.animationId);
		}
		// Final render at the end of animation
		this.render(this.animationDuration);
	}

	reset(): void {
		if (this.isAnimating) {
			if (this.animationId !== null) {
				cancelAnimationFrame(this.animationId);
			}
			this.isAnimating = false;
		}
		this.render(0); // Render initial state
	}

	render(timeInSeconds: number): void {
		if (!this.uniformBuffer || !this.pipeline || !this.indexBuffer) return;
		
		// Update uniform buffer with current time and parameters
		const uniformData = new Float32Array([
			timeInSeconds, // time
			this.curveDuration, // curve_duration
			this.translationDuration, // translation_duration
			this.leftMaxEnd, // left_max_end
			this.rightMinEnd, // right_min_end
			this.targetX, // target_x
			this.targetWidth, // target_width
		]);
		this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

		const commandEncoder = this.device.createCommandEncoder();
		const textureView = this.context.getCurrentTexture().createView();

		const renderPassDescriptor = {
			colorAttachments: [
				{
					view: textureView,
					clearValue: { r: 0.1, g: 0.12, b: 0.18, a: 1.0 }, // Dark blue background
					loadOp: "clear",
					storeOp: "store",
				},
			],
		};

		const passEncoder = commandEncoder.beginRenderPass(
			renderPassDescriptor as GPURenderPassDescriptor
		);

		// Draw animated window
		if (this.pipeline && this.indexBuffer) {
			passEncoder.setPipeline(this.pipeline);
			passEncoder.setBindGroup(0, this.bindGroup0);
			passEncoder.setBindGroup(1, this.bindGroup1);
			passEncoder.setVertexBuffer(0, this.vertexBuffer);
			passEncoder.setIndexBuffer(this.indexBuffer, "uint16");
			passEncoder.drawIndexed(6);
		}

		passEncoder.end();
		this.device.queue.submit([commandEncoder.finish()]);
	}
}

// --- Main Execution ---
async function run(): Promise<void> {
	const gpu = await initWebGPU();
	if (!gpu) return;

	const app = new WebGPUApp(
		gpu.device,
		gpu.context,
		gpu.canvasFormat,
		gpu.canvas
	);
	await app.init();
}

run();
