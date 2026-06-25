/**
 * capability-panel.js — System check overlay shown at first launch
 *
 * Uses native <dialog> element. No alert/confirm/prompt. Fully keyboard-accessible.
 * Renders a real-time table of detected capabilities and a storage round-trip result.
 */

import { detect, TIER } from '../engine/capabilities.js';
import { StorageLayer } from '../engine/storage.js';

const DISMISS_PREF = 'peachmint_cap_panel_dismissed';

/**
 * Show the capability panel as a <dialog> modal.
 * Resolves when the user dismisses it.
 * @param {{ force?: boolean }} opts - force=true ignores previous dismissal
 */
export async function showCapabilityPanel(opts = {}) {
  const alreadyDismissed = localStorage.getItem(DISMISS_PREF) === '1';
  if (alreadyDismissed && !opts.force) return;

  const dialog = buildDialog();
  document.body.appendChild(dialog);

  // Populate with live capability data
  renderLoading(dialog);
  dialog.showModal();
  trapFocus(dialog);

  // Run checks in parallel
  const [caps, storageResult] = await Promise.all([
    detect(),
    runStorageTest(),
  ]);

  renderResults(dialog, caps, storageResult);

  // Wait for user dismissal
  return new Promise((resolve) => {
    const close = (remember) => {
      if (remember) localStorage.setItem(DISMISS_PREF, '1');
      dialog.close();
      dialog.remove();
      resolve();
    };

    dialog.querySelector('#cap-dismiss').addEventListener('click', () => close(true));
    dialog.querySelector('#cap-show-again').addEventListener('click', () => close(false));
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
    });
    dialog.addEventListener('close', () => resolve());
  });
}

// ─── Build DOM ────────────────────────────────────────────────────────────────

function buildDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = 'cap-panel';
  dialog.setAttribute('aria-labelledby', 'cap-title');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <div class="cap-header">
      <span class="cap-logo">🍑🌿</span>
      <h2 id="cap-title">PeachMint — System Check</h2>
    </div>
    <div class="cap-body" id="cap-body">
      <p class="cap-loading">Detecting capabilities…</p>
    </div>
    <div class="cap-footer">
      <button id="cap-show-again" class="btn-ghost">Show again next time</button>
      <button id="cap-dismiss" class="btn-primary" autofocus>Get Started</button>
    </div>
  `;
  injectStyles();
  return dialog;
}

function renderLoading(dialog) {
  dialog.querySelector('#cap-body').innerHTML = `
    <p class="cap-loading">Running system check…</p>
  `;
}

function renderResults(dialog, caps, storageResult) {
  const tier = caps.tier;
  const tierColor = { full: '#50fa7b', 'near-full': '#8be9fd', partial: '#ffb86c', limited: '#ff79c6', minimal: '#ff5555' }[tier] ?? '#f8f8f2';

  const rows = [
    ['WebCodecs Decode',   caps.webCodecsDecode,   'Needed for frame-accurate playback'],
    ['WebCodecs Encode',   caps.webCodesEncode,    'Needed for fast hardware export'],
    ['WebGL2',             caps.webgl2,            'Required for compositing and effects'],
    ['WebGPU',             caps.webgpu,            'Optional — faster compute effects'],
    ['OffscreenCanvas',    caps.offscreenCanvas,   'Moves rendering off main thread'],
    ['Web Workers',        caps.workers,           'Parallelizes decode/encode'],
    ['OPFS',               caps.opfs,              'Fast on-device media storage'],
    ['IndexedDB',          caps.indexeddb,         'Project state storage'],
    ['Web Audio API',      caps.audioContext,       'Audio playback and mixing'],
    ['Service Worker',     caps.serviceWorker,     'Enables offline use'],
    ['SharedArrayBuffer',  caps.sharedArrayBuffer, 'Optional — faster fallback codec'],
    ['Persist Storage',    caps.persistStorage,    'Guards against browser eviction'],
  ];

  const tableRows = rows.map(([label, val, desc]) => `
    <tr>
      <td class="cap-label">${label}</td>
      <td class="cap-val ${val ? 'ok' : 'no'}">${val ? '✓ OK' : '✗ N/A'}</td>
      <td class="cap-desc">${desc}</td>
    </tr>
  `).join('');

  const storageRow = storageResult.ok
    ? `<p class="cap-storage ok">✓ Storage round-trip OK (${storageResult.backend})</p>`
    : `<p class="cap-storage no">✗ Storage test failed: ${storageResult.error}</p>`;

  const warnings = caps.warnings.length
    ? `<ul class="cap-warnings">${caps.warnings.map((w) => `<li>${w}</li>`).join('')}</ul>`
    : '';

  dialog.querySelector('#cap-body').innerHTML = `
    <div class="cap-tier" style="border-color:${tierColor};color:${tierColor}">
      Capability tier: <strong>${caps.tierLabel}</strong>
    </div>
    <table class="cap-table" role="table" aria-label="Browser capability status">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          <th scope="col">Status</th>
          <th scope="col">Purpose</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    ${storageRow}
    ${warnings}
    <p class="cap-note">
      PeachMint is 100% client-side. Nothing leaves your device.
      All media is processed and stored locally in your browser.
    </p>
  `;
}

// ─── Storage test ─────────────────────────────────────────────────────────────

async function runStorageTest() {
  try {
    const store = new StorageLayer();
    await store.init();
    return store.selfTest();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Focus trap ───────────────────────────────────────────────────────────────

function trapFocus(dialog) {
  const focusable = () => Array.from(
    dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled);

  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const els = focusable();
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    #cap-panel {
      background: #181820;
      color: #f8f8f2;
      border: 1px solid #44475a;
      border-radius: 10px;
      padding: 0;
      max-width: 680px;
      width: 95vw;
      max-height: 90vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      font-family: 'JetBrains Mono', 'Fira Mono', 'Consolas', monospace;
      box-shadow: 0 24px 80px #00000099;
    }
    #cap-panel::backdrop {
      background: rgba(0, 0, 0, 0.82);
      backdrop-filter: blur(2px);
    }
    .cap-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 20px 24px 16px;
      border-bottom: 1px solid #2d2d3e;
      background: #13131a;
    }
    .cap-logo { font-size: 1.4rem; }
    .cap-header h2 {
      margin: 0;
      font-size: 1rem;
      font-weight: 600;
      color: #f8f8f2;
      letter-spacing: 0.02em;
    }
    .cap-body {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
      scrollbar-width: thin;
      scrollbar-color: #44475a #181820;
    }
    .cap-tier {
      border: 1px solid;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 0.875rem;
    }
    .cap-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      margin-bottom: 14px;
    }
    .cap-table th {
      text-align: left;
      padding: 6px 8px;
      color: #6272a4;
      border-bottom: 1px solid #2d2d3e;
      font-weight: 500;
    }
    .cap-table td {
      padding: 5px 8px;
      border-bottom: 1px solid #1e1e2a;
      vertical-align: top;
    }
    .cap-label { color: #f8f8f2; white-space: nowrap; }
    .cap-val.ok { color: #50fa7b; font-weight: 600; }
    .cap-val.no { color: #ff5555; }
    .cap-desc { color: #6272a4; font-size: 0.75rem; }
    .cap-storage { margin: 0 0 12px; font-size: 0.8rem; }
    .cap-storage.ok { color: #50fa7b; }
    .cap-storage.no { color: #ff5555; }
    .cap-warnings {
      margin: 0 0 12px;
      padding-left: 1.2em;
      color: #ffb86c;
      font-size: 0.78rem;
    }
    .cap-warnings li { margin-bottom: 4px; }
    .cap-note {
      color: #6272a4;
      font-size: 0.75rem;
      margin: 8px 0 0;
      line-height: 1.5;
    }
    .cap-loading { color: #6272a4; font-size: 0.9rem; }
    .cap-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 24px;
      border-top: 1px solid #2d2d3e;
      background: #13131a;
    }
    .btn-ghost {
      background: transparent;
      border: 1px solid #44475a;
      color: #6272a4;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.8rem;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-ghost:hover { border-color: #6272a4; color: #f8f8f2; }
    .btn-ghost:focus-visible { outline: 2px solid #bd93f9; outline-offset: 2px; }
    .btn-primary {
      background: #ff8c69;
      border: none;
      color: #181820;
      border-radius: 6px;
      padding: 8px 20px;
      font-size: 0.85rem;
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-primary:hover { background: #ffaa88; }
    .btn-primary:focus-visible { outline: 2px solid #bd93f9; outline-offset: 2px; }
    @media (max-width: 520px) {
      #cap-panel { border-radius: 0; max-width: 100vw; width: 100vw; }
      .cap-desc { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      #cap-panel { animation: none; }
    }
  `;
  document.head.appendChild(style);
}
