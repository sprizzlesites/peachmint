/**
 * captions.js — SRT/VTT parser + on-canvas caption renderer
 *
 * API:
 *   parseSRT(text)          → { start, end, text }[]
 *   parseVTT(text)          → { start, end, text }[]
 *   findActiveCue(cues, t)  → { start, end, text } | null
 *   renderCaptionToCanvas(text, opts, frameW, frameH) → OffscreenCanvas|HTMLCanvasElement
 *
 * Cue times are in seconds.
 */

/**
 * Parse an SRT subtitle file into an array of cues.
 * @param {string} src
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseSRT(src) {
  const cues = [];
  const blocks = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    // Skip optional cue sequence number
    let timeLine = lines[0];
    let textStart = 1;
    if (/^\d+$/.test(timeLine.trim())) {
      timeLine  = lines[1] ?? '';
      textStart = 2;
    }
    const m = timeLine.match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/);
    if (!m) continue;
    const start = _parseSRTTime(m[1]);
    const end   = _parseSRTTime(m[2]);
    const text  = lines.slice(textStart).join('\n').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function _parseSRTTime(s) {
  const [hms, ms] = s.split(/[,\.]/);
  const [h, m, sec] = (hms ?? '').split(':').map(Number);
  return (h * 3600 + m * 60 + (sec || 0)) + (parseInt(ms ?? '0', 10) / 1000);
}

/**
 * Parse a WebVTT subtitle file into an array of cues.
 * @param {string} src
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseVTT(src) {
  const cues = [];
  const normalized = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.trimStart().startsWith('WEBVTT')) return cues;

  const blocks = normalized.trim().split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (!lines.length) continue;
    // Skip header, NOTE, STYLE, REGION blocks
    if (lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE') ||
        lines[0].startsWith('STYLE') || lines[0].startsWith('REGION')) continue;
    let timeLine = lines[0];
    let textStart = 1;
    if (!timeLine.includes('-->')) {
      timeLine  = lines[1] ?? '';
      textStart = 2;
    }
    const m = timeLine.match(/([\d:\.]+)\s*-->\s*([\d:\.]+)/);
    if (!m) continue;
    const start = _parseVTTTime(m[1]);
    const end   = _parseVTTTime(m[2]);
    const text  = lines.slice(textStart).join('\n').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function _parseVTTTime(s) {
  // MM:SS.mmm or HH:MM:SS.mmm
  const parts = s.split(':');
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  }
  return parseInt(parts[0], 10) * 60 + parseFloat(parts[1] ?? '0');
}

/**
 * Return the cue whose range contains time t, or null.
 * @param {{ start: number, end: number, text: string }[]} cues
 * @param {number} t
 * @returns {{ start: number, end: number, text: string } | null}
 */
export function findActiveCue(cues, t) {
  if (!cues?.length) return null;
  for (const cue of cues) {
    if (t >= cue.start && t < cue.end) return cue;
  }
  return null;
}

/**
 * Render caption text centered at the bottom of a frame.
 * Returns an OffscreenCanvas (HTMLCanvasElement fallback) sized frameW × frameH.
 *
 * @param {string} text
 * @param {{ fontSize?: number, color?: string, bgColor?: string, fontFamily?: string }} opts
 * @param {number} frameW
 * @param {number} frameH
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
export function renderCaptionToCanvas(text, opts, frameW, frameH) {
  const fontSize   = opts?.fontSize   ?? 36;
  const color      = opts?.color      ?? '#ffffff';
  const bgColor    = opts?.bgColor    ?? 'rgba(0,0,0,0.55)';
  const fontFamily = opts?.fontFamily ?? 'sans-serif';

  let canvas;
  try {
    canvas = new OffscreenCanvas(frameW, frameH);
  } catch {
    canvas = document.createElement('canvas');
    canvas.width  = frameW;
    canvas.height = frameH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, frameW, frameH);

  // Scale font relative to 1920-wide reference frame
  const scale  = frameW / 1920;
  const fSize  = Math.max(8, Math.round(fontSize * scale));
  ctx.font         = `${fSize}px ${fontFamily}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';

  const maxWidth = frameW * 0.85;
  const lines    = _wrapText(ctx, text, maxWidth);
  const lineH    = fSize * 1.28;
  const padX     = fSize * 0.75;
  const padY     = fSize * 0.45;
  const blockH   = lines.length * lineH + padY * 2;

  // Measure widest line for background width
  let maxLineW = 0;
  for (const l of lines) {
    const w = ctx.measureText(l).width;
    if (w > maxLineW) maxLineW = w;
  }
  const blockW = Math.min(maxWidth + padX * 2, maxLineW + padX * 2);
  const bx     = (frameW - blockW) / 2;
  const by     = frameH - blockH - Math.round(frameH * 0.06);

  // Rounded-rect background
  _roundRect(ctx, bx, by, blockW, blockH, fSize * 0.3, bgColor);

  // Text lines
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], frameW / 2, by + padY + fSize + i * lineH);
  }

  return canvas;
}

function _wrapText(ctx, text, maxWidth) {
  const out = [];
  for (const raw of text.split('\n')) {
    const words = raw.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

function _roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
