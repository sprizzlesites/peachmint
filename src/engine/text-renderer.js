/**
 * text-renderer.js — Canvas 2D text rendering for text clips
 *
 * TextRenderer draws text properties onto an HTMLCanvasElement that can be
 * passed directly to Compositor.drawClip() as a WebGL texture source.
 * The canvas is sized to the project canvas dimensions so the transform
 * system (scale/rotation/position) operates identically to media clips.
 */

export class TextRenderer {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._ctx    = this._canvas.getContext('2d');
  }

  /**
   * Render text onto a canvas sized to (canvasW × canvasH).
   * Returns the canvas element — usable as a texImage2D source.
   *
   * @param {object} textProps — clip.properties.text
   * @param {number} canvasW
   * @param {number} canvasH
   * @returns {HTMLCanvasElement}
   */
  render(textProps, canvasW, canvasH) {
    if (this._canvas.width  !== canvasW) this._canvas.width  = canvasW;
    if (this._canvas.height !== canvasH) this._canvas.height = canvasH;

    const ctx = this._ctx;
    const {
      content    = '',
      fontFamily = 'sans-serif',
      fontSize   = 72,
      color      = '#ffffff',
      align      = 'center',
      bold       = false,
      italic     = false,
      lineHeight = 1.3,
    } = textProps ?? {};

    ctx.clearRect(0, 0, canvasW, canvasH);

    if (!content) return this._canvas;

    ctx.font         = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px "${fontFamily}", sans-serif`;
    ctx.fillStyle    = color;
    ctx.textAlign    = align;
    ctx.textBaseline = 'middle';

    const lines  = String(content).split('\n');
    const lineH  = fontSize * lineHeight;
    const startY = (canvasH - lines.length * lineH) / 2 + lineH / 2;
    const x      = align === 'center' ? canvasW / 2
                 : align === 'right'  ? canvasW - fontSize * 0.5
                 : fontSize * 0.5;

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, startY + i * lineH);
    }

    return this._canvas;
  }

  dispose() {}
}
