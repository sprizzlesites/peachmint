/**
 * toolbar.js — Top toolbar for the desktop shell
 *
 * Renders into #pm-toolbar (inside the topbar).
 * Exposes callbacks for all actions; does not import engine code directly.
 */

export class Toolbar {
  constructor(container, { pm, history, onAddTrack, onUndo, onRedo,
    onNewProject, onOpenProject, onSaveProject,
    onZoomIn, onZoomOut, onTogglePlay, onToolChange, onExport }) {
    this._el = container;
    this._pm = pm;
    this._history = history;
    this._cbs = { onAddTrack, onUndo, onRedo, onNewProject, onOpenProject,
      onSaveProject, onZoomIn, onZoomOut, onTogglePlay, onToolChange, onExport };
    this._activeTool = 'pointer';
    this._isPlaying = false;
    this._mount();
  }

  // ─── Mount ───────────────────────────────────────────────────────────────────

  _mount() {
    injectStyles();
    this._el.innerHTML = `
      <div class="pm-tb" role="toolbar" aria-label="Editor toolbar">

        <!-- File group -->
        <div class="pm-tb-group" role="group" aria-label="File">
          <button class="pm-tb-btn" id="tb-new" title="New project (Ctrl+N)" aria-label="New project">New</button>
          <button class="pm-tb-btn" id="tb-open" title="Open project (Ctrl+O)" aria-label="Open project">Open</button>
          <button class="pm-tb-btn" id="tb-save" title="Save project (Ctrl+S)" aria-label="Save project">Save</button>
        </div>
        <div class="pm-tb-sep" role="separator"></div>

        <!-- Undo/Redo -->
        <div class="pm-tb-group" role="group" aria-label="History">
          <button class="pm-tb-btn" id="tb-undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
            ↩ <span id="tb-undo-label" class="pm-tb-sub"></span>
          </button>
          <button class="pm-tb-btn" id="tb-redo" title="Redo (Ctrl+Y)" aria-label="Redo" disabled>
            ↪ <span id="tb-redo-label" class="pm-tb-sub"></span>
          </button>
        </div>
        <div class="pm-tb-sep" role="separator"></div>

        <!-- Tool selector -->
        <div class="pm-tb-group pm-tb-tools" role="group" aria-label="Edit tools">
          <button class="pm-tb-tool active" id="tb-tool-pointer" data-tool="pointer"
                  title="Pointer tool (V)" aria-label="Pointer tool" aria-pressed="true">▼</button>
          <button class="pm-tb-tool" id="tb-tool-razor" data-tool="razor"
                  title="Razor / split tool (C)" aria-label="Razor tool" aria-pressed="false">✂</button>
          <button class="pm-tb-tool" id="tb-tool-hand" data-tool="hand"
                  title="Hand / scroll tool (H)" aria-label="Hand tool" aria-pressed="false">✋</button>
          <button class="pm-tb-tool" id="tb-tool-draw" data-tool="draw"
                  title="Draw tool (D)" aria-label="Draw tool" aria-pressed="false">✏</button>
        </div>
        <div class="pm-tb-sep" role="separator"></div>

        <!-- Zoom -->
        <div class="pm-tb-group" role="group" aria-label="Zoom">
          <button class="pm-tb-btn" id="tb-zoom-out" title="Zoom out (-)" aria-label="Zoom out timeline">−</button>
          <button class="pm-tb-btn" id="tb-zoom-in" title="Zoom in (+)" aria-label="Zoom in timeline">+</button>
        </div>
        <div class="pm-tb-sep" role="separator"></div>

        <!-- Export -->
        <div class="pm-tb-group" role="group" aria-label="Export">
          <button class="pm-tb-btn pm-tb-export" id="tb-export" title="Export to MP4 (WebCodecs)" aria-label="Export video" disabled>
            ⬇ Export
          </button>
        </div>
      </div>
    `;

    this._bind();
  }

  _bind() {
    const { _el: el, _cbs: cbs } = this;
    el.querySelector('#tb-new')?.addEventListener('click', () => cbs.onNewProject?.());
    el.querySelector('#tb-open')?.addEventListener('click', () => cbs.onOpenProject?.());
    el.querySelector('#tb-save')?.addEventListener('click', () => cbs.onSaveProject?.());
    el.querySelector('#tb-undo')?.addEventListener('click', () => cbs.onUndo?.());
    el.querySelector('#tb-redo')?.addEventListener('click', () => cbs.onRedo?.());
    el.querySelector('#tb-zoom-in')?.addEventListener('click', () => cbs.onZoomIn?.());
    el.querySelector('#tb-zoom-out')?.addEventListener('click', () => cbs.onZoomOut?.());
    el.querySelector('#tb-export')?.addEventListener('click', () => cbs.onExport?.());

    el.querySelectorAll('.pm-tb-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        this._setActiveTool(tool);
        cbs.onToolChange?.(tool);
      });
    });

    // Keyboard shortcuts for tools
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === 'v' || e.key === 'V') { this._setActiveTool('pointer'); cbs.onToolChange?.('pointer'); }
      if (e.key === 'c' || e.key === 'C') { this._setActiveTool('razor'); cbs.onToolChange?.('razor'); }
      if (e.key === 'h' || e.key === 'H') { this._setActiveTool('hand'); cbs.onToolChange?.('hand'); }
      if (e.key === 'd' || e.key === 'D') { this._setActiveTool('draw'); cbs.onToolChange?.('draw'); }
    });
  }

  // ─── Public update methods ────────────────────────────────────────────────────

  setProject(project) {
    const hasPrj = !!project;
    this._el.querySelector('#tb-save')?.toggleAttribute('disabled', !hasPrj);
    this._el.querySelector('#tb-zoom-in')?.toggleAttribute('disabled', !hasPrj);
    this._el.querySelector('#tb-zoom-out')?.toggleAttribute('disabled', !hasPrj);
    this._el.querySelector('#tb-export')?.toggleAttribute('disabled', !hasPrj);
  }

  updateHistory({ canUndo, canRedo, undoLabel, redoLabel }) {
    const undoBtn = this._el.querySelector('#tb-undo');
    const redoBtn = this._el.querySelector('#tb-redo');
    if (undoBtn) undoBtn.disabled = !canUndo;
    if (redoBtn) redoBtn.disabled = !canRedo;
    const ul = this._el.querySelector('#tb-undo-label');
    const rl = this._el.querySelector('#tb-redo-label');
    if (ul) ul.textContent = canUndo && undoLabel ? truncate(undoLabel, 14) : '';
    if (rl) rl.textContent = canRedo && redoLabel ? truncate(redoLabel, 14) : '';
  }

  setPlayState(playing) {
    this._isPlaying = playing;
    const btn = this._el.querySelector('#pm-play-btn');
    if (!btn) return;
    btn.textContent = playing ? '⏸' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    btn.classList.toggle('playing', playing);
  }

  updateTimecode(time, fps) {
    // Timecode is shown in the shell's transport bar, not toolbar
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  _setActiveTool(tool) {
    this._activeTool = tool;
    this._el.querySelectorAll('.pm-tb-tool').forEach((btn) => {
      const active = btn.dataset.tool === tool;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const s = document.createElement('style');
  s.textContent = `
    .pm-tb { display:flex; align-items:center; gap:2px; height:100%; flex:1; }
    .pm-tb-group { display:flex; align-items:center; gap:1px; }
    .pm-tb-sep { width:1px; height:18px; background:var(--border); margin:0 4px; flex-shrink:0; }
    .pm-tb-btn { background:transparent; border:none; color:var(--text-muted);
      padding:3px 8px; border-radius:4px; font-size:0.78rem; cursor:pointer; height:28px;
      display:flex; align-items:center; gap:4px; white-space:nowrap; font-family:var(--font-ui); }
    .pm-tb-btn:hover:not(:disabled) { background:var(--bg-hover); color:var(--text-primary); }
    .pm-tb-btn:disabled { opacity:0.35; cursor:default; }
    .pm-tb-btn:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-tb-sub { font-size:0.65rem; color:var(--text-dim); max-width:80px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .pm-tb-tools { gap:2px; }
    .pm-tb-tool { background:transparent; border:1px solid transparent; color:var(--text-muted);
      width:28px; height:28px; border-radius:4px; font-size:0.85rem; cursor:pointer;
      display:flex; align-items:center; justify-content:center; }
    .pm-tb-tool:hover { background:var(--bg-hover); color:var(--text-primary); }
    .pm-tb-tool.active { background:var(--bg-hover); border-color:var(--accent-purple); color:var(--accent-purple); }
    .pm-tb-tool:focus-visible { outline:2px solid var(--accent-purple); outline-offset:2px; }
    .pm-tb-export { background:var(--accent-peach); color:#181820 !important; font-weight:700;
      border-radius:5px; padding:3px 12px; }
    .pm-tb-export:hover:not(:disabled) { background:#ffaa88 !important; }
    .pm-tb-export:disabled { background:var(--border) !important; color:var(--text-dim) !important; }
  `;
  document.head.appendChild(s);
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
