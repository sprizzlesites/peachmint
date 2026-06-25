/**
 * inspector.js — Right-side inspector / properties panel
 *
 * Phase 1.4: read-only display + basic editable numeric fields.
 * Phase 1.6: keyframe add/delete per property, keyframe list, clip name display.
 */

import { setKeyframe, removeKeyframe }   from '../../engine/edl.js';
import { parseCube, parse3dl, detectLUTFormat } from '../../engine/lut.js';

export class Inspector {
  /**
   * @param {HTMLElement} container
   * @param {{ pm, history, getCurrentTime, storage }} opts
   */
  constructor(container, { pm, history, getCurrentTime, storage }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._storage = storage ?? null;
    this._getCurrentTime = getCurrentTime ?? (() => 0);
    this._currentClip = null;
    this._mount();
  }

  _mount() {
    injectStyles();
    this._el.innerHTML = `
      <div class="pm-insp-root">
        <div class="pm-insp-header" id="pm-insp-header">
          <span class="pm-insp-title">Inspector</span>
        </div>
        <div class="pm-insp-body" id="pm-insp-body">
          <div class="pm-insp-empty">Select a clip or track to see its properties</div>
        </div>
      </div>
    `;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  clear() {
    this._currentClip = null;
    this._el.querySelector('#pm-insp-header').innerHTML = `<span class="pm-insp-title">Inspector</span>`;
    this._el.querySelector('#pm-insp-body').innerHTML = `<div class="pm-insp-empty">Select a clip or track to see its properties</div>`;
  }

  showClip(clip) {
    this._currentClip = clip;
    const asset = this._pm.project?.assets.find((a) => a.id === clip.assetId);
    const p = clip.properties;
    const hasKF = (path) => (clip.keyframes[path]?.length ?? 0) > 0;

    this._el.querySelector('#pm-insp-header').innerHTML = `
      <span class="pm-insp-title">Clip</span>
      <span class="pm-insp-id">${escHtml(asset?.name ?? clip.id.slice(0, 10) + '…')}</span>
    `;

    this._el.querySelector('#pm-insp-body').innerHTML = `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Timing</div>
        ${row('Start',    formatSec(clip.startTime))}
        ${row('Duration', formatSec(clip.duration))}
        ${row('Trim In',  formatSec(clip.trimIn))}
        ${row('Trim Out', clip.trimOut != null ? formatSec(clip.trimOut) : '— (end)')}
        ${row('Speed',    `${clip.speed}×`)}
      </div>

      ${asset ? `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Source</div>
        ${row('File',   asset.name ?? '—')}
        ${row('Type',   asset.type ?? '—')}
        ${asset.width ? row('Resolution', `${asset.width}×${asset.height}`) : ''}
        ${asset.duration ? row('Media dur.', formatSec(asset.duration)) : ''}
      </div>` : ''}

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Compositing</div>
        ${propRow('Opacity',   'opacity',   p.opacity,   0, 1,     0.01, hasKF('opacity'))}
        ${propRow('Volume',    'volume',    p.volume ?? 1, 0, 2, 0.01, hasKF('volume'))}
        ${row('Blend Mode', p.blendMode ?? 'normal')}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Transform</div>
        ${propRow('X',        'transform.x',        p.transform.x,        -9999, 9999, 1,    hasKF('transform.x'))}
        ${propRow('Y',        'transform.y',        p.transform.y,        -9999, 9999, 1,    hasKF('transform.y'))}
        ${propRow('Scale X',  'transform.scaleX',   p.transform.scaleX,   0, 10,    0.01, hasKF('transform.scaleX'))}
        ${propRow('Scale Y',  'transform.scaleY',   p.transform.scaleY,   0, 10,    0.01, hasKF('transform.scaleY'))}
        ${propRow('Rotation', 'transform.rotation', p.transform.rotation, -360, 360, 0.5, hasKF('transform.rotation'))}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Color</div>
        ${propRow('Exposure',    'color.exposure',    p.color?.exposure    ?? 0, -5, 5,  0.01, hasKF('color.exposure'))}
        ${propRow('Contrast',    'color.contrast',    p.color?.contrast    ?? 0, -1, 1,  0.01, hasKF('color.contrast'))}
        ${propRow('Saturation',  'color.saturation',  p.color?.saturation  ?? 0, -1, 1,  0.01, hasKF('color.saturation'))}
        ${propRow('Temperature', 'color.temperature', p.color?.temperature ?? 0, -1, 1,  0.01, hasKF('color.temperature'))}
        ${propRow('Tint',        'color.tint',        p.color?.tint        ?? 0, -1, 1,  0.01, hasKF('color.tint'))}
        ${lutRow(p.color?.lut, this._pm.project?.assets)}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Chroma Key</div>
        <div class="pm-insp-row">
          <span class="pm-insp-row-label">Enabled</span>
          <label class="pm-toggle">
            <input type="checkbox" class="pm-chroma-enabled" ${p.chroma?.enabled ? 'checked' : ''}>
            <span class="pm-toggle-track"></span>
          </label>
        </div>
        <div class="pm-insp-row">
          <span class="pm-insp-row-label">Key Color</span>
          <input type="color" class="pm-chroma-color" value="${rgbToHex(p.chroma?.color ?? [0, 1, 0])}">
        </div>
        ${propRow('Threshold',  'chroma.threshold', p.chroma?.threshold ?? 0.35, 0, 1, 0.01, hasKF('chroma.threshold'))}
        ${propRow('Smoothness', 'chroma.smooth',    p.chroma?.smooth    ?? 0.1,  0, 1, 0.01, hasKF('chroma.smooth'))}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Mask</div>
        <div class="pm-insp-row">
          <span class="pm-insp-row-label">Type</span>
          <select class="pm-mask-type pm-insp-select">
            <option value="none"    ${(p.mask?.type ?? 'none') === 'none'    ? 'selected' : ''}>None</option>
            <option value="rect"    ${(p.mask?.type ?? 'none') === 'rect'    ? 'selected' : ''}>Rectangle</option>
            <option value="ellipse" ${(p.mask?.type ?? 'none') === 'ellipse' ? 'selected' : ''}>Ellipse</option>
          </select>
        </div>
        ${(p.mask?.type && p.mask.type !== 'none') ? `
          ${propRow('X',       'mask.x',       p.mask.x       ?? 0.5,  0,    1,    0.01,  hasKF('mask.x'))}
          ${propRow('Y',       'mask.y',       p.mask.y       ?? 0.5,  0,    1,    0.01,  hasKF('mask.y'))}
          ${propRow('Width',   'mask.w',       p.mask.w       ?? 0.5,  0.01, 2,    0.01,  hasKF('mask.w'))}
          ${propRow('Height',  'mask.h',       p.mask.h       ?? 0.5,  0.01, 2,    0.01,  hasKF('mask.h'))}
          ${propRow('Feather', 'mask.feather', p.mask.feather ?? 0.05, 0,    0.5,  0.001, hasKF('mask.feather'))}
          <div class="pm-insp-row">
            <span class="pm-insp-row-label">Invert</span>
            <label class="pm-toggle">
              <input type="checkbox" class="pm-mask-invert" ${p.mask?.invert ? 'checked' : ''}>
              <span class="pm-toggle-track"></span>
            </label>
          </div>
        ` : ''}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Keyframes</div>
        <div id="pm-insp-kf-list">${buildKfList(clip)}</div>
      </div>
    `;

    // Wire numeric inputs
    this._el.querySelectorAll('.pm-insp-prop-input').forEach((input) => {
      input.addEventListener('change', () => this._onPropChange(input));
    });

    // Wire keyframe (◆) buttons
    this._el.querySelectorAll('.pm-insp-kf-add-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._onAddKeyframe(btn.dataset.prop));
    });

    // Wire keyframe delete buttons
    this._el.querySelectorAll('.pm-insp-kf-del').forEach((btn) => {
      btn.addEventListener('click', () => this._onDeleteKeyframe(btn.dataset.prop, parseFloat(btn.dataset.time)));
    });

    // Wire LUT buttons
    this._el.querySelector('#pm-insp-lut-import')?.addEventListener('click', () => this._onImportLUT());
    this._el.querySelector('#pm-insp-lut-clear')?.addEventListener('click',  () => this._onClearLUT());

    // Wire chroma key controls
    const chromaEnabledEl = this._el.querySelector('.pm-chroma-enabled');
    chromaEnabledEl?.addEventListener('change', () => this._onChromaEnabledChange(chromaEnabledEl.checked));
    const chromaColorEl = this._el.querySelector('.pm-chroma-color');
    chromaColorEl?.addEventListener('change', () => this._onChromaColorChange(chromaColorEl.value));

    // Wire mask controls
    const maskTypeEl = this._el.querySelector('.pm-mask-type');
    maskTypeEl?.addEventListener('change', () => this._onMaskTypeChange(maskTypeEl.value));
    const maskInvertEl = this._el.querySelector('.pm-mask-invert');
    maskInvertEl?.addEventListener('change', () => this._onMaskInvertChange(maskInvertEl.checked));
  }

  showTrack(track) {
    this._currentClip = null;
    this._el.querySelector('#pm-insp-header').innerHTML = `
      <span class="pm-insp-title">Track</span>
      <span class="pm-insp-id">${escHtml(track.type)}</span>
    `;
    this._el.querySelector('#pm-insp-body').innerHTML = `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Track Properties</div>
        ${row('Name',    track.name)}
        ${row('Type',    track.type)}
        ${row('Z-order', String(track.zIndex))}
        ${row('Clips',   String(track.clips.length))}
        ${row('Muted',   track.muted  ? 'Yes' : 'No')}
        ${row('Locked',  track.locked ? 'Yes' : 'No')}
      </div>
    `;
  }

  // ─── Event handlers ──────────────────────────────────────────────────────────

  _onPropChange(input) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const path = input.dataset.prop;
    const newVal = parseFloat(input.value);
    if (isNaN(newVal)) return;
    const oldVal = getPropValue(clip.properties, path);
    this._history.execute({
      label: `Set ${path}`,
      execute: () => { setPropValue(clip.properties, path, newVal); this._pm.markDirty(); },
      undo:    () => { setPropValue(clip.properties, path, oldVal); input.value = String(oldVal); this._pm.markDirty(); },
    });
  }

  _onAddKeyframe(propPath) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const time = this._getCurrentTime();
    const value = getPropValue(clip.properties, propPath) ?? 0;

    const kf = { time, value, easing: 'linear' };
    const prev = [...(clip.keyframes[propPath] ?? [])];

    this._history.execute({
      label: `Add keyframe: ${propPath} @ ${time.toFixed(2)}s`,
      execute: () => {
        setKeyframe(clip, propPath, kf);
        this._pm.markDirty();
        this._refreshKfList(clip);
      },
      undo: () => {
        clip.keyframes[propPath] = prev;
        this._pm.markDirty();
        this._refreshKfList(clip);
      },
    });
  }

  _onDeleteKeyframe(propPath, time) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const prev = [...(clip.keyframes[propPath] ?? [])];

    this._history.execute({
      label: `Delete keyframe: ${propPath} @ ${time.toFixed(2)}s`,
      execute: () => {
        removeKeyframe(clip, propPath, time);
        this._pm.markDirty();
        this._refreshKfList(clip);
      },
      undo: () => {
        clip.keyframes[propPath] = prev;
        this._pm.markDirty();
        this._refreshKfList(clip);
      },
    });
  }

  _onChromaEnabledChange(enabled) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const old = clip.properties.chroma?.enabled ?? false;
    this._history.execute({
      label: enabled ? 'Enable chroma key' : 'Disable chroma key',
      execute: () => { (clip.properties.chroma ??= {}).enabled = enabled;  this._pm.markDirty(); },
      undo:    () => { (clip.properties.chroma ??= {}).enabled = old;      this._pm.markDirty(); },
    });
  }

  _onChromaColorChange(hex) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const color = hexToRgb(hex);
    const old   = clip.properties.chroma?.color ?? [0, 1, 0];
    this._history.execute({
      label: 'Set chroma key color',
      execute: () => { (clip.properties.chroma ??= {}).color = color; this._pm.markDirty(); },
      undo:    () => { (clip.properties.chroma ??= {}).color = old;   this._pm.markDirty(); },
    });
  }

  _onMaskTypeChange(type) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    this._history.snapshotCommand('Set mask type', () => {
      (clip.properties.mask ??= {}).type = type;
    });
    this._pm.markDirty();
    this.showClip(clip); // re-render so mask prop rows appear/disappear
  }

  _onMaskInvertChange(inverted) {
    const clip = this._currentClip;
    if (!clip || !this._pm.project) return;
    const old = clip.properties.mask?.invert ?? false;
    this._history.execute({
      label: inverted ? 'Invert mask' : 'Un-invert mask',
      execute: () => { (clip.properties.mask ??= {}).invert = inverted; this._pm.markDirty(); },
      undo:    () => { (clip.properties.mask ??= {}).invert = old;      this._pm.markDirty(); },
    });
  }

  _onImportLUT() {
    if (!this._currentClip || !this._pm.project || !this._storage) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cube,.3dl';
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this._ingestLUT(file);
    }, { once: true });
    input.click();
  }

  async _ingestLUT(file) {
    const clip    = this._currentClip;
    const project = this._pm.project;
    if (!clip || !project) return;
    try {
      const fmt = detectLUTFormat(file.name);
      if (!fmt) throw new Error('Unsupported file type — use .cube or .3dl');
      const text   = await file.text();
      const parsed = fmt === '3dl' ? parse3dl(text) : parseCube(text);

      const enc        = new TextEncoder();
      const storageKey = await this._storage.writeMedia('lut_' + file.name, enc.encode(text).buffer);
      const id         = 'lut' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const asset      = { id, name: file.name, type: 'lut', storageKey, lutFormat: fmt, lutSize: parsed.size };

      this._history.snapshotCommand('Import LUT: ' + file.name, () => {
        project.assets.push(asset);
        if (!clip.properties.color) clip.properties.color = {};
        clip.properties.color.lut = id;
      });
      this._pm.markDirty();
      this.showClip(clip);
    } catch (e) {
      this._showError('LUT import failed: ' + e.message);
    }
  }

  _onClearLUT() {
    const clip    = this._currentClip;
    const project = this._pm.project;
    if (!clip || !project) return;
    this._history.snapshotCommand('Clear LUT', () => {
      if (clip.properties.color) delete clip.properties.color.lut;
    });
    this._pm.markDirty();
    this.showClip(clip);
  }

  _showError(msg) {
    const body = this._el.querySelector('#pm-insp-body');
    if (!body) return;
    const err = document.createElement('div');
    err.className = 'pm-insp-error';
    err.textContent = msg;
    body.prepend(err);
    setTimeout(() => err.remove(), 5000);
  }

  _refreshKfList(clip) {
    const el = this._el.querySelector('#pm-insp-kf-list');
    if (!el) return;
    el.innerHTML = buildKfList(clip);
    el.querySelectorAll('.pm-insp-kf-del').forEach((btn) => {
      btn.addEventListener('click', () => this._onDeleteKeyframe(btn.dataset.prop, parseFloat(btn.dataset.time)));
    });
    // Update keyframe indicator dots on buttons
    this._el.querySelectorAll('.pm-insp-kf-add-btn').forEach((btn) => {
      const hasKF = (clip.keyframes[btn.dataset.prop]?.length ?? 0) > 0;
      btn.classList.toggle('has-kf', hasKF);
    });
  }
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function row(label, value) {
  return `
    <div class="pm-insp-row">
      <span class="pm-insp-row-label">${escHtml(label)}</span>
      <span class="pm-insp-row-value">${escHtml(String(value))}</span>
    </div>
  `;
}

function propRow(label, path, value, min, max, step, hasKF) {
  return `
    <div class="pm-insp-row pm-insp-prop-row">
      <span class="pm-insp-row-label">${escHtml(label)}</span>
      <div class="pm-insp-prop-controls">
        <button class="pm-insp-kf-add-btn ${hasKF ? 'has-kf' : ''}"
                data-prop="${escHtml(path)}"
                title="Add keyframe at current time"
                aria-label="Add keyframe for ${escHtml(label)}">◆</button>
        <input class="pm-insp-prop-input pm-insp-num" type="number"
               data-prop="${escHtml(path)}"
               value="${Number(value).toFixed(3)}"
               min="${min}" max="${max}" step="${step}"
               aria-label="${escHtml(label)}">
      </div>
    </div>
  `;
}

function lutRow(lutId, assets) {
  const lutAsset = lutId ? assets?.find((a) => a.id === lutId) : null;
  const name = lutAsset ? escHtml(lutAsset.name) : 'None';
  return `
    <div class="pm-insp-row pm-insp-lut-row">
      <span class="pm-insp-row-label">LUT</span>
      <div class="pm-insp-lut-controls">
        <span class="pm-insp-lut-name" title="${lutAsset ? escHtml(lutAsset.name) : ''}">${name}</span>
        <button class="pm-btn-sm" id="pm-insp-lut-import">Import…</button>
        ${lutAsset ? `<button class="pm-btn-sm pm-btn-ghost" id="pm-insp-lut-clear">Clear</button>` : ''}
      </div>
    </div>
  `;
}

function buildKfList(clip) {
  const paths = Object.keys(clip.keyframes).filter((k) => clip.keyframes[k].length > 0);
  if (!paths.length) return '<div class="pm-insp-empty-sm">No keyframes yet — click ◆ next to a property to add one</div>';

  return paths.map((path) =>
    `<div class="pm-insp-kf-prop">
      <span class="pm-insp-kf-prop-name">${escHtml(path)}</span>
      ${clip.keyframes[path].map((kf) => `
        <div class="pm-insp-kf-entry">
          <span class="pm-insp-kf-diamond" aria-hidden="true">◆</span>
          <span class="pm-insp-kf-time">${kf.time.toFixed(2)}s</span>
          <span class="pm-insp-kf-val">${typeof kf.value === 'number' ? kf.value.toFixed(3) : kf.value}</span>
          <button class="pm-insp-kf-del"
                  data-prop="${escHtml(path)}"
                  data-time="${kf.time}"
                  aria-label="Delete keyframe at ${kf.time.toFixed(2)}s">✕</button>
        </div>
      `).join('')}
    </div>`
  ).join('');
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .pm-insp-root { display:flex; flex-direction:column; height:100%; }
    .pm-insp-header { display:flex; align-items:center; justify-content:space-between;
      padding:8px 12px; border-bottom:1px solid var(--border); flex-shrink:0; gap:8px; }
    .pm-insp-title { font-size:0.7rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.08em; color:var(--text-muted); }
    .pm-insp-id { font-family:var(--font-mono); font-size:0.65rem; color:var(--text-dim);
      max-width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-insp-body { flex:1; overflow-y:auto; }
    .pm-insp-empty { display:flex; align-items:center; justify-content:center; height:100%;
      color:var(--text-dim); font-size:0.78rem; padding:24px; text-align:center; line-height:1.6; }
    .pm-insp-empty-sm { color:var(--text-dim); font-size:0.72rem; padding:4px 12px; line-height:1.5; }
    .pm-insp-section { border-bottom:1px solid var(--border); padding:8px 0; }
    .pm-insp-section-label { font-size:0.65rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.08em; color:var(--text-dim); padding:2px 12px 6px; }

    /* Generic row */
    .pm-insp-row { display:flex; align-items:center; justify-content:space-between;
      padding:3px 12px; min-height:24px; }
    .pm-insp-row:hover { background:var(--bg-hover); }
    .pm-insp-row-label { font-size:0.75rem; color:var(--text-muted); }
    .pm-insp-row-value { font-family:var(--font-mono); font-size:0.72rem; color:var(--text-primary); }

    /* Prop row with keyframe button */
    .pm-insp-prop-row { justify-content:space-between; }
    .pm-insp-prop-controls { display:flex; align-items:center; gap:4px; }
    .pm-insp-kf-add-btn { background:transparent; border:1px solid var(--border);
      color:var(--text-dim); border-radius:3px; width:20px; height:20px;
      font-size:0.55rem; cursor:pointer; padding:0;
      display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .pm-insp-kf-add-btn:hover { border-color:var(--accent-peach); color:var(--accent-peach); }
    .pm-insp-kf-add-btn.has-kf { background:var(--accent-peach); border-color:var(--accent-peach);
      color:#181820; }
    .pm-insp-num { background:var(--bg-base); border:1px solid var(--border); color:var(--text-primary);
      border-radius:4px; padding:2px 6px; font-size:0.72rem; font-family:var(--font-mono);
      width:80px; text-align:right; outline:none; }
    .pm-insp-num:focus { border-color:var(--accent-purple); }

    /* Keyframe list */
    .pm-insp-kf-prop { padding:4px 12px; }
    .pm-insp-kf-prop-name { display:block; font-family:var(--font-mono); font-size:0.65rem;
      color:var(--text-muted); margin-bottom:3px; }
    .pm-insp-kf-entry { display:flex; align-items:center; gap:6px; padding:2px 0; }
    .pm-insp-kf-diamond { color:var(--accent-peach); font-size:0.6rem; }
    .pm-insp-kf-time { font-family:var(--font-mono); font-size:0.68rem; color:var(--accent-blue);
      min-width:40px; }
    .pm-insp-kf-val { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-primary);
      flex:1; }
    .pm-insp-kf-del { background:transparent; border:none; color:var(--text-dim); cursor:pointer;
      font-size:0.65rem; padding:0 2px; border-radius:2px; }
    .pm-insp-kf-del:hover { background:var(--accent-err); color:#fff; }

    /* Toggle switch */
    .pm-toggle { display:inline-flex; align-items:center; cursor:pointer; }
    .pm-toggle input { position:absolute; opacity:0; width:0; height:0; }
    .pm-toggle-track { width:28px; height:15px; background:var(--border); border-radius:8px;
      position:relative; transition:background 0.15s; flex-shrink:0; }
    .pm-toggle input:checked + .pm-toggle-track { background:var(--accent-peach); }
    .pm-toggle-track::after { content:''; position:absolute; width:11px; height:11px;
      background:#fff; border-radius:50%; top:2px; left:2px; transition:transform 0.15s; }
    .pm-toggle input:checked + .pm-toggle-track::after { transform:translateX(13px); }

    /* Color picker */
    .pm-chroma-color { width:36px; height:22px; padding:1px; border:1px solid var(--border);
      border-radius:4px; cursor:pointer; background:var(--bg-base); }

    /* Select */
    .pm-insp-select { background:var(--bg-base); border:1px solid var(--border);
      color:var(--text-primary); border-radius:4px; padding:2px 4px;
      font-size:0.72rem; outline:none; cursor:pointer; max-width:100px; }
    .pm-insp-select:focus { border-color:var(--accent-purple); }

    /* LUT row */
    .pm-insp-lut-row { flex-direction:column; align-items:flex-start; gap:4px; padding:6px 12px; }
    .pm-insp-lut-controls { display:flex; align-items:center; gap:6px; width:100%; }
    .pm-insp-lut-name { font-family:var(--font-mono); font-size:0.65rem; color:var(--text-muted);
      flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:110px; }
    .pm-btn-sm { font-size:0.68rem; padding:2px 8px; border-radius:4px; cursor:pointer;
      background:var(--bg-ui,#2a2a3a); border:1px solid var(--border); color:var(--text-primary); }
    .pm-btn-sm:hover { border-color:var(--accent-peach); color:var(--accent-peach); }
    .pm-btn-sm.pm-btn-ghost { background:transparent; }
    .pm-insp-error { background:var(--accent-err,#8b1a1a); color:#fff; font-size:0.72rem;
      padding:6px 12px; border-radius:4px; margin:6px; line-height:1.4; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatSec(s) {
  if (s == null) return '—';
  return `${Number(s).toFixed(3)}s`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex(rgb) {
  return '#' + (rgb ?? [0, 1, 0]).map((v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  ).join('');
}

function getPropValue(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function setPropValue(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  if (target != null) target[last] = val;
}
