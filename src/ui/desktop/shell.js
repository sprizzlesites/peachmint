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
import { PreviewEngine } from '../../engine/preview-engine.js';
import { AudioEngine }   from '../../engine/audio-engine.js';
import { addTrack, removeClip, totalDuration } from '../../engine/edl.js';

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
    this._previewEngine = null;
    this._audioEngine = null;

    this._currentTime = 0;
    this._isPlaying = false;
    this._tlHeight = TIMELINE_DEFAULT_H;
    this._resizing = false;
    this._selectedClip = null;
  }

  mount() {
    injectStyles();
    this._el.innerHTML = buildHTML();

    // Initialize preview engine
    const canvas = this._el.querySelector('#pm-preview');
    this._previewEngine = new PreviewEngine({ canvas, storage: this._storage });
    this._previewEngine.init();
    this._previewEngine.addEventListener('preview:tick', (e) => {
      const t = e.detail.time;
      this._currentTime = t;
      this._updateTimecode(t);
      this._timeline?.seekTo(t);
    });
    this._previewEngine.addEventListener('preview:ended', () => {
      this._isPlaying = false;
      this._toolbar?.setPlayState(false);
      this._audioEngine?.stop();
      this._currentTime = 0;
      this._updateTimecode(0);
      this._timeline?.seekTo(0);
    });

    // Initialize audio engine
    this._audioEngine = new AudioEngine({ storage: this._storage });
    this._audioEngine.init();

    // Bind the resize handle for timeline height
    this._bindTlResize();

    // Mount child panels
    this._toolbar = new Toolbar(this._el.querySelector('#pm-toolbar'), {
      pm: this._pm, history: this._history,
      onAddTrack:   (type) => this._addTrack(type),
      onUndo:       () => this._history.undo(),
      onRedo:       () => this._history.redo(),
      onNewProject: () => this._showNewProjectDialog(),
      onOpenProject: () => this._showOpenProjectDialog(),
      onSaveProject: () => this._pm.saveProject(),
      onZoomIn:     () => this._timeline?.zoomIn(),
      onZoomOut:    () => this._timeline?.zoomOut(),
      onTogglePlay: () => this._togglePlay(),
      onToolChange: (tool) => this._timeline?.setTool(tool),
      onExport:     () => this._showExportDialog(),
    });

    this._library = new MediaLibrary(this._el.querySelector('#pm-media-library'), {
      pm: this._pm, history: this._history, storage: this._storage,
      onProjectChanged: () => this._timeline?.setProject(this._pm.project),
    });

    this._timeline = new Timeline(this._el.querySelector('#pm-timeline'), {
      pm: this._pm, history: this._history,
      onSeek: (t) => this._onSeek(t),
      onClipSelect: (clip) => this._onClipSelect(clip),
      onTrackSelect: (track) => this._inspector?.showTrack(track),
    });

    this._inspector = new Inspector(this._el.querySelector('#pm-inspector'), {
      pm: this._pm, history: this._history,
      storage: this._storage,
      getCurrentTime: () => this._currentTime,
    });

    // Wire project manager events
    this._pm.addEventListener('project:opened', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:recovered', (e) => this._onProjectOpened(e.detail));
    this._pm.addEventListener('project:closed', () => this._onProjectClosed());
    this._pm.addEventListener('project:saved', () => {
      this._setUnsavedIndicator(false);
      this._setSaveStatus('Saved');
    });
    this._pm.addEventListener('project:autosaved', () => {
      this._setUnsavedIndicator(false);
      this._setSaveStatus('Auto-saved');
    });
    this._pm.addEventListener('project:dirty', () => {
      this._setUnsavedIndicator(true);
      this._setSaveStatus('Unsaved changes');
      this._timeline?.setProject(this._pm.project);
    });

    // Wire history events
    this._history.addEventListener('history:change', (e) => {
      const { canUndo, canRedo, undoLabel, redoLabel } = e.detail;
      this._toolbar?.updateHistory({ canUndo, canRedo, undoLabel, redoLabel });
    });

    // Keyboard shortcuts
    this._bindKeyboard();

    // Transport buttons
    this._bindTransport();

    // Project name rename on double-click
    this._el.querySelector('#pm-project-name')?.addEventListener('dblclick', () => this._editProjectName());

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
    this._history.clear();
    this._hideStartScreen();
    this._currentTime = 0;
    this._updateTimecode(0);
    this._setSaveStatus('');
    this._library?.setProject(project);
    this._timeline?.setProject(project);
    this._inspector?.clear();
    this._toolbar?.setProject(project);
    const nameEl = this._el.querySelector('#pm-project-name');
    if (nameEl) { nameEl.textContent = project.name ?? 'Untitled'; nameEl.title = 'Double-click to rename'; }

    // Sync preview engine and canvas aspect ratio to project settings
    this._previewEngine?.setProject(project);
    this._audioEngine?.setProject(project);
    const { width, height } = project.canvas;
    const wrap = this._el.querySelector('.pm-canvas-wrap');
    if (wrap) wrap.style.aspectRatio = `${width} / ${height}`;
  }

  _onProjectClosed() {
    this._history.clear();
    this._stop();
    this._previewEngine?.setProject(null);
    this._audioEngine?.setProject(null);
    this._showStartScreen();
    const nameEl = this._el.querySelector('#pm-project-name');
    if (nameEl) { nameEl.textContent = ''; nameEl.title = ''; }
    this._setUnsavedIndicator(false);
    this._setSaveStatus('No project open');
  }

  // ─── Playback ────────────────────────────────────────────────────────────────

  _onSeek(time) {
    this._currentTime = time;
    this._updateTimecode(time);
    this._el.dispatchEvent(new CustomEvent('pm:seek', { detail: { time }, bubbles: true }));
    this._previewEngine?.seekTo(time); // async render, fire-and-forget
    // During playback, restart audio from the new position
    if (this._isPlaying) {
      this._audioEngine?.stop();
      this._audioEngine?.play(time).catch(() => {});
    }
  }

  _togglePlay() {
    this._isPlaying ? this._stop() : this._play();
  }

  _play() {
    if (this._isPlaying || !this._pm.project) return;
    this._isPlaying = true;
    this._toolbar?.setPlayState(true);
    this._previewEngine?.play(this._currentTime);
    this._audioEngine?.play(this._currentTime).catch(() => {});
  }

  _stop() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    this._previewEngine?.stop();
    this._audioEngine?.stop();
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
    this._storage.listProjects().then(async (list) => {
      if (!list.length) {
        this._showInfoDialog('No saved projects', 'No projects found. Create a new one to get started.');
        return;
      }
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'open-proj-title');
      const rows = list
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .map((p) => `
          <div class="pm-proj-row" data-id="${escHtml(p.id)}">
            <div class="pm-proj-info" tabindex="0" role="button" data-action="open"
                 aria-label="Open ${escHtml(p.name ?? 'Untitled')}">
              <span class="pm-proj-name">${escHtml(p.name ?? 'Untitled')}</span>
              <span class="pm-proj-date">${formatDate(p.updatedAt ?? p._savedAt)}</span>
            </div>
            <button class="pm-proj-del" data-action="delete"
                    aria-label="Delete ${escHtml(p.name ?? 'Untitled')}" title="Delete project">✕</button>
          </div>
        `).join('');
      dialog.innerHTML = `
        <h2 id="open-proj-title" style="margin:0 0 14px;font-size:1rem">Open Project</h2>
        <div id="op-list" style="max-height:300px;overflow-y:auto">${rows}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:16px">
          <button class="btn-ghost" id="op-cancel">Cancel</button>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.showModal();

      dialog.querySelector('#op-cancel').addEventListener('click', () => { dialog.close(); dialog.remove(); });

      dialog.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('[data-action="delete"]');
        if (delBtn) {
          const row = delBtn.closest('.pm-proj-row');
          if (!row) return;
          const name = row.querySelector('.pm-proj-name')?.textContent ?? 'project';
          const confirmed = await confirmDelete(name);
          if (!confirmed) return;
          await this._pm.deleteProject(row.dataset.id);
          row.remove();
          if (!dialog.querySelector('.pm-proj-row')) {
            dialog.close(); dialog.remove();
            this._showInfoDialog('No saved projects', 'All projects deleted. Create a new one to get started.');
          }
          return;
        }
        const info = e.target.closest('[data-action="open"]');
        if (info) {
          const row = info.closest('.pm-proj-row');
          if (!row) return;
          dialog.close(); dialog.remove();
          await this._pm.openProject(row.dataset.id);
        }
      });

      dialog.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { dialog.close(); dialog.remove(); }
        if (e.key === 'Enter' && document.activeElement.dataset?.action === 'open') {
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

  _showExportDialog() {
    if (!this._pm.project) return;
    const project = this._pm.project;
    const w = project.canvas.width, h = project.canvas.height, f = project.canvas.fps ?? 30;

    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ex-title');
    dialog.innerHTML = `
      <h2 id="ex-title" style="margin:0 0 16px;font-size:1rem">Export Video</h2>

      <label class="pm-dlg-label">Resolution
        <select id="ex-res" class="pm-input" style="width:100%">
          <option value="match">Match project — ${w}×${h}</option>
          <option value="1920x1080">1920×1080 (1080p)</option>
          <option value="3840x2160">3840×2160 (4K)</option>
          <option value="1280x720">1280×720 (720p)</option>
        </select>
      </label>

      <label class="pm-dlg-label" style="margin-top:10px">Frame Rate
        <select id="ex-fps" class="pm-input" style="width:100%">
          <option value="match">Match project — ${f} fps</option>
          <option value="24">24 fps (cinematic)</option>
          <option value="30">30 fps</option>
          <option value="60">60 fps</option>
        </select>
      </label>

      <label class="pm-dlg-label" style="margin-top:10px">Video Quality
        <select id="ex-vbr" class="pm-input" style="width:100%">
          <option value="4000000">4 Mbps — web / social</option>
          <option value="8000000" selected>8 Mbps — standard</option>
          <option value="16000000">16 Mbps — high</option>
          <option value="32000000">32 Mbps — ultra</option>
        </select>
      </label>

      <label class="pm-dlg-label" style="margin-top:10px;flex-direction:row;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="ex-audio" checked> Include audio tracks
      </label>

      <div id="ex-progress-wrap" style="display:none;margin-top:16px">
        <div style="background:var(--bg-base);border-radius:6px;overflow:hidden;height:6px">
          <div id="ex-pbar" style="height:100%;width:0%;background:var(--accent-peach);transition:width .15s ease"></div>
        </div>
        <div id="ex-plabel" style="font-family:var(--font-mono);font-size:0.7rem;color:var(--text-muted);margin-top:6px">Preparing…</div>
      </div>

      <div id="ex-error" style="display:none;background:#2d1010;border:1px solid #ff5555;border-radius:6px;padding:8px 12px;font-size:0.8rem;color:#ff8080;margin-top:12px"></div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px">
        <button class="btn-ghost" id="ex-cancel">Cancel</button>
        <button class="btn-primary" id="ex-start" autofocus>Export MP4</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();

    let exportEngine = null;
    const startBtn    = dialog.querySelector('#ex-start');
    const cancelBtn   = dialog.querySelector('#ex-cancel');
    const progressWrap = dialog.querySelector('#ex-progress-wrap');
    const pbar        = dialog.querySelector('#ex-pbar');
    const plabel      = dialog.querySelector('#ex-plabel');
    const errorBox    = dialog.querySelector('#ex-error');

    const closeDialog = () => { dialog.close(); dialog.remove(); };

    cancelBtn.addEventListener('click', () => { exportEngine?.abort(); closeDialog(); });

    startBtn.addEventListener('click', async () => {
      // Parse settings
      const resVal  = dialog.querySelector('#ex-res').value;
      const fpsVal  = dialog.querySelector('#ex-fps').value;
      const vbrVal  = parseInt(dialog.querySelector('#ex-vbr').value, 10);
      const inclAud = dialog.querySelector('#ex-audio').checked;

      let width = w, height = h;
      if (resVal !== 'match') [width, height] = resVal.split('x').map(Number);
      const fps = fpsVal === 'match' ? f : parseInt(fpsVal, 10);

      startBtn.disabled = true;
      startBtn.textContent = 'Exporting…';
      progressWrap.style.display = 'block';
      errorBox.style.display = 'none';

      const t0 = Date.now();
      try {
        const { ExportEngine } = await import('../../engine/export-engine.js');
        exportEngine = new ExportEngine({ storage: this._storage });

        const buffer = await exportEngine.export(
          project,
          { width, height, fps, videoBitrate: vbrVal, includeAudio: inclAud },
          (progress) => {
            pbar.style.width = `${Math.round(progress * 100)}%`;
            const elapsed = (Date.now() - t0) / 1000;
            const eta     = progress > 0.05 ? (elapsed / progress - elapsed) : null;
            plabel.textContent = `${Math.round(progress * 100)}% — ${formatElapsed(elapsed)}${eta ? ` · ~${formatElapsed(eta)} remaining` : ''}`;
          },
        );

        // Download the resulting MP4
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `${(project.name ?? 'export').replace(/[^a-z0-9_-]/gi, '_')}.mp4`;
        a.click();
        URL.revokeObjectURL(url);
        closeDialog();

      } catch (err) {
        if (err.message === 'Export cancelled') { closeDialog(); return; }
        errorBox.textContent = `Export failed: ${err.message}`;
        errorBox.style.display = 'block';
        startBtn.disabled = false;
        startBtn.textContent = 'Retry Export';
      }
    });

    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { exportEngine?.abort(); closeDialog(); }
    });
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

  _setUnsavedIndicator(dirty) {
    this._el.querySelector('#pm-project-name')?.classList.toggle('pm-unsaved', dirty);
  }

  _editProjectName() {
    const nameEl = this._el.querySelector('#pm-project-name');
    if (!nameEl || !this._pm.project || nameEl.style.display === 'none') return;
    const current = this._pm.project.name ?? 'Untitled';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'pm-name-edit';
    nameEl.style.display = 'none';
    nameEl.after(input);
    input.focus();
    input.select();
    const commit = () => {
      const newName = input.value.trim() || current;
      input.remove();
      nameEl.style.display = '';
      if (newName !== current) {
        nameEl.textContent = newName;
        this._pm.mutate((proj) => { proj.name = newName; });
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = current; commit(); }
    });
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
      const total = this._pm.project ? Math.max(totalDuration(this._pm.project), 10) : 0;
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
      if (ctrl && e.key === 'z') { e.preventDefault(); this._history.undo(); }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); this._history.redo(); }
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
        const total = this._pm.project ? Math.max(totalDuration(this._pm.project), 10) : 60;
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
    .pm-project-name:not(:empty) { cursor:text; }
    .pm-project-name.pm-unsaved::after { content:' *'; color:var(--accent-peach); }
    .pm-name-edit { background:var(--bg-base); border:1px solid var(--accent-purple);
      color:var(--text-primary); border-radius:4px; padding:2px 6px;
      font-size:0.8rem; font-family:var(--font-mono); outline:none; max-width:180px; }
    .pm-proj-row { display:flex; align-items:center; gap:4px; border-radius:6px; padding:2px 4px; }
    .pm-proj-info { flex:1; display:flex; align-items:center; justify-content:space-between;
      padding:8px 10px; border-radius:4px; cursor:pointer; gap:12px; }
    .pm-proj-info:hover, .pm-proj-info:focus { background:var(--bg-hover); outline:none; }
    .pm-proj-name { font-size:0.85rem; flex:1; min-width:0; white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .pm-proj-date { font-family:var(--font-mono); font-size:0.7rem; color:var(--text-dim); flex-shrink:0; }
    .pm-proj-del { background:transparent; border:none; color:var(--text-dim); cursor:pointer;
      width:24px; height:24px; border-radius:4px; font-size:0.75rem; flex-shrink:0;
      display:flex; align-items:center; justify-content:center; opacity:0; }
    .pm-proj-row:hover .pm-proj-del { opacity:1; }
    .pm-proj-del:hover { color:var(--accent-err); background:rgba(255,85,85,.12); }
    .pm-proj-del:focus-visible { opacity:1; outline:2px solid var(--accent-purple); outline-offset:2px; }
    .btn-danger { background:var(--accent-err); border:none; color:#fff; border-radius:var(--radius,6px);
      padding:8px 20px; font-size:0.85rem; font-weight:700; cursor:pointer; font-family:var(--font-ui); }
    .btn-danger:hover { background:#cc4444; }
    .btn-danger:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
  `;
  document.head.appendChild(s);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatTimecode(secs, fps = 30) {
  const s = Math.floor(secs);
  const f = Math.floor((secs - s) * fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}:${pad(f)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function formatElapsed(secs) {
  if (!isFinite(secs) || secs < 0) return '0s';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function confirmDelete(name) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML = `
      <p style="margin:0 0 16px">Delete <strong>${escHtml(name)}</strong>?<br>
        <span style="font-size:0.8rem;color:var(--text-muted)">This cannot be undone.</span></p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn-ghost" id="cd-keep" autofocus>Keep</button>
        <button class="btn-danger" id="cd-del">Delete</button>
      </div>`;
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('#cd-keep').addEventListener('click', () => { d.close(); d.remove(); resolve(false); });
    d.querySelector('#cd-del').addEventListener('click', () => { d.close(); d.remove(); resolve(true); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { d.close(); d.remove(); resolve(false); } });
  });
}
