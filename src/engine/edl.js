/**
 * edl.js — Edit Decision List schema + factory helpers
 *
 * An EDL is the serializable project document. It holds no media bytes —
 * only references (asset IDs) to media stored in OPFS/IndexedDB.
 *
 * Schema version: 1
 * Migrations: project.js handles version bumps.
 */

const EDL_VERSION = 1;

// ─── ID helpers ────────────────────────────────────────────────────────────

let _idCounter = 0;
export function newId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now()}_${rand}_${++_idCounter}`;
}

// ─── Factory functions ──────────────────────────────────────────────────────

/** Create a blank project EDL. */
export function createProject({ name = 'Untitled Project', width = 1920, height = 1080, fps = 30 } = {}) {
  const now = new Date().toISOString();
  return {
    id: newId('proj'),
    name,
    version: EDL_VERSION,
    createdAt: now,
    updatedAt: now,
    canvas: { width, height, fps, aspectRatio: width / height },
    tracks: [],
    assets: [],
  };
}

/** Create a track. zIndex controls render order (lower = behind). */
export function createTrack({ type = 'video', name, zIndex } = {}) {
  return {
    id: newId('track'),
    type, // 'video' | 'audio' | 'overlay'
    name: name ?? defaultTrackName(type),
    muted: false,
    solo: false,
    locked: false,
    zIndex: zIndex ?? 0,
    clips: [],
  };
}

/** Create a clip referencing an asset. All time values are in seconds. */
export function createClip({
  assetId,
  startTime = 0,
  duration = 0,
  trimIn = 0,
  trimOut = 0,
  speed = 1.0,
} = {}) {
  return {
    id: newId('clip'),
    assetId,
    startTime,
    duration,
    trimIn,
    trimOut,
    speed,
    properties: defaultClipProperties(),
    keyframes: {},
  };
}

/** Create an asset record (no media bytes; bytes live in storage). */
export function createAsset({ name, type, mimeType, width, height, duration, storageKey }) {
  return {
    id: newId('asset'),
    name,
    type,   // 'video' | 'audio' | 'image'
    mimeType,
    width,
    height,
    duration,
    storageKey, // key into StorageLayer (OPFS path or IDB key)
    proxyKey: null, // set after proxy generation
    createdAt: new Date().toISOString(),
  };
}

/** Create a keyframe. easing: 'linear' | 'ease' | 'hold' | 'bezier' */
export function createKeyframe({ time, value, easing = 'linear', handles = null }) {
  const kf = { time, value, easing };
  if (handles) kf.handles = handles; // bezier control points [cx1,cy1,cx2,cy2]
  return kf;
}

// ─── Mutation helpers ───────────────────────────────────────────────────────

/** Add a track to the project. Returns the new track. */
export function addTrack(project, trackOpts = {}) {
  const maxZ = project.tracks.reduce((m, t) => Math.max(m, t.zIndex), -1);
  const track = createTrack({ zIndex: maxZ + 1, ...trackOpts });
  project.tracks.push(track);
  touch(project);
  return track;
}

/** Remove a track by id. Returns removed track or null. */
export function removeTrack(project, trackId) {
  const idx = project.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) return null;
  const [removed] = project.tracks.splice(idx, 1);
  touch(project);
  return removed;
}

/** Add a clip to a track. Returns the clip. */
export function addClip(project, trackId, clipOpts = {}) {
  const track = getTrack(project, trackId);
  if (!track) throw new Error(`Track ${trackId} not found`);
  const clip = createClip(clipOpts);
  track.clips.push(clip);
  touch(project);
  return clip;
}

/** Remove a clip from its track. Returns removed clip or null. */
export function removeClip(project, clipId) {
  for (const track of project.tracks) {
    const idx = track.clips.findIndex((c) => c.id === clipId);
    if (idx !== -1) {
      const [removed] = track.clips.splice(idx, 1);
      touch(project);
      return removed;
    }
  }
  return null;
}

/** Register an asset in the project. Returns the asset. */
export function addAsset(project, assetOpts) {
  const asset = createAsset(assetOpts);
  project.assets.push(asset);
  touch(project);
  return asset;
}

/** Set a keyframe on a clip property. Keeps the array sorted by time. */
export function setKeyframe(clip, propPath, keyframe) {
  if (!clip.keyframes[propPath]) clip.keyframes[propPath] = [];
  const arr = clip.keyframes[propPath];
  const existing = arr.findIndex((k) => k.time === keyframe.time);
  if (existing !== -1) arr[existing] = keyframe;
  else arr.push(keyframe);
  arr.sort((a, b) => a.time - b.time);
}

/** Remove a keyframe at a specific time on a property. */
export function removeKeyframe(clip, propPath, time) {
  if (!clip.keyframes[propPath]) return;
  clip.keyframes[propPath] = clip.keyframes[propPath].filter((k) => k.time !== time);
}

/**
 * Interpolate a property value at `time` from keyframe array.
 * Falls back to the clip's static property if no keyframes.
 */
export function interpolate(clip, propPath, time) {
  const kfs = clip.keyframes[propPath];
  const staticVal = getPropValue(clip.properties, propPath);

  if (!kfs || kfs.length === 0) return staticVal;
  if (kfs.length === 1) return kfs[0].value;
  if (time <= kfs[0].time) return kfs[0].value;
  if (time >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;

  // Find surrounding keyframes
  let a = kfs[0], b = kfs[1];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (time >= kfs[i].time && time <= kfs[i + 1].time) {
      a = kfs[i];
      b = kfs[i + 1];
      break;
    }
  }

  const t = (time - a.time) / (b.time - a.time);
  return lerpValue(a.value, b.value, easeT(t, b.easing, b.handles));
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function getTrack(project, trackId) {
  return project.tracks.find((t) => t.id === trackId) ?? null;
}

export function getClip(project, clipId) {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

export function getAsset(project, assetId) {
  return project.assets.find((a) => a.id === assetId) ?? null;
}

/** All clips visible at a given time, sorted by track zIndex. */
export function clipsAtTime(project, time) {
  const result = [];
  const sorted = [...project.tracks].sort((a, b) => a.zIndex - b.zIndex);
  for (const track of sorted) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (time >= clip.startTime && time < clip.startTime + clip.duration) {
        result.push({ clip, track });
      }
    }
  }
  return result;
}

/** Total project duration in seconds (end of the last clip across all tracks). */
export function totalDuration(project) {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.startTime + clip.duration);
    }
  }
  return max;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Shallow validation; throws descriptive errors if the EDL is malformed. */
export function validateProject(project) {
  if (!project || typeof project !== 'object') throw new Error('Project must be an object');
  if (!project.id) throw new Error('Project missing id');
  if (project.version !== EDL_VERSION) throw new Error(`Unsupported EDL version: ${project.version}`);
  if (!project.canvas) throw new Error('Project missing canvas');
  if (!Array.isArray(project.tracks)) throw new Error('Project missing tracks array');
  if (!Array.isArray(project.assets)) throw new Error('Project missing assets array');
}

// ─── Private helpers ─────────────────────────────────────────────────────────

function defaultClipProperties() {
  return {
    opacity: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    color: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
    blendMode: 'normal',
    volume: 1,
  };
}

function defaultTrackName(type) {
  switch (type) {
    case 'video':   return 'Video';
    case 'audio':   return 'Audio';
    case 'overlay': return 'Overlay';
    default:        return 'Track';
  }
}

function touch(project) {
  project.updatedAt = new Date().toISOString();
}

function getPropValue(obj, path) {
  return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
}

function lerpValue(a, b, t) {
  if (typeof a === 'number') return a + (b - a) * t;
  if (typeof a === 'object' && a !== null) {
    const result = {};
    for (const k of Object.keys(a)) result[k] = lerpValue(a[k], b[k], t);
    return result;
  }
  return t < 0.5 ? a : b;
}

function easeT(t, easing, handles) {
  switch (easing) {
    case 'hold':   return 0;
    case 'linear': return t;
    case 'ease':   return t * t * (3 - 2 * t); // smoothstep
    case 'bezier': {
      if (!handles) return t;
      // Cubic bezier approximation — Newton-Raphson would be exact but overkill here
      return cubicBezierY(t, handles[0], handles[1], handles[2], handles[3]);
    }
    default: return t;
  }
}

function cubicBezierY(t, cx1, cy1, cx2, cy2) {
  // Simple 1D cubic bezier evaluation (t is already parametric)
  return 3 * (1 - t) * (1 - t) * t * cy1 +
         3 * (1 - t) * t * t * cy2 +
         t * t * t;
}
