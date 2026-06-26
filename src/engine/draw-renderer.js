/**
 * draw-renderer.js — Hand-drawn animation frame renderer (Phase 3.18)
 *
 * Renders an array of strokes (from clip.properties.drawing.frames[idx].strokes)
 * to a Canvas 2D context. Strokes store normalized (0-1) coordinates so they
 * scale cleanly to any canvas resolution.
 *
 * Used by:
 *   - PreviewEngine / ExportEngine  — renderFrame() → canvas → WebGL texture
 *   - DesktopShell draw overlay      — paintStrokes() directly onto overlay ctx
 */

export class DrawRenderer {
  constructor() {
    this._canvas = null;
    this._ctx    = null;
  }

  /**
   * Render strokes onto the shared reusable canvas and return it.
   * Caller must use the canvas immediately — it is overwritten on the next call.
   *
   * @param {StrokeData[]} strokes
   * @param {number} w  canvas pixel width
   * @param {number} h  canvas pixel height
   * @returns {HTMLCanvasElement}
   */
  renderFrame(strokes, w, h) {
    if (!this._canvas || this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas = document.createElement('canvas');
      this._canvas.width  = w;
      this._canvas.height = h;
      this._ctx = this._canvas.getContext('2d');
    }
    this._ctx.clearRect(0, 0, w, h);
    if (strokes?.length) {
      for (const s of strokes) _paintStroke(this._ctx, s, w, h);
    }
    return this._canvas;
  }

  /**
   * Paint strokes directly onto an existing 2D context.
   * Respects canvas composite operations (destination-out for eraser).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {StrokeData[]} strokes
   * @param {number} w  logical width for coordinate de-normalization
   * @param {number} h  logical height
   * @param {number} alpha  global alpha multiplier (0-1)
   */
  paintStrokes(ctx, strokes, w, h, alpha = 1) {
    if (!strokes?.length) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
    for (const s of strokes) _paintStroke(ctx, s, w, h);
    ctx.restore();
  }

  dispose() {
    this._canvas = null;
    this._ctx    = null;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * @typedef {{ color:string, width:number, opacity:number, tool:'pen'|'eraser', points:{x:number,y:number}[] }} StrokeData
 * Coordinates in points are normalized: 0 = left/top, 1 = right/bottom.
 */

function _paintStroke(ctx, stroke, w, h) {
  const pts = stroke.points;
  if (!pts?.length) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.globalAlpha *= (stroke.opacity ?? 1);
  ctx.strokeStyle  = stroke.color ?? '#ff6644';
  ctx.lineWidth    = stroke.width ?? 6;
  ctx.lineCap      = 'round';
  ctx.lineJoin     = 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    // Dot
    ctx.arc(pts[0].x * w, pts[0].y * h, (stroke.width ?? 6) / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  } else {
    ctx.moveTo(pts[0].x * w, pts[0].y * h);
    for (let i = 1; i < pts.length; i++) {
      if (i < pts.length - 1) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x * w, pts[i].y * h, mx * w, my * h);
      } else {
        ctx.lineTo(pts[i].x * w, pts[i].y * h);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
