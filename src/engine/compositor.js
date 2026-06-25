/**
 * compositor.js — WebGL2 rendering compositor
 *
 * Renders video frames (VideoFrame, HTMLVideoElement, HTMLCanvasElement, ImageBitmap)
 * onto a canvas using a WebGL2 pipeline with per-clip transforms and color correction.
 *
 * Usage:
 *   const comp = new Compositor(canvasEl);
 *   comp.clear();
 *   comp.drawClip(videoEl, clip.properties, videoNaturalW, videoNaturalH);
 *
 * Blending: porter-duff "over" (each clip over the current accumulation buffer).
 * All clips drawn in z-index order (lowest first = furthest back).
 */

// ─── Shader sources ───────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform mat3 u_xform;
void main() {
  vec3 p = u_xform * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  // UV: top-left = (0,0), bottom-right = (1,1)
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_exposure;    // EV shift: 0 = no change
uniform float u_contrast;    // -1..1: 0 = no change
uniform float u_saturation;  // -1..1: 0 = no change
uniform float u_temperature; // -1..1: 0 = no change (blue ↔ yellow)
uniform float u_tint;        // -1..1: 0 = no change (green ↔ magenta)
out vec4 fragColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec4 s = texture(u_tex, v_uv);
  vec3 c = s.rgb;
  // Exposure
  c *= pow(2.0, u_exposure);
  // Contrast (pivot around 0.5)
  if (u_contrast != 0.0) c = clamp(0.5 + (c - 0.5) * (1.0 + u_contrast * 2.0), 0.0, 1.0);
  // Saturation
  if (u_saturation != 0.0) {
    float lum = dot(c, LUMA);
    c = mix(vec3(lum), c, 1.0 + u_saturation);
  }
  // Temperature (R/B shift)
  c.r = clamp(c.r + u_temperature * 0.15, 0.0, 1.0);
  c.b = clamp(c.b - u_temperature * 0.15, 0.0, 1.0);
  // Tint (G shift)
  c.g = clamp(c.g - u_tint * 0.08, 0.0, 1.0);
  c = clamp(c, 0.0, 1.0);
  fragColor = vec4(c, s.a * u_opacity);
}`;

// ─── Compositor ───────────────────────────────────────────────────────────────

export class Compositor {
  /**
   * @param {HTMLCanvasElement} canvas — the preview canvas to render onto
   */
  constructor(canvas) {
    this._canvas = canvas;
    this._gl = null;
    this._program = null;
    this._quadBuf = null;
    this._texture = null;
    this._uniforms = {};
    this._canvasW = 0;
    this._canvasH = 0;
    this._ready = false;
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  /**
   * Initialize the WebGL2 context and compile shaders.
   * Must be called before any draw calls. Throws if WebGL2 unavailable.
   */
  init() {
    const gl = this._canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 not available on this canvas');
    this._gl = gl;

    // Compile program
    this._program = compileProgram(gl, VERT, FRAG);

    // Fullscreen quad (triangle strip: TL, TR, BL, BR)
    const verts = new Float32Array([-1, 1, 1, 1, -1, -1, 1, -1]);
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // Create a single reusable texture
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Cache uniform locations
    const p = this._program;
    this._uniforms = {
      xform:       gl.getUniformLocation(p, 'u_xform'),
      tex:         gl.getUniformLocation(p, 'u_tex'),
      opacity:     gl.getUniformLocation(p, 'u_opacity'),
      exposure:    gl.getUniformLocation(p, 'u_exposure'),
      contrast:    gl.getUniformLocation(p, 'u_contrast'),
      saturation:  gl.getUniformLocation(p, 'u_saturation'),
      temperature: gl.getUniformLocation(p, 'u_temperature'),
      tint:        gl.getUniformLocation(p, 'u_tint'),
    };

    // Enable alpha blending (porter-duff over)
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this._program);

    // Bind VAO
    const aPos = gl.getAttribLocation(this._program, 'a_pos');
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(vao);
    this._vao = vao;

    this._ready = true;
  }

  // ─── Per-frame API ────────────────────────────────────────────────────────────

  /**
   * Resize viewport to match canvas, then clear to black.
   * Call once per frame before drawing clips.
   */
  clear(r = 0, g = 0, b = 0) {
    if (!this._ready) return;
    const gl = this._gl;
    if (this._canvas.width !== this._canvasW || this._canvas.height !== this._canvasH) {
      this._canvasW = this._canvas.width;
      this._canvasH = this._canvas.height;
      gl.viewport(0, 0, this._canvasW, this._canvasH);
    }
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Draw one video source onto the canvas with clip properties applied.
   *
   * @param {HTMLVideoElement|VideoFrame|HTMLCanvasElement|ImageBitmap} source
   * @param {object} props — clip.properties from EDL
   * @param {number} naturalW — natural pixel width of source media
   * @param {number} naturalH — natural pixel height of source media
   */
  drawClip(source, props, naturalW, naturalH) {
    if (!this._ready || !source) return;
    const gl = this._gl;
    const { u } = this;

    // Upload frame to texture
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {
      // Source may not be ready (video not seeked) — skip this frame
      return;
    }

    // Bind texture unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._uniforms.tex, 0);

    // Set color/compositing uniforms
    const col = props?.color ?? {};
    gl.uniform1f(this._uniforms.opacity,     props?.opacity     ?? 1);
    gl.uniform1f(this._uniforms.exposure,    col.exposure       ?? 0);
    gl.uniform1f(this._uniforms.contrast,    col.contrast       ?? 0);
    gl.uniform1f(this._uniforms.saturation,  col.saturation     ?? 0);
    gl.uniform1f(this._uniforms.temperature, col.temperature    ?? 0);
    gl.uniform1f(this._uniforms.tint,        col.tint           ?? 0);

    // Build + set transform matrix
    const xform = buildTransform(props?.transform, naturalW, naturalH, this._canvasW, this._canvasH);
    gl.uniformMatrix3fv(this._uniforms.xform, false, xform);

    // Draw
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Draw a solid color rectangle (useful for color matte clips or test pattern).
   * @param {number[]} rgba — [r, g, b, a] 0-1 range
   */
  drawSolid(rgba = [0, 0, 0, 1]) {
    // Create a 1×1 pixel texture of the given color
    if (!this._ready) return;
    const gl = this._gl;
    const px = new Uint8Array([
      Math.round(rgba[0] * 255),
      Math.round(rgba[1] * 255),
      Math.round(rgba[2] * 255),
      Math.round(rgba[3] * 255),
    ]);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._uniforms.tex, 0);
    gl.uniform1f(this._uniforms.opacity, 1);
    gl.uniform1f(this._uniforms.exposure, 0);
    gl.uniform1f(this._uniforms.contrast, 0);
    gl.uniform1f(this._uniforms.saturation, 0);
    gl.uniform1f(this._uniforms.temperature, 0);
    gl.uniform1f(this._uniforms.tint, 0);
    // Full-canvas identity transform
    gl.uniformMatrix3fv(this._uniforms.xform, false, new Float32Array([1,0,0, 0,1,0, 0,0,1]));
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  get isReady() { return this._ready; }

  dispose() {
    if (!this._gl) return;
    const gl = this._gl;
    gl.deleteTexture(this._texture);
    gl.deleteBuffer(this._quadBuf);
    gl.deleteProgram(this._program);
    this._ready = false;
  }
}

// ─── Transform builder ────────────────────────────────────────────────────────

/**
 * Build a column-major 3×3 transform matrix for the vertex shader.
 *
 * The clip properties use pixel units relative to canvas center.
 * We map to NDC [-1, 1] space applying scale → rotate → translate.
 * The media is fit (contain) into the canvas by default (scale 1 = fit).
 */
function buildTransform(transform, srcW, srcH, canvasW, canvasH) {
  if (!canvasW || !canvasH) return new Float32Array([1,0,0, 0,1,0, 0,0,1]);

  const t = transform ?? {};
  const tx = t.x ?? 0;
  const ty = t.y ?? 0;
  const sx = t.scaleX ?? 1;
  const sy = t.scaleY ?? 1;
  const rotDeg = t.rotation ?? 0;

  // "Contain" scale: fit the clip's natural size into the canvas
  const srcAspect = (srcW && srcH) ? srcW / srcH : 16 / 9;
  const canvasAspect = canvasW / canvasH;
  let fitW, fitH;
  if (srcAspect > canvasAspect) {
    fitW = canvasW;
    fitH = canvasW / srcAspect;
  } else {
    fitH = canvasH;
    fitW = canvasH * srcAspect;
  }

  // NDC scale (clip occupies fitW/canvasW × fitH/canvasH of the NDC space)
  const ndcSX = (fitW / canvasW) * sx;
  const ndcSY = (fitH / canvasH) * sy;

  // NDC translation (pixel offset → NDC offset, Y axis flipped)
  const ndcTX = (tx / canvasW) * 2;
  const ndcTY = -(ty / canvasH) * 2;

  const cos = Math.cos(rotDeg * Math.PI / 180);
  const sin = Math.sin(rotDeg * Math.PI / 180);

  // Column-major mat3: columns are [col0, col1, col2]
  // col0 = [sx*cos, sx*sin, 0]
  // col1 = [-sy*sin, sy*cos, 0]
  // col2 = [tx, ty, 1]
  return new Float32Array([
    ndcSX * cos,   ndcSX * sin,  0,   // column 0
    -ndcSY * sin,  ndcSY * cos,  0,   // column 1
    ndcTX,         ndcTY,        1,   // column 2
  ]);
}

// ─── GL helpers ───────────────────────────────────────────────────────────────

function compileShader(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

function compileProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return prog;
}
