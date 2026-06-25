/**
 * history.js — Undo/redo command stack
 *
 * Command pattern: each operation is { label, do(), undo() }.
 * Complex ops may snapshot the full EDL JSON as a fallback.
 *
 * Emits events via a shared EventTarget so UI can update its own state.
 */

const MAX_STACK_SIZE = 100;

export class HistoryManager extends EventTarget {
  constructor(projectManager) {
    super();
    this._pm = projectManager;
    this._past = [];    // commands that have been done
    this._future = [];  // commands that have been undone (for redo)
  }

  // ─── Execute a command ────────────────────────────────────────────────────

  /**
   * Execute a command and push it onto the undo stack.
   * @param {{ label: string, execute: () => any, undo: () => any }} cmd
   */
  execute(cmd) {
    cmd.execute();
    this._past.push(cmd);
    this._future = []; // clear redo stack on new action
    if (this._past.length > MAX_STACK_SIZE) this._past.shift();
    this._pm.markDirty();
    this._emit();
  }

  /**
   * Execute a command that returns a Promise (async mutation).
   */
  async executeAsync(cmd) {
    await cmd.execute();
    this._past.push(cmd);
    this._future = [];
    if (this._past.length > MAX_STACK_SIZE) this._past.shift();
    this._pm.markDirty();
    this._emit();
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────

  undo() {
    if (!this.canUndo) return;
    const cmd = this._past.pop();
    cmd.undo();
    this._future.push(cmd);
    this._pm.markDirty();
    this._emit();
  }

  redo() {
    if (!this.canRedo) return;
    const cmd = this._future.pop();
    cmd.execute();
    this._past.push(cmd);
    this._pm.markDirty();
    this._emit();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get canUndo() { return this._past.length > 0; }
  get canRedo() { return this._future.length > 0; }
  get undoLabel() { return this._past.at(-1)?.label ?? null; }
  get redoLabel() { return this._future.at(-1)?.label ?? null; }

  get stack() {
    return {
      past: this._past.map((c) => c.label),
      future: this._future.map((c) => c.label),
    };
  }

  // ─── EDL snapshot helper ──────────────────────────────────────────────────

  /**
   * Returns a command that snapshots the current EDL and restores it on undo.
   * Use for operations that are hard to express as inverse functions.
   */
  snapshotCommand(label, mutateFn) {
    const snapshot = JSON.parse(JSON.stringify(this._pm.project));
    return {
      label,
      execute: () => mutateFn(this._pm.project),
      undo: () => {
        // Replace project internals (mutate in-place, preserve reference)
        const proj = this._pm.project;
        Object.keys(proj).forEach((k) => delete proj[k]);
        Object.assign(proj, JSON.parse(JSON.stringify(snapshot)));
      },
    };
  }

  // ─── Clear ────────────────────────────────────────────────────────────────

  /** Clear the entire history (e.g. on project close). */
  clear() {
    this._past = [];
    this._future = [];
    this._emit();
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _emit() {
    this.dispatchEvent(new CustomEvent('history:change', {
      detail: {
        canUndo: this.canUndo,
        canRedo: this.canRedo,
        undoLabel: this.undoLabel,
        redoLabel: this.redoLabel,
      },
    }));
  }
}
