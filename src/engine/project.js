/**
 * project.js — Project lifecycle management
 *
 * Handles: new project, open, save, autosave, crash recovery, schema migration.
 * Depends on: storage.js, edl.js
 * Has ZERO DOM dependencies — UI listens to the EventTarget events it emits.
 */

import { createProject, validateProject } from './edl.js';
import { StorageLayer } from './storage.js';

const CURRENT_VERSION = 1;
const AUTOSAVE_INTERVAL_MS = 3000; // 3 s continuous autosave
const AUTOSAVE_ACTIVE_KEY = 'autosave_active_project';

export class ProjectManager extends EventTarget {
  constructor(storage) {
    super();
    if (!(storage instanceof StorageLayer)) throw new Error('ProjectManager requires a StorageLayer');
    this._storage = storage;
    this._project = null;
    this._dirty = false;
    this._autosaveTimer = null;
    this._saving = false;
  }

  // ─── Project Lifecycle ────────────────────────────────────────────────────

  /** Create and open a new blank project. */
  async newProject(opts = {}) {
    this._stopAutosave();
    const proj = createProject(opts);
    this._project = proj;
    this._dirty = true;
    await this._save(); // initial save
    this._startAutosave();
    this._emit('project:opened', proj);
    return proj;
  }

  /** Open an existing project by id. Throws if not found. */
  async openProject(id) {
    this._stopAutosave();
    const raw = await this._storage.loadProject(id);
    if (!raw) throw new Error(`Project ${id} not found`);
    const proj = await migrate(raw);
    validateProject(proj);
    this._project = proj;
    this._dirty = false;
    this._startAutosave();
    this._emit('project:opened', proj);
    return proj;
  }

  /** Explicitly save the current project. */
  async saveProject() {
    if (!this._project) return;
    await this._save();
    this._emit('project:saved', this._project);
  }

  /** Close the current project. Saves first if dirty. */
  async closeProject() {
    if (this._project && this._dirty) await this._save();
    this._stopAutosave();
    const prev = this._project;
    this._project = null;
    this._dirty = false;
    this._emit('project:closed', prev);
  }

  /** Delete a project from storage (must not be the currently open one). */
  async deleteProject(id) {
    if (this._project?.id === id) throw new Error('Cannot delete the currently open project');
    await this._storage.deleteProject(id);
    this._emit('project:deleted', { id });
  }

  /** Duplicate current project under a new name/id. Returns the copy. */
  async duplicateProject(name) {
    if (!this._project) throw new Error('No project open');
    const copy = JSON.parse(JSON.stringify(this._project));
    copy.id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    copy.name = name ?? `${this._project.name} copy`;
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    await this._storage.saveProject(copy);
    this._emit('project:duplicated', copy);
    return copy;
  }

  // ─── Crash Recovery ───────────────────────────────────────────────────────

  /**
   * Check for an unsaved crash state on app startup.
   * Returns the crashed project JSON if one exists, or null.
   * Call this before newProject/openProject.
   */
  async checkCrashRecovery() {
    const activeId = await this._storage.getSetting(AUTOSAVE_ACTIVE_KEY);
    if (!activeId) return null;
    const raw = await this._storage.loadProject(activeId);
    if (!raw) return null;
    return raw;
  }

  /**
   * Recover from a crash: resume editing the crashed project.
   */
  async recoverProject(crashedProject) {
    this._stopAutosave();
    const proj = await migrate(crashedProject);
    validateProject(proj);
    this._project = proj;
    this._dirty = false;
    this._startAutosave();
    this._emit('project:recovered', proj);
    return proj;
  }

  // ─── Project Mutation Helpers ─────────────────────────────────────────────

  /** Mark the project as dirty (unsaved changes). Called by all mutation ops. */
  markDirty() {
    this._dirty = true;
    this._emit('project:dirty');
  }

  /** Apply a plain mutation function to the current project EDL. */
  mutate(fn) {
    if (!this._project) throw new Error('No project open');
    fn(this._project);
    this.markDirty();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  get project() { return this._project; }
  get isDirty() { return this._dirty; }

  // ─── Private ─────────────────────────────────────────────────────────────

  async _save() {
    if (!this._project || this._saving) return;
    this._saving = true;
    try {
      await this._storage.saveProject(this._project);
      await this._storage.setSetting(AUTOSAVE_ACTIVE_KEY, this._project.id);
      this._dirty = false;
    } finally {
      this._saving = false;
    }
  }

  _startAutosave() {
    this._stopAutosave();
    this._autosaveTimer = setInterval(async () => {
      if (this._dirty) {
        await this._save();
        this._emit('project:autosaved', this._project);
      }
    }, AUTOSAVE_INTERVAL_MS);
  }

  _stopAutosave() {
    if (this._autosaveTimer) {
      clearInterval(this._autosaveTimer);
      this._autosaveTimer = null;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ─── Schema migrations ────────────────────────────────────────────────────────

/**
 * Migrate a raw saved project to the current EDL version.
 * Add migration cases here as the schema evolves.
 */
async function migrate(raw) {
  let proj = { ...raw };

  // v0 → v1: ensure canvas.aspectRatio exists
  if (!proj.version || proj.version < 1) {
    proj.version = 1;
    if (proj.canvas && !proj.canvas.aspectRatio) {
      proj.canvas.aspectRatio = proj.canvas.width / proj.canvas.height;
    }
  }

  // Future: v1 → v2: ...

  return proj;
}
