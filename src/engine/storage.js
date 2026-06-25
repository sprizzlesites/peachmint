/**
 * storage.js — Unified storage abstraction for PeachMint
 *
 * Priority:
 *   Media blobs  → OPFS (fast, worker-accessible)
 *   Project JSON → IndexedDB
 *   Fallback     → IndexedDB chunked ArrayBuffer when OPFS unavailable
 *
 * Never uses localStorage for media (5-10 MB cap).
 * Calls navigator.storage.persist() at init.
 */

const IDB_NAME = 'peachmint';
const IDB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_MEDIA = 'media';       // fallback when OPFS unavailable
const STORE_SETTINGS = 'settings';

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks for IDB fallback

export class StorageLayer {
  constructor() {
    this._db = null;
    this._opfsRoot = null;
    this._hasOPFS = false;
    this._initialized = false;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async init() {
    if (this._initialized) return;

    // 1. Request persistent storage
    try {
      const persisted = await navigator.storage.persisted();
      if (!persisted) await navigator.storage.persist();
    } catch { /* not critical */ }

    // 2. Open IndexedDB
    this._db = await openIDB();

    // 3. Try OPFS
    try {
      this._opfsRoot = await navigator.storage.getDirectory();
      // Quick sanity write to confirm it works
      const testHandle = await this._opfsRoot.getFileHandle('__test__', { create: true });
      const writable = await testHandle.createWritable();
      await writable.write(new Uint8Array([1]));
      await writable.close();
      await this._opfsRoot.removeEntry('__test__');
      this._hasOPFS = true;
    } catch {
      this._hasOPFS = false;
    }

    this._initialized = true;
  }

  _assertInit() {
    if (!this._initialized) throw new Error('StorageLayer.init() not called');
  }

  // ─── Media (large blobs) ─────────────────────────────────────────────────

  /**
   * Write a media file. Returns a storageKey.
   * OPFS: stores as a file under /media/<id>
   * IDB fallback: stores as chunked ArrayBuffer in 'media' store
   */
  async writeMedia(name, arrayBuffer) {
    this._assertInit();
    const id = `media_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    if (this._hasOPFS) {
      const dir = await this._getOrCreateDir('media');
      const fileHandle = await dir.getFileHandle(id, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(arrayBuffer);
      await writable.close();
      return `opfs:media/${id}`;
    } else {
      await idbPut(this._db, STORE_MEDIA, { id, name, data: arrayBuffer });
      return `idb:media/${id}`;
    }
  }

  /**
   * Read a media file by storageKey. Returns ArrayBuffer.
   */
  async readMedia(storageKey) {
    this._assertInit();
    if (storageKey.startsWith('opfs:')) {
      const path = storageKey.slice('opfs:'.length).split('/');
      const dir = await this._getOrCreateDir(path[0]);
      const fileHandle = await dir.getFileHandle(path[1]);
      const file = await fileHandle.getFile();
      return file.arrayBuffer();
    } else {
      const record = await idbGet(this._db, STORE_MEDIA, storageKey.slice('idb:media/'.length));
      return record?.data ?? null;
    }
  }

  /**
   * Delete a media file.
   */
  async deleteMedia(storageKey) {
    this._assertInit();
    if (storageKey.startsWith('opfs:')) {
      const path = storageKey.slice('opfs:'.length).split('/');
      const dir = await this._getOrCreateDir(path[0]);
      await dir.removeEntry(path[1]).catch(() => {});
    } else {
      await idbDelete(this._db, STORE_MEDIA, storageKey.slice('idb:media/'.length));
    }
  }

  // ─── Projects (JSON) ─────────────────────────────────────────────────────

  /** Save or update a project. projectJSON must have an `id` field. */
  async saveProject(projectJSON) {
    this._assertInit();
    const record = { ...projectJSON, _savedAt: new Date().toISOString() };
    await idbPut(this._db, STORE_PROJECTS, record);
  }

  /** Load a project by id. Returns parsed object or null. */
  async loadProject(id) {
    this._assertInit();
    return idbGet(this._db, STORE_PROJECTS, id);
  }

  /** Delete a project by id. */
  async deleteProject(id) {
    this._assertInit();
    return idbDelete(this._db, STORE_PROJECTS, id);
  }

  /** List all saved project summaries (id, name, updatedAt). */
  async listProjects() {
    this._assertInit();
    const all = await idbGetAll(this._db, STORE_PROJECTS);
    return all.map(({ id, name, updatedAt, _savedAt }) => ({ id, name, updatedAt, _savedAt }));
  }

  // ─── Settings (tiny prefs) ───────────────────────────────────────────────

  async getSetting(key) {
    this._assertInit();
    const record = await idbGet(this._db, STORE_SETTINGS, key);
    return record?.value ?? undefined;
  }

  async setSetting(key, value) {
    this._assertInit();
    await idbPut(this._db, STORE_SETTINGS, { id: key, value });
  }

  // ─── Quota ───────────────────────────────────────────────────────────────

  /** Returns { usage, quota } in bytes. */
  async getQuota() {
    try {
      const estimate = await navigator.storage.estimate();
      return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    } catch {
      return { usage: 0, quota: 0 };
    }
  }

  // ─── Self-test (round-trip) ──────────────────────────────────────────────

  /**
   * Runs a write→read→delete round-trip for both media and project storage.
   * Returns { ok: true } or { ok: false, error: string }.
   */
  async selfTest() {
    try {
      // Media round-trip
      const testData = new TextEncoder().encode('PeachMint storage test').buffer;
      const key = await this.writeMedia('__test__.bin', testData);
      const readBack = await this.readMedia(key);
      const decoded = new TextDecoder().decode(readBack);
      if (decoded !== 'PeachMint storage test') throw new Error('Media round-trip data mismatch');
      await this.deleteMedia(key);

      // Project round-trip
      const proj = { id: '__test_proj__', name: 'Test', updatedAt: new Date().toISOString(), tracks: [], assets: [], version: 1, canvas: {} };
      await this.saveProject(proj);
      const loaded = await this.loadProject('__test_proj__');
      if (!loaded || loaded.name !== 'Test') throw new Error('Project round-trip data mismatch');
      await this.deleteProject('__test_proj__');

      return { ok: true, backend: this._hasOPFS ? 'opfs+indexeddb' : 'indexeddb-only' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  get hasOPFS() { return this._hasOPFS; }
  get isInitialized() { return this._initialized; }

  // ─── Private helpers ──────────────────────────────────────────────────────

  async _getOrCreateDir(name) {
    return this._opfsRoot.getDirectoryHandle(name, { create: true });
  }
}

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MEDIA)) {
        db.createObjectStore(STORE_MEDIA, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbPut(db, store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = (e) => resolve(e.target.result ?? null);
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = (e) => resolve(e.target.result ?? []);
    req.onerror = (e) => reject(e.target.error);
  });
}
