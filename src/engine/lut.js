/**
 * lut.js — LUT file parsers for .cube and .3dl formats
 *
 * Both parsers emit { size: N, data: Float32Array(N³×3) } in R-fastest order,
 * matching WebGL2 texImage3D layout (R→X axis, G→Y, B→Z).
 *
 * .cube spec (Adobe/Resolve): R varies fastest, B slowest — stored as-is.
 * .3dl spec (Lustre/Autodesk): varies by exporter; we assume R-fastest (most
 * modern tools). If axis order appears wrong, re-export as .cube.
 *
 * LUT assets in the project model:
 *   { id, name, type:'lut', storageKey, lutFormat:'cube'|'3dl', lutSize:N }
 * Clips reference a LUT via: clip.properties.color.lut = assetId
 */

export function detectLUTFormat(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'cube') return 'cube';
  if (ext === '3dl') return '3dl';
  return null;
}

/**
 * Parse an Adobe/DaVinci .cube file.
 * Supports 3D LUTs (LUT_3D_SIZE N). Ignores 1D tables and comment lines (#).
 * Data is stored R-fastest (R=0 to N-1 innermost loop).
 */
export function parseCube(text) {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const values = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (/^(TITLE|LUT_1D_SIZE|DOMAIN_MIN|DOMAIN_MAX|LUT_1D_INPUT_RANGE|LUT_3D_INPUT_RANGE)/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3 && !isNaN(parts[0])) {
      values.push(parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]));
    }
  }

  if (!size) throw new Error('.cube: LUT_3D_SIZE not found');
  const expected = size * size * size * 3;
  if (values.length < expected) throw new Error(`.cube: expected ${expected / 3} entries, got ${values.length / 3}`);

  return { size, data: new Float32Array(values.slice(0, expected)) };
}

/**
 * Parse an Autodesk .3dl file.
 * Reads integer RGB triplets and normalises by the max value found (or 4095 for
 * 12-bit files). Assumes R-fastest storage order (most modern exporters).
 */
export function parse3dl(text) {
  const lines = text.split(/\r?\n/);
  const raw = []; // [r0, g0, b0, r1, g1, b1, ...]
  let maxVal = 4095;

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^Mesh\s/i.test(t)) continue;   // header line
    if (/^\d+(\s+\d+)+$/.test(t)) {
      const parts = t.split(/\s+/).map(Number);
      if (parts.length === 3) {
        raw.push(parts[0], parts[1], parts[2]);
        // track max to normalise correctly (handles 10-bit and 12-bit files)
        for (const v of parts) if (v > maxVal) maxVal = v;
      }
      // Lines with 1 value may be a mesh input axis — skip
    }
  }

  if (!raw.length) throw new Error('.3dl: no data found');

  const n3 = raw.length / 3;
  const size = Math.round(Math.cbrt(n3));
  if (size * size * size !== n3) throw new Error(`.3dl: ${n3} entries is not a perfect cube`);

  if (!maxVal) maxVal = 1;
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i] / maxVal;

  return { size, data };
}
