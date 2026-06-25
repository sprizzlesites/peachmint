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

async function mountShell(isMobile) {
  const root = document.getElementById('app-root');
  if (!root) return;

  // Expose engine + helpers to window (used by inline handlers in dialogs/shells)
  window.__peachmint = {
    storage: _storage,
    projectManager: _projectManager,
    history: _historyManager,
    showSysCheck: () => showCapabilityPanel({ force: true }),
    toggleUiMode,
  };

  if (isMobile) {
    const { mountMobileShell } = await import('./mobile/shell.js');
    mountMobileShell(root, {
      projectManager: _projectManager,
      historyManager: _historyManager,
      storage: _storage,
    });
  } else {
    // Real desktop shell (Phase 1.4)
    const { mountDesktopShell } = await import('./desktop/shell.js');
    mountDesktopShell(root, {
      projectManager: _projectManager,
      historyManager: _historyManager,
      storage: _storage,
    });
  }
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

// Exposed before boot completes (some handlers reference these early)
window.showSysCheck = () => showCapabilityPanel({ force: true });
window.toggleUiMode = toggleUiMode;
