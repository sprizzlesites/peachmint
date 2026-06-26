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
precision highp sampler3D;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform int       u_lut_enabled;
uniform float u_opacity;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_tint;
// Chroma key
uniform int   u_chroma_enabled;
uniform vec3  u_chroma_color;
uniform float u_chroma_threshold;
uniform float u_chroma_smooth;
// Shape mask
uniform int   u_mask_type;    // 0=none 1=rect 2=ellipse
uniform vec2  u_mask_center;
uniform vec2  u_mask_size;
uniform float u_mask_feather;
uniform int   u_mask_invert;
// VFX
uniform float u_vfx_vignette;
uniform float u_vfx_grain;
uniform float u_vfx_sharpen;
uniform float u_vfx_aberration;
uniform float u_vfx_pixelate;
uniform float u_vfx_time;
// AI segmentation mask
uniform sampler2D u_seg_mask;
uniform int       u_seg_enabled;
uniform float     u_seg_feather;
uniform int       u_seg_invert;
out vec4 fragColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  // VFX: Pixelate — quantise UV before sampling
  vec2 uv = v_uv;
  if (u_vfx_pixelate > 0.001) {
    uv = clamp((floor(v_uv / u_vfx_pixelate) + 0.5) * u_vfx_pixelate, 0.0, 1.0);
  }

  vec4 s = texture(u_tex, uv);
  vec3 c = s.rgb;

  // VFX: Chromatic aberration — resample R/B at offset UVs
  if (u_vfx_aberration > 0.001) {
    vec2 dir = (uv - 0.5) * u_vfx_aberration;
    s.r = texture(u_tex, clamp(uv + dir, 0.0, 1.0)).r;
    s.b = texture(u_tex, clamp(uv - dir, 0.0, 1.0)).b;
    c = s.rgb;
  }

  // VFX: Sharpen (unsharp mask, 3×3 box blur)
  if (u_vfx_sharpen > 0.001) {
    vec2 ts = 1.0 / vec2(textureSize(u_tex, 0));
    vec3 blur = (
      texture(u_tex, uv + vec2(-ts.x, -ts.y)).rgb +
      texture(u_tex, uv + vec2( 0.0,  -ts.y)).rgb +
      texture(u_tex, uv + vec2( ts.x, -ts.y)).rgb +
      texture(u_tex, uv + vec2(-ts.x,  0.0)).rgb +
      texture(u_tex, uv + vec2( ts.x,  0.0)).rgb +
      texture(u_tex, uv + vec2(-ts.x,  ts.y)).rgb +
      texture(u_tex, uv + vec2( 0.0,   ts.y)).rgb +
      texture(u_tex, uv + vec2( ts.x,  ts.y)).rgb
    ) * 0.125;
    c = clamp(c + (c - blur) * u_vfx_sharpen, 0.0, 1.0);
  }

  // Chroma key (on raw footage, before color correction)
  if (u_chroma_enabled != 0) {
    vec3 diff = c - u_chroma_color;
    float ld = dot(diff, LUMA);
    float chroma_dist = length(diff - ld * LUMA);
    float sm = max(u_chroma_smooth, 0.001);
    s.a *= smoothstep(u_chroma_threshold - sm, u_chroma_threshold + sm, chroma_dist);
  }

  // AI segmentation mask (person/foreground confidence)
  if (u_seg_enabled != 0) {
    float seg = texture(u_seg_mask, v_uv).r;
    float sf  = max(u_seg_feather, 0.001);
    seg = smoothstep(0.5 - sf, 0.5 + sf, seg);
    if (u_seg_invert != 0) seg = 1.0 - seg;
    s.a *= seg;
  }

  // Color correction
  c *= pow(2.0, u_exposure);
  if (u_contrast != 0.0) c = clamp(0.5 + (c - 0.5) * (1.0 + u_contrast * 2.0), 0.0, 1.0);
  if (u_saturation != 0.0) {
    float lum = dot(c, LUMA);
    c = mix(vec3(lum), c, 1.0 + u_saturation);
  }
  c.r = clamp(c.r + u_temperature * 0.15, 0.0, 1.0);
  c.b = clamp(c.b - u_temperature * 0.15, 0.0, 1.0);
  c.g = clamp(c.g - u_tint * 0.08, 0.0, 1.0);
  c = clamp(c, 0.0, 1.0);

  // 3D LUT
  if (u_lut_enabled != 0) c = texture(u_lut, c).rgb;

  // VFX: Vignette — darken corners
  if (u_vfx_vignette > 0.001) {
    float vd = length(v_uv - 0.5) * 1.4142;
    c *= max(0.0, 1.0 - u_vfx_vignette * vd * vd);
  }

  // VFX: Film grain — time-animated pseudo-random noise
  if (u_vfx_grain > 0.001) {
    float n = fract(sin(dot(v_uv + fract(u_vfx_time * 2.7182818), vec2(12.9898, 78.233))) * 43758.5453);
    c = clamp(c + (n - 0.5) * u_vfx_grain * 0.3, 0.0, 1.0);
  }

  vec4 out_color = vec4(c, s.a * u_opacity);

  // Shape mask (uses v_uv for screen-space accuracy, independent of pixelate)
  if (u_mask_type != 0) {
    float feather = max(u_mask_feather, 0.001);
    vec2 uv_c = v_uv - u_mask_center;
    float dist;
    if (u_mask_type == 1) {
      vec2 d = abs(uv_c) - u_mask_size * 0.5;
      dist = max(d.x, d.y);
    } else {
      vec2 sc = uv_c / max(u_mask_size * 0.5, vec2(0.001));
      dist = length(sc) - 1.0;
    }
    float shape = 1.0 - smoothstep(-feather, feather, dist);
    if (u_mask_invert != 0) shape = 1.0 - shape;
    out_color.a *= shape;
  }

  fragColor = out_color;
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
    this._dummyLUT = null;
    this._activeLUT = null;
    this._segTex    = null;
    this._dummySeg  = null;
    this._segEnabled = false;
    this._adjTex    = null;
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
  init({ transparent = false } = {}) {
    const gl = this._canvas.getContext('webgl2', {
      alpha: transparent,
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
      xform:          gl.getUniformLocation(p, 'u_xform'),
      tex:            gl.getUniformLocation(p, 'u_tex'),
      lut:            gl.getUniformLocation(p, 'u_lut'),
      lutEnabled:     gl.getUniformLocation(p, 'u_lut_enabled'),
      opacity:        gl.getUniformLocation(p, 'u_opacity'),
      exposure:       gl.getUniformLocation(p, 'u_exposure'),
      contrast:       gl.getUniformLocation(p, 'u_contrast'),
      saturation:     gl.getUniformLocation(p, 'u_saturation'),
      temperature:    gl.getUniformLocation(p, 'u_temperature'),
      tint:           gl.getUniformLocation(p, 'u_tint'),
      chromaEnabled:  gl.getUniformLocation(p, 'u_chroma_enabled'),
      chromaColor:    gl.getUniformLocation(p, 'u_chroma_color'),
      chromaThresh:   gl.getUniformLocation(p, 'u_chroma_threshold'),
      chromaSmooth:   gl.getUniformLocation(p, 'u_chroma_smooth'),
      maskType:       gl.getUniformLocation(p, 'u_mask_type'),
      maskCenter:     gl.getUniformLocation(p, 'u_mask_center'),
      maskSize:       gl.getUniformLocation(p, 'u_mask_size'),
      maskFeather:    gl.getUniformLocation(p, 'u_mask_feather'),
      maskInvert:     gl.getUniformLocation(p, 'u_mask_invert'),
      vfxVignette:    gl.getUniformLocation(p, 'u_vfx_vignette'),
      vfxGrain:       gl.getUniformLocation(p, 'u_vfx_grain'),
      vfxSharpen:     gl.getUniformLocation(p, 'u_vfx_sharpen'),
      vfxAberration:  gl.getUniformLocation(p, 'u_vfx_aberration'),
      vfxPixelate:    gl.getUniformLocation(p, 'u_vfx_pixelate'),
      vfxTime:        gl.getUniformLocation(p, 'u_vfx_time'),
      segMask:        gl.getUniformLocation(p, 'u_seg_mask'),
      segEnabled:     gl.getUniformLocation(p, 'u_seg_enabled'),
      segFeather:     gl.getUniformLocation(p, 'u_seg_feather'),
      segInvert:      gl.getUniformLocation(p, 'u_seg_invert'),
    };

    // Set initial disabled state for chroma/mask (uniforms default to 0 in GL but be explicit)
    gl.uniform1i(this._uniforms.chromaEnabled, 0);
    gl.uniform1i(this._uniforms.maskType, 0);

    // Dummy 1×1×1 LUT bound to unit 1 so the sampler3D is always valid
    this._dummyLUT = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this._dummyLUT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.uniform1i(this._uniforms.lut, 1);
    gl.uniform1i(this._uniforms.lutEnabled, 0);

    // Dummy 1×1 segmentation mask on TEXTURE2 (fully opaque — seg pass disabled by default)
    this._dummySeg = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._dummySeg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    gl.uniform1i(this._uniforms.segMask, 2);
    gl.uniform1i(this._uniforms.segEnabled, 0);

    this._transparent = transparent;

    // Enable alpha blending (porter-duff over)
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (transparent) {
      // Correct alpha compositing when canvas has alpha channel
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

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
  clear(r = 0, g = 0, b = 0, a = 1) {
    if (!this._ready) return;
    const gl = this._gl;
    if (this._canvas.width !== this._canvasW || this._canvas.height !== this._canvasH) {
      this._canvasW = this._canvas.width;
      this._canvasH = this._canvas.height;
      gl.viewport(0, 0, this._canvasW, this._canvasH);
    }
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Read back pixels from the WebGL framebuffer (for GIF/PNG export).
   * Returns a Uint8ClampedArray in RGBA order, top-to-bottom.
   */
  getPixels() {
    if (!this._ready) return null;
    const gl = this._gl;
    const w = this._canvasW;
    const h = this._canvasH;
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // WebGL reads bottom-to-top; flip to top-to-bottom
    const rowSize = w * 4;
    const flipped = new Uint8ClampedArray(raw.length);
    for (let y = 0; y < h; y++) {
      const srcRow = h - 1 - y;
      flipped.set(raw.subarray(srcRow * rowSize, (srcRow + 1) * rowSize), y * rowSize);
    }
    return flipped;
  }

  /**
   * Draw one video source onto the canvas with clip properties applied.
   *
   * @param {HTMLVideoElement|VideoFrame|HTMLCanvasElement|ImageBitmap} source
   * @param {object} props — clip.properties from EDL
   * @param {number} naturalW — natural pixel width of source media
   * @param {number} naturalH — natural pixel height of source media
   */
  drawClip(source, props, naturalW, naturalH, opacityMult = 1) {
    if (!this._ready || !source) return;
    const gl = this._gl;
    const { u } = this;

    // Upload frame to texture unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {
      // Source may not be ready (video not seeked) — skip this frame
      return;
    }
    gl.uniform1i(this._uniforms.tex, 0);

    // Bind LUT to texture unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this._activeLUT ?? this._dummyLUT);
    gl.uniform1i(this._uniforms.lut, 1);
    gl.uniform1i(this._uniforms.lutEnabled, this._activeLUT ? 1 : 0);

    // Bind segmentation mask to texture unit 2
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._segEnabled && this._segTex ? this._segTex : this._dummySeg);
    gl.uniform1i(this._uniforms.segMask, 2);
    const seg = props?.seg ?? {};
    gl.uniform1i(this._uniforms.segEnabled, this._segEnabled ? 1 : 0);
    gl.uniform1f(this._uniforms.segFeather, seg.feather ?? 0.02);
    gl.uniform1i(this._uniforms.segInvert,  seg.invert  ? 1  : 0);

    // Color / compositing uniforms
    const col    = props?.color  ?? {};
    const chroma = props?.chroma ?? {};
    const mask   = props?.mask   ?? {};
    gl.uniform1f(this._uniforms.opacity,     (props?.opacity ?? 1) * opacityMult);
    gl.uniform1f(this._uniforms.exposure,    col.exposure       ?? 0);
    gl.uniform1f(this._uniforms.contrast,    col.contrast       ?? 0);
    gl.uniform1f(this._uniforms.saturation,  col.saturation     ?? 0);
    gl.uniform1f(this._uniforms.temperature, col.temperature    ?? 0);
    gl.uniform1f(this._uniforms.tint,        col.tint           ?? 0);

    // Chroma key uniforms
    gl.uniform1i(this._uniforms.chromaEnabled, chroma.enabled ? 1 : 0);
    gl.uniform3fv(this._uniforms.chromaColor,  chroma.color ?? [0, 1, 0]);
    gl.uniform1f(this._uniforms.chromaThresh,  chroma.threshold ?? 0.35);
    gl.uniform1f(this._uniforms.chromaSmooth,  chroma.smooth    ?? 0.1);

    // Shape mask uniforms
    const maskTypeInt = mask.type === 'rect' ? 1 : mask.type === 'ellipse' ? 2 : 0;
    gl.uniform1i(this._uniforms.maskType,    maskTypeInt);
    gl.uniform2fv(this._uniforms.maskCenter, [mask.x ?? 0.5, mask.y ?? 0.5]);
    gl.uniform2fv(this._uniforms.maskSize,   [mask.w ?? 0.5, mask.h ?? 0.5]);
    gl.uniform1f(this._uniforms.maskFeather, mask.feather ?? 0.05);
    gl.uniform1i(this._uniforms.maskInvert,  mask.invert  ? 1  : 0);

    // VFX uniforms
    const vfx = props?.vfx ?? {};
    gl.uniform1f(this._uniforms.vfxVignette,   vfx.vignette   ?? 0);
    gl.uniform1f(this._uniforms.vfxGrain,      vfx.grain      ?? 0);
    gl.uniform1f(this._uniforms.vfxSharpen,    vfx.sharpen    ?? 0);
    gl.uniform1f(this._uniforms.vfxAberration, vfx.aberration ?? 0);
    gl.uniform1f(this._uniforms.vfxPixelate,   vfx.pixelate   ?? 0);

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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.uniform1i(this._uniforms.tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this._dummyLUT);
    gl.uniform1i(this._uniforms.lut, 1);
    gl.uniform1i(this._uniforms.lutEnabled,    0);
    gl.uniform1i(this._uniforms.chromaEnabled, 0);
    gl.uniform1i(this._uniforms.maskType,      0);
    gl.uniform1i(this._uniforms.segEnabled,    0);
    gl.uniform1f(this._uniforms.vfxVignette,   0);
    gl.uniform1f(this._uniforms.vfxGrain,      0);
    gl.uniform1f(this._uniforms.vfxSharpen,    0);
    gl.uniform1f(this._uniforms.vfxAberration, 0);
    gl.uniform1f(this._uniforms.vfxPixelate,   0);
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

  // ─── Segmentation mask API ───────────────────────────────────────────────────

  /**
   * Upload a Float32Array person-confidence mask (0=background, 1=person) to
   * texture unit 2 and enable the seg pass for the next drawClip() call.
   * Must be called once per clip per frame; call clearSegmentationMask() after.
   *
   * @param {Float32Array} maskFloat — width × height values in [0, 1]
   * @param {number} w
   * @param {number} h
   */
  setSegmentationMask(maskFloat, w, h) {
    if (!this._ready) return;
    const gl = this._gl;
    const pixels = new Uint8Array(maskFloat.length);
    for (let i = 0; i < maskFloat.length; i++) {
      pixels[i] = Math.round(Math.min(1, Math.max(0, maskFloat[i])) * 255);
    }
    gl.activeTexture(gl.TEXTURE2);
    if (!this._segTex) {
      this._segTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._segTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._segTex);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
    this._segEnabled = true;
  }

  /** Disable the segmentation pass for subsequent drawClip() calls. */
  clearSegmentationMask() {
    this._segEnabled = false;
  }

  // ─── Adjustment layer API ─────────────────────────────────────────────────────

  /**
   * Capture the current framebuffer and re-render it through the full color/VFX
   * pipeline using props. This implements adjustment layers: everything previously
   * drawn is re-processed with the adjustment clip's color correction and VFX.
   *
   * Uses gl.copyTexImage2D to snapshot the framebuffer into a private texture, then
   * draws that texture back with ONE/ZERO blend (replace mode) so the result exactly
   * replaces the framebuffer rather than compositing on top.
   *
   * @param {object} props — resolved clip.properties (color, vfx, opacity)
   * @param {number} w     — canvas width
   * @param {number} h     — canvas height
   */
  applyAdjustment(props, w, h) {
    if (!this._ready) return;
    const gl = this._gl;

    // Create/reuse the adjustment capture texture
    gl.activeTexture(gl.TEXTURE0);
    if (!this._adjTex) {
      this._adjTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._adjTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._adjTex);
    }

    // Snapshot framebuffer → _adjTex (completes before next draw call)
    gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, w, h, 0);
    gl.uniform1i(this._uniforms.tex, 0);

    // LUT (honour active LUT if set by caller via setActiveLUT)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this._activeLUT ?? this._dummyLUT);
    gl.uniform1i(this._uniforms.lut, 1);
    gl.uniform1i(this._uniforms.lutEnabled, this._activeLUT ? 1 : 0);

    // No segmentation for adjustment layers
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._dummySeg);
    gl.uniform1i(this._uniforms.segMask, 2);
    gl.uniform1i(this._uniforms.segEnabled, 0);

    // Color correction uniforms
    const col = props?.color ?? {};
    const vfx = props?.vfx  ?? {};
    gl.uniform1f(this._uniforms.opacity,     props?.opacity ?? 1);
    gl.uniform1f(this._uniforms.exposure,    col.exposure    ?? 0);
    gl.uniform1f(this._uniforms.contrast,    col.contrast    ?? 0);
    gl.uniform1f(this._uniforms.saturation,  col.saturation  ?? 0);
    gl.uniform1f(this._uniforms.temperature, col.temperature ?? 0);
    gl.uniform1f(this._uniforms.tint,        col.tint        ?? 0);

    // No chroma key or shape mask on adjustment layers
    gl.uniform1i(this._uniforms.chromaEnabled, 0);
    gl.uniform1i(this._uniforms.maskType, 0);

    // VFX uniforms
    gl.uniform1f(this._uniforms.vfxVignette,   vfx.vignette   ?? 0);
    gl.uniform1f(this._uniforms.vfxGrain,      vfx.grain      ?? 0);
    gl.uniform1f(this._uniforms.vfxSharpen,    vfx.sharpen    ?? 0);
    gl.uniform1f(this._uniforms.vfxAberration, vfx.aberration ?? 0);
    gl.uniform1f(this._uniforms.vfxPixelate,   vfx.pixelate   ?? 0);

    // Identity transform — covers the full canvas exactly
    gl.uniformMatrix3fv(this._uniforms.xform, false, new Float32Array([1,0,0, 0,1,0, 0,0,1]));

    // Replace blend: write adjusted pixels back without compositing on top of themselves
    gl.blendFunc(gl.ONE, gl.ZERO);

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Restore standard porter-duff over blend
    if (this._transparent) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  // ─── LUT API ──────────────────────────────────────────────────────────────────

  /**
   * Upload a parsed LUT to a new WebGL TEXTURE_3D and return the texture handle.
   * Caller owns the texture; dispose with disposeLUT() when done.
   *
   * @param {Float32Array} floatData — N³×3 floats in 0..1 range (R-fastest order)
   * @param {number}       size      — cube dimension N
   * @returns {WebGLTexture}
   */
  uploadLUT(floatData, size) {
    if (!this._ready) throw new Error('Compositor not initialised');
    const gl = this._gl;
    const n3 = size * size * size;
    const rgba = new Uint8Array(n3 * 4);
    for (let i = 0; i < n3; i++) {
      rgba[i * 4]     = Math.round(Math.min(1, Math.max(0, floatData[i * 3]))     * 255);
      rgba[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, floatData[i * 3 + 1])) * 255);
      rgba[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, floatData[i * 3 + 2])) * 255);
      rgba[i * 4 + 3] = 255;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    return tex;
  }

  /** Set the active LUT texture for subsequent drawClip() calls. Pass null to disable. */
  setActiveLUT(tex) {
    this._activeLUT = tex ?? null;
  }

  /** Delete a LUT texture created by uploadLUT(). Clears activeLUT if it matches. */
  disposeLUT(tex) {
    if (!tex || !this._gl) return;
    if (this._activeLUT === tex) this._activeLUT = null;
    this._gl.deleteTexture(tex);
  }

  /** Update the animation time used by grain and other time-varying VFX. */
  setTime(t) {
    if (!this._ready) return;
    this._gl.uniform1f(this._uniforms.vfxTime, t);
  }

  get isReady() { return this._ready; }

  dispose() {
    if (!this._gl) return;
    const gl = this._gl;
    gl.deleteTexture(this._texture);
    if (this._dummyLUT) gl.deleteTexture(this._dummyLUT);
    if (this._segTex)   gl.deleteTexture(this._segTex);
    if (this._dummySeg) gl.deleteTexture(this._dummySeg);
    if (this._adjTex)   gl.deleteTexture(this._adjTex);
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
