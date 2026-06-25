/**
 * app-shell.js — PeachMint application shell
 *
 * Bootstraps the engine, detects device type, routes to desktop or mobile UI.
 * Handles: SW registration, capability check, crash recovery prompt, first load.
 */

import { showCapabilityPanel } from './capability-panel.js';
import { StorageLayer } from '../engine/storage.js';
import { ProjectManager } from '../engine/project.js';
import { HistoryManager } from '../engine/history.js';

// These will be dynamically imported once their shells are built (Phase 1.4, 1.10)
// import { mountDesktopShell } from './desktop/shell.js';
// import { mountMobileShell } from './mobile/shell.js';

let _storage = null;
let _projectManager = null;
let _historyManager = null;

/** Main entry point. Called from index.html on DOMContentLoaded. */
export async function boot() {
  // 1. Register service worker
  await registerSW();

  // 2. Init storage
  _storage = new StorageLayer();
  await _storage.init();

  // 3. Request persistent storage (belt-and-suspenders after StorageLayer.init)
  try {
    const persisted = await navigator.storage.persisted();
    if (!persisted) {
      const granted = await navigator.storage.persist();
      if (!granted) showBanner('warn', 'Storage persistence not granted. Your project may be evicted by the browser under low disk conditions.');
    }
  } catch { /* ignore */ }

  // 4. Show capability panel on first load (or when ?syscheck in URL)
  const forceCheck = new URLSearchParams(location.search).has('syscheck');
  await showCapabilityPanel({ force: forceCheck });

  // 5. Check for crash recovery
  _projectManager = new ProjectManager(_storage);
  _historyManager = new HistoryManager(_projectManager);

  const crashed = await _projectManager.checkCrashRecovery();
  if (crashed) {
    const recover = await confirmRecovery(crashed.name ?? 'Untitled');
    if (recover) {
      await _projectManager.recoverProject(crashed);
    } else {
      // Start fresh; don't delete the crashed project (user might change mind)
    }
  }

  // 6. Mount the right UI shell
  const isMobile = detectMobile();
  mountShell(isMobile);

  // 7. Update storage quota display
  updateQuotaDisplay();

  // Handle ?action=new from PWA shortcut
  if (new URLSearchParams(location.search).get('action') === 'new') {
    await _projectManager.newProject();
  }
}

// ─── Shell routing ────────────────────────────────────────────────────────────

function mountShell(isMobile) {
  const root = document.getElementById('app-root');
  if (!root) return;

  if (isMobile) {
    root.innerHTML = buildMobilePlaceholder();
  } else {
    root.innerHTML = buildDesktopPlaceholder();
  }

  // Expose engine to shell scripts (will be replaced by proper module wiring in Phase 1.4)
  window.__peachmint = { storage: _storage, projectManager: _projectManager, history: _historyManager };
}

function detectMobile() {
  // Check media query: pointer coarse = touch device, or viewport < 768
  const touchPrimary = window.matchMedia('(pointer: coarse)').matches;
  const narrowViewport = window.innerWidth < 768;
  // Allow manual override via localStorage
  const override = localStorage.getItem('peachmint_ui_mode');
  if (override === 'desktop') return false;
  if (override === 'mobile') return true;
  return touchPrimary || narrowViewport;
}

// ─── Placeholder UIs (replaced in Phase 1.4 / 1.10) ─────────────────────────

function buildDesktopPlaceholder() {
  return `
    <div class="pm-desktop-shell" role="main" aria-label="PeachMint Desktop Editor">
      <header class="pm-topbar">
        <span class="pm-brand">🍑🌿 PeachMint</span>
        <nav class="pm-menu" role="menubar" aria-label="Main menu">
          <button role="menuitem" class="pm-menu-btn" onclick="window.__peachmint?.projectManager.newProject()">New</button>
          <button role="menuitem" class="pm-menu-btn">Open…</button>
          <button role="menuitem" class="pm-menu-btn">Save</button>
          <button role="menuitem" class="pm-menu-btn" onclick="window.__peachmint?.history.undo()">Undo</button>
          <button role="menuitem" class="pm-menu-btn" onclick="window.__peachmint?.history.redo()">Redo</button>
          <button role="menuitem" class="pm-menu-btn pm-menu-syscheck" onclick="showSysCheck()">System Check</button>
        </nav>
        <div class="pm-quota" id="pm-quota" aria-live="polite"></div>
      </header>
      <main class="pm-workspace">
        <aside class="pm-panel pm-panel-left">
          <div class="pm-panel-label">Media Library</div>
          <div class="pm-placeholder-content">
            <p>Phase 1.4 — Timeline &amp; media import coming next.</p>
          </div>
        </aside>
        <section class="pm-preview-area" aria-label="Preview">
          <div class="pm-canvas-wrap">
            <canvas id="pm-preview" width="1280" height="720" aria-label="Video preview canvas"></canvas>
            <div class="pm-canvas-overlay">
              <span class="pm-canvas-label">Preview — Phase 1.5</span>
            </div>
          </div>
          <div class="pm-transport" aria-label="Playback controls">
            <button class="pm-btn-transport" aria-label="Rewind to start" title="Rewind">⏮</button>
            <button class="pm-btn-transport" aria-label="Play / Pause" title="Play">▶</button>
            <button class="pm-btn-transport" aria-label="Fast forward" title="Fast forward">⏭</button>
            <span class="pm-timecode" aria-live="polite">00:00:00:00</span>
          </div>
        </section>
        <aside class="pm-panel pm-panel-right">
          <div class="pm-panel-label">Inspector</div>
          <div class="pm-placeholder-content">
            <p>Clip properties &amp; keyframes — Phase 1.6</p>
          </div>
        </aside>
      </main>
      <section class="pm-timeline-area" aria-label="Timeline">
        <div class="pm-timeline-placeholder">
          <span>Multitrack Timeline — Phase 1.4</span>
        </div>
      </section>
      <footer class="pm-statusbar" aria-label="Status bar">
        <span id="pm-save-status" aria-live="polite">No project open</span>
        <a href="#" class="pm-statusbar-link" onclick="showSysCheck(); return false">System Info</a>
        <button class="pm-ui-toggle" onclick="toggleUiMode()">Switch to Mobile UI</button>
      </footer>
    </div>
  `;
}

function buildMobilePlaceholder() {
  return `
    <div class="pm-mobile-shell" role="main" aria-label="PeachMint Mobile Editor">
      <header class="pm-mobile-header">
        <span class="pm-brand">🍑🌿 PeachMint</span>
        <button class="pm-icon-btn" aria-label="Project menu" onclick="openMobileMenu()">☰</button>
      </header>
      <section class="pm-mobile-preview" aria-label="Preview">
        <canvas id="pm-preview" aria-label="Video preview canvas"></canvas>
        <div class="pm-mobile-preview-placeholder">
          <span>Preview — Phase 1.5</span>
        </div>
      </section>
      <div class="pm-mobile-transport" aria-label="Playback controls">
        <button class="pm-mobile-transport-btn" aria-label="Rewind">⏮</button>
        <button class="pm-mobile-transport-btn pm-mobile-play" aria-label="Play">▶</button>
        <button class="pm-mobile-transport-btn" aria-label="Fast forward">⏭</button>
        <span class="pm-timecode" aria-live="polite">00:00:00:00</span>
      </div>
      <section class="pm-mobile-timeline" aria-label="Timeline">
        <div class="pm-timeline-placeholder">
          <span>Timeline — Phase 1.4 / 1.10</span>
        </div>
      </section>
      <nav class="pm-mobile-bottombar" role="toolbar" aria-label="Tools">
        <button class="pm-mobile-tab" aria-label="Media">📂</button>
        <button class="pm-mobile-tab" aria-label="Edit">✂️</button>
        <button class="pm-mobile-tab" aria-label="Effects">✨</button>
        <button class="pm-mobile-tab" aria-label="Export">⬇️</button>
        <button class="pm-mobile-tab" aria-label="System check" onclick="showSysCheck()">⚙️</button>
      </nav>
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('SW registration failed:', err);
  }
}

async function updateQuotaDisplay() {
  if (!_storage) return;
  const el = document.getElementById('pm-quota');
  if (!el) return;
  try {
    const { usage, quota } = await _storage.getQuota();
    const usageMB = (usage / 1024 / 1024).toFixed(1);
    const quotaGB = (quota / 1024 / 1024 / 1024).toFixed(1);
    el.textContent = `Storage: ${usageMB} MB / ${quotaGB} GB`;
  } catch { el.textContent = ''; }
}

/** Inline <dialog>-based recovery prompt — no window.confirm! */
function confirmRecovery(projectName) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rec-title');
    dialog.innerHTML = `
      <h2 id="rec-title">Recover unsaved project?</h2>
      <p>PeachMint found an unsaved project: <strong>${escHtml(projectName)}</strong>.<br>
         It may have been interrupted. Recover it?</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
        <button id="rec-discard" class="btn-ghost">Start Fresh</button>
        <button id="rec-recover" class="btn-primary" autofocus>Recover</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('#rec-recover').addEventListener('click', () => { dialog.close(); dialog.remove(); resolve(true); });
    dialog.querySelector('#rec-discard').addEventListener('click', () => { dialog.close(); dialog.remove(); resolve(false); });
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); dialog.close(); dialog.remove(); resolve(false); } });
  });
}

function showBanner(type, msg) {
  const banner = document.createElement('div');
  banner.className = `pm-banner pm-banner-${type}`;
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `${escHtml(msg)} <button onclick="this.parentElement.remove()" aria-label="Dismiss">×</button>`;
  document.body.prepend(banner);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleUiMode() {
  const current = localStorage.getItem('peachmint_ui_mode');
  localStorage.setItem('peachmint_ui_mode', current === 'mobile' ? 'desktop' : 'mobile');
  location.reload();
}

// Exposed to inline onclick handlers in placeholder UI
window.showSysCheck = () => showCapabilityPanel({ force: true });
window.toggleUiMode = toggleUiMode;
