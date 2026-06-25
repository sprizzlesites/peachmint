/**
 * shell.js — Full desktop editor shell (Phase 1.4)
 *
 * Mounts all panels, owns transport state, wires events between components.
 * Replaces the Phase 0 placeholder in app-shell.js.
 */

import { Timeline } from './timeline.js';
import { Toolbar } from './toolbar.js';
import { Inspector } from './inspector.js';
import { MediaLibrary } from './media-library.js';
import { addTrack, addClip, removeTrack, removeClip } from '../../engine/edl.js';

/** Called from app-shell.js to mount the desktop UI into `container`. */
export function mountDesktopShell(container, { projectManager, historyManager, storage }) {
  const shell = new DesktopShell(container, { pm: projectManager, history: historyManager, storage });
  shell.mount();
  return shell;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMELINE_MIN_H = 140;
const TIMELINE_DEFAULT_H = 250;

// ─── DesktopShell ─────────────────────────────────────────────────────────────

class DesktopShell {
  constructor(container, { pm, history, storage }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._storage = storage;

    this._timeline = null;
    this._toolbar = null;
    this._inspector = null;
    this._library = null;

    this._currentTime = 0;
    this._isPlaying = false;
    this._playTimer = null;
    this._tlHeight = TIMELINE_DEFAULT_H;
    this._resizing = false;
    this._selectedClip = null;
  }

  mount() {
    injectStyles();
    this._el.innerHTML = buildHTML();

    // Bind the resize handle for timeline height
    this._bindTlResize();

    // Mount child panels
    this._toolbar = new Toolbar(this._el.querySelector('#pm-toolbar'), {
      pm: this._pm, history: this._history,
      onAddTrack: (type) => this._addTrack(type),
      onUndo: () => this._history.undo(),
      onRedo: () => this._history.redo(),
      onNewProject: () => this._showNewProjectDialog(),
      onOpenProject: () => this._showOpenProjectDialog(),
      onSaveProject: () => this._pm.saveProject(),
      onZoomIn: () => this._timeline?.zoomIn(),
      onZoomOut: () => this._timeline?.zoomOut(),
      onTogglePlay: () => this._togglePlay(),
      onToolChange: (tool) => this._timeline?.setTool(tool),
    });

    this._library = new MediaLibrary(this._el.querySelector('#pm-media-library'), {
      pm: this._pm, history: this._history,
    });

    this._timeline = new Timeline(this._el.querySelector('#pm-timeline'), {
      pm: this._pm, history: this._history,
      onSeek: (t) => this._onSeek(t),
      onClipSelect: (clip) => this._onClipSelect(clip),
      onTrackSelect: (track) => this._inspector?.showTrack(track),
    });

    this._inspector = new Inspector(this._el.querySelector('#pm-inspector'), {
      pm: this._pm, history: this._history,
    });

    // Wire project manager events
    this._pm.addEventListener('project:opened', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:recovered', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:closed', () => this._onProjectClosed());
    this._pm.addEventListener('project:saved', () => this._setSaveStatus('Saved'));
    this._pm.addEventListener('project:autosaved', () => this._setSaveStatus('Auto-saved'));
    this._pm.addEventListener('project:dirty', () => this._setSaveStatus('Unsaved changes'));

    // Wire history events
    this._history.addEventListener('history:change', (e) => {
      const { canUndo, canRedo, undoLabel, redoLabel } = e.detail;
      this._toolbar?.updateHistory({ canUndo, canRedo, undoLabel, redoLabel });
    });

    // Keyboard shortcuts
    this._bindKeyboard();

    // Transport buttons
    this._bindTransport();

    // Initial state
    if (this._pm.project) {
      this._onProjectOpened(this._pm.project);
    } else {
      this._showStartScreen();
    }

    // Quota display
    this._updateQuota();
  }

  // ─── Project events ─────────────────────────────────────────────────────────

  _onProjectOpened(project) {
    this._hideStartScreen();
    this._currentTime = 0;
    this._updateTimecode(0);
    this._setSaveStatus('');
    this._library?.setProject(project);
    this._timeline?.setProject(project);
    this._inspector?.clear();
    this._toolbar?.setProject(project);
    this._el.querySelector('#pm-project-name').textContent = project.name ?? 'Untitled';
  }

  _onProjectClosed() {
    this._stop();
    this._showStartScreen();
    this._el.querySelector('#pm-project-name').textContent = '';
    this._setSaveStatus('No project open');
  }

  // ─── Playback ────────────────────────────────────────────────────────────────

  _onSeek(time) {
    this._currentTime = time;
    this._updateTimecode(time);
    // Phase 1.5 will feed this to the compositor
    this._el.dispatchEvent(new CustomEvent('pm:seek', { detail: { time }, bubbles: true }));
  }

  _togglePlay() {
    this._isPlaying ? this._stop() : this._play();
  }

  _play() {
    if (this._isPlaying || !this._pm.project) return;
    this._isPlaying = true;
    this._toolbar?.setPlayState(true);
    const startWall = performance.now();
    const startTime = this._currentTime;
    const total = this._pm.project ? totalDur(this._pm.project) : 60;

    this._playTimer = setInterval(() => {
      const elapsed = (performance.now() - startWall) / 1000;
      const t = startTime + elapsed;
      if (t >= total) { this._stop(); this._onSeek(0); return; }
      this._currentTime = t;
      this._updateTimecode(t);
      this._timeline?.seekTo(t);
    }, 1000 / 60);
  }

  _stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    clearInterval(this._playTimer);
    this._playTimer = null;
    this._toolbar?.setPlayState(false);
  }

  // ─── Clip selection ──────────────────────────────────────────────────────────

  _onClipSelect(clip) {
    this._selectedClip = clip;
    this._inspector?.showClip(clip);
  }

  // ─── Track management ────────────────────────────────────────────────────────

  _addTrack(type = 'video') {
    if (!this._pm.project) return;
    const cmd = this._history.snapshotCommand(`Add ${type} track`, (proj) => {
      addTrack(proj, { type });
    });
    this._history.execute(cmd);
    this._timeline?.setProject(this._pm.project);
  }

  // ─── Dialogs ─────────────────────────────────────────────────────────────────

  _showNewProjectDialog() {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'new-proj-title');
    dialog.innerHTML = `
      <h2 id="new-proj-title" style="margin:0 0 16px;font-size:1rem">New Project</h2>
      <label class="pm-dlg-label">Project Name
        <input id="np-name" type="text" value="Untitled Project" class="pm-input" style="width:100%">
      </label>
      <label class="pm-dlg-label" style="margin-top:12px">Canvas Preset
        <select id="np-preset" class="pm-input" style="width:100%">
          <option value="1920x1080x30">YouTube 16:9 — 1920×1080 @ 30fps</option>
          <option value="3840x2160x30">YouTube 4K — 3840×2160 @ 30fps</option>
          <option value="1080x1920x30">Shorts/TikTok/Reels — 1080×1920 @ 30fps</option>
          <option value="1080x1080x30">Square 1:1 — 1080×1080 @ 30fps</option>
          <option value="custom">Custom…</option>
        </select>
      </label>
      <div id="np-custom" style="display:none;margin-top:10px;display:none">
        <div style="display:flex;gap:8px;align-items:center">
          <input id="np-w" type="number" value="1920" class="pm-input" style="width:80px"> ×
          <input id="np-h" type="number" value="1080" class="pm-input" style="width:80px"> @
          <input id="np-fps" type="number" value="30" class="pm-input" style="width:60px"> fps
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button class="btn-ghost" id="np-cancel">Cancel</button>
        <button class="btn-primary" id="np-create" autofocus>Create</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();

    const presetSel = dialog.querySelector('#np-preset');
    const customDiv = dialog.querySelector('#np-custom');
    presetSel.addEventListener('change', () => {
      customDiv.style.display = presetSel.value === 'custom' ? 'block' : 'none';
    });

    dialog.querySelector('#np-cancel').addEventListener('click', () => { dialog.close(); dialog.remove(); });
    dialog.querySelector('#np-create').addEventListener('click', async () => {
      const name = dialog.querySelector('#np-name').value.trim() || 'Untitled Project';
      let width = 1920, height = 1080, fps = 30;
      const preset = presetSel.value;
      if (preset !== 'custom') {
        [width, height, fps] = preset.split('x').map(Number);
      } else {
        width = parseInt(dialog.querySelector('#np-w').value) || 1920;
        height = parseInt(dialog.querySelector('#np-h').value) || 1080;
        fps = parseInt(dialog.querySelector('#np-fps').value) || 30;
      }
      dialog.close(); dialog.remove();
      await this._pm.newProject({ name, width, height, fps });
    });
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { dialog.close(); dialog.remove(); } });
  }

  _showOpenProjectDialog() {
    this._pm._storage.listProjects().then((list) => {
      if (!list.length) {
        this._showInfoDialog('No saved projects', 'No projects found. Create a new one to get started.');
        return;
      }
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'open-proj-title');
      const rows = list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).map((p) => `
        <div class="pm-proj-row" data-id="${escHtml(p.id)}" role="button" tabindex="0">
          <span class="pm-proj-name">${escHtml(p.name ?? 'Untitled')}</span>
          <span class="pm-proj-date">${formatDate(p.updatedAt)}</span>
        </div>
      `).join('');
      dialog.innerHTML = `
        <h2 id="open-proj-title" style="margin:0 0 14px;font-size:1rem">Open Project</h2>
        <div style="max-height:300px;overflow-y:auto">${rows}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:16px">
          <button class="btn-ghost" id="op-cancel">Cancel</button>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.showModal();
      dialog.querySelector('#op-cancel').addEventListener('click', () => { dialog.close(); dialog.remove(); });
      dialog.addEventListener('click', async (e) => {
        const row = e.target.closest('.pm-proj-row');
        if (!row) return;
        const id = row.dataset.id;
        dialog.close(); dialog.remove();
        await this._pm.openProject(id);
      });
      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { dialog.close(); dialog.remove(); }
        if (e.key === 'Enter' && document.activeElement.classList.contains('pm-proj-row')) {
          document.activeElement.click();
        }
      });
    });
  }

  _showInfoDialog(title, msg) {
    const d = document.createElement('dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = `<h2 style="margin:0 0 10px;font-size:1rem">${escHtml(title)}</h2><p style="color:var(--text-muted);font-size:0.85rem">${escHtml(msg)}</p><div style="text-align:right;margin-top:16px"><button class="btn-primary" autofocus>OK</button></div>`;
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('button').addEventListener('click', () => { d.close(); d.remove(); });
  }

  // ─── Start screen ─────────────────────────────────────────────────────────────

  _showStartScreen() {
    const existing = this._el.querySelector('#pm-start-screen');
    if (existing) return;
    const screen = document.createElement('div');
    screen.id = 'pm-start-screen';
    screen.innerHTML = `
      <div class="pm-start-inner">
        <div class="pm-start-logo">🍑🌿</div>
        <h1 class="pm-start-title">PeachMint</h1>
        <p class="pm-start-sub">Browser Video Editor</p>
        <div class="pm-start-actions">
          <button class="pm-start-btn pm-start-new" autofocus>
            <span class="pm-start-btn-icon">+</span>
            New Project
          </button>
          <button class="pm-start-btn pm-start-open">
            <span class="pm-start-btn-icon">📂</span>
            Open Recent
          </button>
        </div>
        <p class="pm-start-note">All media stays on your device. No uploads. No accounts.</p>
      </div>
    `;
    screen.querySelector('.pm-start-new').addEventListener('click', () => this._showNewProjectDialog());
    screen.querySelector('.pm-start-open').addEventListener('click', () => this._showOpenProjectDialog());
    this._el.querySelector('#pm-workspace') .style.position = 'relative';
    this._el.querySelector('#pm-workspace').appendChild(screen);
  }

  _hideStartScreen() {
    this._el.querySelector('#pm-start-screen')?.remove();
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────────

  _setSaveStatus(msg) {
    const el = this._el.querySelector('#pm-save-status');
    if (el) el.textContent = msg;
  }

  _updateTimecode(t) {
    const el = this._el.querySelector('#pm-timecode');
    if (el) el.textContent = formatTimecode(t, this._pm.project?.canvas?.fps ?? 30);
    this._toolbar?.updateTimecode(t, this._pm.project?.canvas?.fps ?? 30);
  }

  async _updateQuota() {
    if (!this._storage) return;
    const el = this._el.querySelector('#pm-quota');
    if (!el) return;
    try {
      const { usage, quota } = await this._storage.getQuota();
      const usageMB = (usage / 1024 / 1024).toFixed(1);
      const quotaGB = (quota / 1024 / 1024 / 1024).toFixed(1);
      el.textContent = `${usageMB} MB / ${quotaGB} GB`;
    } catch { el.textContent = ''; }
  }

  // ─── Timeline resize handle ───────────────────────────────────────────────────

  _bindTlResize() {
    const handle = this._el.querySelector('#pm-tl-resize');
    if (!handle) return;
    let startY, startH;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = this._tlHeight;
      this._resizing = true;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!this._resizing) return;
      const delta = startY - e.clientY;
      this._tlHeight = Math.max(TIMELINE_MIN_H, startH + delta);
      const tlEl = this._el.querySelector('#pm-timeline-area');
      if (tlEl) tlEl.style.height = `${this._tlHeight}px`;
    });
    handle.addEventListener('pointerup', () => { this._resizing = false; });
  }

  // ─── Transport controls ───────────────────────────────────────────────────────

  _bindTransport() {
    const playBtn = this._el.querySelector('#pm-play-btn');
    const rewindBtn = this._el.querySelector('#pm-rewind-btn');
    const fwdBtn = this._el.querySelector('#pm-fwd-btn');
    playBtn?.addEventListener('click', () => this._togglePlay());
    rewindBtn?.addEventListener('click', () => { this._stop(); this._onSeek(0); this._timeline?.seekTo(0); });
    fwdBtn?.addEventListener('click', () => {
      const total = this._pm.project ? totalDur(this._pm.project) : 0;
      this._stop(); this._onSeek(total); this._timeline?.seekTo(total);
    });
  }

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────────

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Don't steal from inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      const ctrl = e.ctrlKey || e.metaKey;

      if (e.code === 'Space') { e.preventDefault(); this._togglePlay(); }
      if (ctrl && e.key === 'z') { e.preventDefault(); this._history.undo(); this._timeline?.setProject(this._pm.project); }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this._history.redo(); this._timeline?.setProject(this._pm.project); }
      if (ctrl && e.key === 's') { e.preventDefault(); this._pm.saveProject(); }
      if (ctrl && e.key === 'n') { e.preventDefault(); this._showNewProjectDialog(); }
      if (ctrl && e.key === 'o') { e.preventDefault(); this._showOpenProjectDialog(); }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const fps = this._pm.project?.canvas?.fps ?? 30;
        const step = e.shiftKey ? 1 : 1 / fps;
        const t = Math.max(0, this._currentTime - step);
        this._onSeek(t); this._timeline?.seekTo(t);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const fps = this._pm.project?.canvas?.fps ?? 30;
        const step = e.shiftKey ? 1 : 1 / fps;
        const total = this._pm.project ? totalDur(this._pm.project) : 60;
        const t = Math.min(total, this._currentTime + step);
        this._onSeek(t); this._timeline?.seekTo(t);
      }

      // Delete selected clip
      if ((e.key === 'Delete' || e.key === 'Backspace') && this._selectedClip) {
        e.preventDefault();
        if (!this._pm.project) return;
        const clip = this._selectedClip;
        const cmd = this._history.snapshotCommand('Delete clip', (proj) => removeClip(proj, clip.id));
        this._history.execute(cmd);
        this._selectedClip = null;
        this._inspector?.clear();
        this._timeline?.setProject(this._pm.project);
      }
    });
  }
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHTML() {
  return `
    <div class="pm-desktop">
      <header class="pm-topbar">
        <span class="pm-brand" aria-label="PeachMint">🍑🌿</span>
        <span id="pm-project-name" class="pm-project-name"></span>
        <div id="pm-toolbar"></div>
        <div class="pm-topbar-right">
          <span id="pm-quota" class="pm-quota" aria-label="Storage usage"></span>
        </div>
      </header>

      <div id="pm-workspace" class="pm-workspace">
        <aside id="pm-media-library" class="pm-panel pm-panel-left" aria-label="Media Library"></aside>
        <section class="pm-center-col" aria-label="Preview and timeline">
          <div class="pm-preview-area">
            <div class="pm-canvas-wrap">
              <canvas id="pm-preview" width="1280" height="720" aria-label="Video preview canvas"></canvas>
            </div>
            <div class="pm-transport" aria-label="Playback controls" role="group">
              <button id="pm-rewind-btn" class="pm-btn-xport" aria-label="Rewind to start" title="Rewind (Home)">⏮</button>
              <button id="pm-play-btn" class="pm-btn-xport pm-btn-play" aria-label="Play" title="Play / Pause (Space)">▶</button>
              <button id="pm-fwd-btn" class="pm-btn-xport" aria-label="Go to end" title="Go to end (End)">⏭</button>
              <span id="pm-timecode" class="pm-timecode" aria-live="polite" aria-label="Current timecode">00:00:00:00</span>
            </div>
          </div>
          <div id="pm-tl-resize" class="pm-tl-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize timeline" tabindex="0"></div>
          <div id="pm-timeline-area" class="pm-timeline-area" style="height:${TIMELINE_DEFAULT_H}px">
            <div id="pm-timeline" class="pm-timeline-mount"></div>
          </div>
        </section>
        <aside id="pm-inspector" class="pm-panel pm-panel-right" aria-label="Inspector"></aside>
      </div>

      <footer class="pm-statusbar" role="contentinfo">
        <span id="pm-save-status" aria-live="polite">No project open</span>
        <a href="#" class="pm-statusbar-link"
           onclick="window.__peachmint?.showSysCheck();return false"
           aria-label="System check">System Info</a>
        <button class="pm-ui-toggle" onclick="window.__peachmint?.toggleUiMode()" aria-label="Switch to mobile UI">
          Mobile UI
        </button>
      </footer>
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
    .pm-desktop { display:flex; flex-direction:column; height:100%; width:100%; overflow:hidden; }

    /* Topbar */
    .pm-topbar { display:flex; align-items:center; gap:6px; padding:0 12px; height:40px;
      background:var(--bg-panel); border-bottom:1px solid var(--border); flex-shrink:0; }
    .pm-brand { font-family:var(--font-mono); font-size:0.95rem; font-weight:700;
      color:var(--accent-peach); letter-spacing:0.04em; margin-right:4px; }
    .pm-project-name { font-size:0.8rem; color:var(--text-muted); max-width:180px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-topbar-right { margin-left:auto; display:flex; align-items:center; gap:12px; }
    .pm-quota { font-family:var(--font-mono); font-size:0.68rem; color:var(--text-dim); }

    /* Workspace */
    .pm-workspace { display:grid; grid-template-columns:220px 1fr 220px; flex:1; min-height:0; overflow:hidden; position:relative; }
    .pm-panel { background:var(--bg-panel); display:flex; flex-direction:column; overflow:hidden; }
    .pm-panel-left { border-right:1px solid var(--border); }
    .pm-panel-right { border-left:1px solid var(--border); }

    /* Center column */
    .pm-center-col { display:flex; flex-direction:column; overflow:hidden; background:var(--bg-base); }

    /* Preview area */
    .pm-preview-area { flex:1; display:flex; flex-direction:column; align-items:center;
      justify-content:center; padding:12px; gap:10px; min-height:0; overflow:hidden; }
    .pm-canvas-wrap { position:relative; max-width:100%; max-height:calc(100% - 48px);
      aspect-ratio:16/9; background:#000; border-radius:6px; overflow:hidden;
      box-shadow:0 4px 32px #00000088; }
    #pm-preview { width:100%; height:100%; display:block; }

    /* Transport */
    .pm-transport { display:flex; align-items:center; gap:6px; flex-shrink:0; }
    .pm-btn-xport { background:var(--bg-panel); border:1px solid var(--border); color:var(--text-primary);
      width:30px; height:30px; border-radius:50%; font-size:0.7rem; cursor:pointer;
      display:flex; align-items:center; justify-content:center; padding:0;
      transition:border-color .1s; }
    .pm-btn-xport:hover { border-color:var(--border-hi); background:var(--bg-hover); }
    .pm-btn-xport:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-btn-play { width:36px; height:36px; font-size:0.85rem;
      background:var(--accent-peach) !important; border-color:var(--accent-peach) !important;
      color:#181820 !important; font-weight:bold; }
    .pm-btn-play.playing { background:var(--bg-panel) !important; border-color:var(--border-hi) !important;
      color:var(--accent-peach) !important; }
    .pm-timecode { font-family:var(--font-mono); font-size:0.85rem; color:var(--accent-blue);
      min-width:110px; padding:0 6px; }

    /* Timeline resize handle */
    .pm-tl-resize-handle { height:4px; background:var(--border); cursor:row-resize;
      flex-shrink:0; transition:background .15s; }
    .pm-tl-resize-handle:hover, .pm-tl-resize-handle:active { background:var(--accent-purple); }

    /* Timeline area */
    .pm-timeline-area { flex-shrink:0; overflow:hidden; background:var(--bg-panel);
      display:flex; flex-direction:column; }
    .pm-timeline-mount { flex:1; overflow:hidden; display:flex; flex-direction:column; }

    /* Status bar */
    .pm-statusbar { display:flex; align-items:center; gap:12px; padding:0 12px; height:24px;
      background:var(--bg-panel); border-top:1px solid var(--border); flex-shrink:0;
      font-family:var(--font-mono); font-size:0.7rem; color:var(--text-dim); }
    .pm-statusbar-link { color:var(--text-muted); text-decoration:none; cursor:pointer; }
    .pm-statusbar-link:hover { color:var(--accent-peach); }
    .pm-ui-toggle { margin-left:auto; background:transparent; border:none; color:var(--text-dim);
      font-family:var(--font-mono); font-size:0.7rem; cursor:pointer; }
    .pm-ui-toggle:hover { color:var(--text-muted); }

    /* Start screen */
    #pm-start-screen { position:absolute; inset:0; background:var(--bg-base);
      display:flex; align-items:center; justify-content:center; z-index:10; }
    .pm-start-inner { display:flex; flex-direction:column; align-items:center; text-align:center; gap:10px; }
    .pm-start-logo { font-size:3.5rem; line-height:1; }
    .pm-start-title { font-family:var(--font-mono); font-size:2rem; font-weight:700; color:var(--accent-peach); margin:0; }
    .pm-start-sub { font-size:0.85rem; color:var(--text-muted); margin:0 0 16px; }
    .pm-start-actions { display:flex; gap:12px; flex-wrap:wrap; justify-content:center; }
    .pm-start-btn { display:flex; align-items:center; gap:8px; padding:12px 24px;
      border-radius:8px; border:1px solid var(--border-hi); background:var(--bg-surface);
      color:var(--text-primary); font-size:0.9rem; cursor:pointer; font-family:var(--font-ui);
      transition:border-color .15s, background .15s; }
    .pm-start-btn:hover { border-color:var(--accent-peach); background:var(--bg-hover); }
    .pm-start-btn:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-start-btn-icon { font-size:1.1rem; }
    .pm-start-new { background:var(--accent-peach) !important; color:#181820 !important;
      border-color:var(--accent-peach) !important; font-weight:700; }
    .pm-start-new:hover { background:#ffaa88 !important; }
    .pm-start-note { font-size:0.75rem; color:var(--text-dim); margin-top:8px; }

    /* New/Open project dialogs */
    dialog { background:var(--bg-surface); color:var(--text-primary);
      border:1px solid var(--border); border-radius:10px; padding:24px;
      max-width:460px; width:90vw; font-family:var(--font-ui); }
    dialog::backdrop { background:rgba(0,0,0,.78); backdrop-filter:blur(2px); }
    dialog h2 { font-size:1rem; }
    .pm-dlg-label { display:flex; flex-direction:column; gap:6px; font-size:0.8rem; color:var(--text-muted); }
    .pm-input { background:var(--bg-base); border:1px solid var(--border); color:var(--text-primary);
      border-radius:6px; padding:7px 10px; font-size:0.85rem; font-family:var(--font-mono);
      outline:none; }
    .pm-input:focus { border-color:var(--accent-purple); }
    .pm-proj-row { display:flex; align-items:center; justify-content:space-between;
      padding:10px 12px; border-radius:6px; cursor:pointer; }
    .pm-proj-row:hover, .pm-proj-row:focus { background:var(--bg-hover); outline:none; }
    .pm-proj-name { font-size:0.85rem; }
    .pm-proj-date { font-family:var(--font-mono); font-size:0.7rem; color:var(--text-dim); }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function totalDur(project) {
  let max = 0;
  for (const t of project.tracks) for (const c of t.clips) max = Math.max(max, c.startTime + c.duration);
  return Math.max(max, 10);
}

function formatTimecode(secs, fps = 30) {
  const s = Math.floor(secs);
  const f = Math.floor((secs - s) * fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}:${pad(f)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
