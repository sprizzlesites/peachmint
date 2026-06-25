/**
 * inspector.js — Right-side inspector / properties panel
 *
 * Shows properties for the selected clip or track.
 * Phase 1.4: read-only display + basic editable fields.
 * Phase 1.6: will add keyframe controls and full transform editing.
 */

export class Inspector {
  constructor(container, { pm, history }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
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

    this._el.querySelector('#pm-insp-header').innerHTML = `
      <span class="pm-insp-title">Clip</span>
      <span class="pm-insp-id">${clip.id.slice(0, 10)}…</span>
    `;

    this._el.querySelector('#pm-insp-body').innerHTML = `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Timing</div>
        ${row('Start', formatSec(clip.startTime))}
        ${row('Duration', formatSec(clip.duration))}
        ${row('Trim In', formatSec(clip.trimIn))}
        ${row('Trim Out', formatSec(clip.trimOut))}
        ${row('Speed', `${clip.speed}×`)}
      </div>

      ${asset ? `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Source Asset</div>
        ${row('Name', asset.name ?? '—')}
        ${row('Type', asset.type ?? '—')}
        ${row('Resolution', asset.width ? `${asset.width}×${asset.height}` : '—')}
        ${row('Duration', asset.duration != null ? formatSec(asset.duration) : '—')}
      </div>` : ''}

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Compositing</div>
        ${propRow('Opacity', 'opacity', p.opacity, 0, 1, 0.01, clip)}
        ${row('Blend Mode', p.blendMode ?? 'normal')}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Transform</div>
        ${propRow('X', 'transform.x', p.transform.x, -9999, 9999, 1, clip)}
        ${propRow('Y', 'transform.y', p.transform.y, -9999, 9999, 1, clip)}
        ${propRow('Scale X', 'transform.scaleX', p.transform.scaleX, 0, 10, 0.01, clip)}
        ${propRow('Scale Y', 'transform.scaleY', p.transform.scaleY, 0, 10, 0.01, clip)}
        ${propRow('Rotation', 'transform.rotation', p.transform.rotation, -360, 360, 0.1, clip)}
      </div>

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Color</div>
        ${propRow('Exposure', 'color.exposure', p.color?.exposure ?? 0, -5, 5, 0.01, clip)}
        ${propRow('Contrast', 'color.contrast', p.color?.contrast ?? 0, -1, 1, 0.01, clip)}
        ${propRow('Saturation', 'color.saturation', p.color?.saturation ?? 0, -1, 1, 0.01, clip)}
      </div>

      ${clip.assetId && (asset?.type === 'audio' || false) || p.volume != null ? `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Audio</div>
        ${propRow('Volume', 'volume', p.volume ?? 1, 0, 2, 0.01, clip)}
      </div>` : ''}

      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Keyframes</div>
        ${Object.keys(clip.keyframes).length === 0
          ? '<div class="pm-insp-empty-sm">No keyframes — Phase 1.6 will add the keyframe editor</div>'
          : Object.keys(clip.keyframes).map((k) =>
              `<div class="pm-insp-kf-row"><span>${escHtml(k)}</span><span>${clip.keyframes[k].length} KF</span></div>`
            ).join('')}
      </div>
    `;

    // Wire up prop inputs
    this._el.querySelectorAll('.pm-insp-prop-input').forEach((input) => {
      input.addEventListener('change', () => this._onPropChange(input));
    });
  }

  showTrack(track) {
    this._currentClip = null;
    this._el.querySelector('#pm-insp-header').innerHTML = `
      <span class="pm-insp-title">Track</span>
      <span class="pm-insp-id">${track.type}</span>
    `;
    this._el.querySelector('#pm-insp-body').innerHTML = `
      <div class="pm-insp-section">
        <div class="pm-insp-section-label">Track Properties</div>
        ${row('Name', track.name)}
        ${row('Type', track.type)}
        ${row('Z-order', String(track.zIndex))}
        ${row('Clips', String(track.clips.length))}
        ${row('Muted', track.muted ? 'Yes' : 'No')}
        ${row('Solo', track.solo ? 'Yes' : 'No')}
        ${row('Locked', track.locked ? 'Yes' : 'No')}
      </div>
    `;
  }

  // ─── Prop editing ─────────────────────────────────────────────────────────────

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
      undo: () => { setPropValue(clip.properties, path, oldVal); input.value = oldVal; this._pm.markDirty(); },
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

function propRow(label, path, value, min, max, step, clip) {
  return `
    <div class="pm-insp-row pm-insp-prop-row">
      <span class="pm-insp-row-label">${escHtml(label)}</span>
      <input class="pm-insp-prop-input pm-insp-num" type="number"
             data-prop="${escHtml(path)}"
             value="${Number(value).toFixed(3)}"
             min="${min}" max="${max}" step="${step}"
             aria-label="${escHtml(label)}">
    </div>
  `;
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
    .pm-insp-id { font-family:var(--font-mono); font-size:0.65rem; color:var(--text-dim); }
    .pm-insp-body { flex:1; overflow-y:auto; }
    .pm-insp-empty { display:flex; align-items:center; justify-content:center; height:100%;
      color:var(--text-dim); font-size:0.78rem; padding:24px; text-align:center; line-height:1.6; }
    .pm-insp-empty-sm { color:var(--text-dim); font-size:0.72rem; padding:4px 0; }
    .pm-insp-section { border-bottom:1px solid var(--border); padding:8px 0; }
    .pm-insp-section-label { font-size:0.65rem; font-weight:600; text-transform:uppercase;
      letter-spacing:0.08em; color:var(--text-dim); padding:2px 12px 6px; }
    .pm-insp-row { display:flex; align-items:center; justify-content:space-between;
      padding:3px 12px; min-height:24px; }
    .pm-insp-row:hover { background:var(--bg-hover); }
    .pm-insp-row-label { font-size:0.75rem; color:var(--text-muted); }
    .pm-insp-row-value { font-family:var(--font-mono); font-size:0.72rem; color:var(--text-primary); }
    .pm-insp-num { background:var(--bg-base); border:1px solid var(--border); color:var(--text-primary);
      border-radius:4px; padding:2px 6px; font-size:0.72rem; font-family:var(--font-mono);
      width:80px; text-align:right; outline:none; }
    .pm-insp-num:focus { border-color:var(--accent-purple); }
    .pm-insp-kf-row { display:flex; align-items:center; justify-content:space-between;
      padding:3px 12px; font-size:0.72rem; font-family:var(--font-mono); color:var(--text-muted); }
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

function getPropValue(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function setPropValue(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  if (target != null) target[last] = val;
}
