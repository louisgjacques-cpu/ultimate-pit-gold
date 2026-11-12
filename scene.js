// scene.js — main-thread helpers with no DOM in them: colours, meshing, picking, digging, camera maths.

// ---------- colours ----------
var ORE_MIN = 0.25; // g/t. Blocks at or above this grade are drawn as mineralised rock.
var ORE_RAMP = [[0.25, 122, 84, 34], [0.5, 178, 120, 30], [1.0, 234, 164, 34], [2.0, 255, 208, 66], [4.0, 255, 240, 156], [8.0, 255, 255, 236]];
var STRATA = [[92, 96, 102], [106, 100, 92], [84, 82, 78], [116, 104, 90], [78, 86, 94]];

function oreColor(g, out) {
  var R = ORE_RAMP, n = R.length, i;
  if (g <= R[0][0]) { out[0] = R[0][1]; out[1] = R[0][2]; out[2] = R[0][3]; return out; }
  for (i = 1; i < n; i++) if (g <= R[i][0]) {
    var t = Math.log(g / R[i - 1][0]) / Math.log(R[i][0] / R[i - 1][0]);
    out[0] = R[i - 1][1] + (R[i][1] - R[i - 1][1]) * t;
    out[1] = R[i - 1][2] + (R[i][2] - R[i - 1][2]) * t;
    out[2] = R[i - 1][3] + (R[i][3] - R[i - 1][3]) * t;
    return out;
  }
  out[0] = R[n - 1][1]; out[1] = R[n - 1][2]; out[2] = R[n - 1][3];
  return out;
}

// One RGB colour per block: tilted rock strata, a soil bench on top, gold tones for ore.
// Also returns the list of ore block indices (used by the X-ray view).
function colorizeDeposit(grade, nx, ny, nz, seed) {
  var N = nx * ny * nz, col = new Uint8Array(N * 3), s = nx / 96, tmp = [0, 0, 0], ore = [], i = 0;
  for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++, i++) {
    var g = grade[i], r, gg, b, j = 0.90 + 0.20 * hash3(x, y, z, seed + 9);
    if (g >= ORE_MIN) {
      oreColor(g, tmp); j = 0.94 + 0.12 * hash3(x, y, z, seed + 9);
      r = tmp[0] * j; gg = tmp[1] * j; b = tmp[2] * j; ore.push(i);
    } else {
      if (z === 0) { r = 132; gg = 113; b = 84; }
      else {
        var zeta = z / (nz / 32) + 3.2 * noise3(x / (22 * s), y / (22 * s), 0.5, seed + 55) + 0.055 * x / s;
        var S = STRATA[Math.floor(zeta / 2.7) % 5]; r = S[0]; gg = S[1]; b = S[2];
      }
      if (g > 0.06) { var t = 0.45 * (g - 0.06) / (ORE_MIN - 0.06); r += (150 - r) * t; gg += (104 - gg) * t; b += (40 - b) * t; }
      r *= j; gg *= j; b *= j;
    }
    col[i * 3] = r > 255 ? 255 : r; col[i * 3 + 1] = gg > 255 ? 255 : gg; col[i * 3 + 2] = b > 255 ? 255 : b;
  }
  return { col: col, ore: Int32Array.from(ore) };
}

// ---------- mesh buffers ----------
// Vertex = x, y, z, r, g, b, u, v, alpha  (9 floats). World: x east, y north, z up; bench k sits at z = -k.
function MeshBuf() { this.a = new Float32Array(1 << 18); this.n = 0; }
MeshBuf.prototype.need = function (extra) {
  if (this.n + extra > this.a.length) {
    var b = new Float32Array(Math.max(this.a.length * 2, this.n + extra));
    b.set(this.a.subarray(0, this.n)); this.a = b;
  }
};
function pushQuad(mb, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b, al) {
  mb.need(54);
  var a = mb.a, n = mb.n;
  a[n] = ax; a[n + 1] = ay; a[n + 2] = az; a[n + 3] = r; a[n + 4] = g; a[n + 5] = b; a[n + 6] = 0; a[n + 7] = 0; a[n + 8] = al;
  a[n + 9] = bx; a[n + 10] = by; a[n + 11] = bz; a[n + 12] = r; a[n + 13] = g; a[n + 14] = b; a[n + 15] = 1; a[n + 16] = 0; a[n + 17] = al;
  a[n + 18] = cx; a[n + 19] = cy; a[n + 20] = cz; a[n + 21] = r; a[n + 22] = g; a[n + 23] = b; a[n + 24] = 1; a[n + 25] = 1; a[n + 26] = al;
  a[n + 27] = ax; a[n + 28] = ay; a[n + 29] = az; a[n + 30] = r; a[n + 31] = g; a[n + 32] = b; a[n + 33] = 0; a[n + 34] = 0; a[n + 35] = al;
  a[n + 36] = cx; a[n + 37] = cy; a[n + 38] = cz; a[n + 39] = r; a[n + 40] = g; a[n + 41] = b; a[n + 42] = 1; a[n + 43] = 1; a[n + 44] = al;
  a[n + 45] = dx; a[n + 46] = dy; a[n + 47] = dz; a[n + 48] = r; a[n + 49] = g; a[n + 50] = b; a[n + 51] = 0; a[n + 52] = 1; a[n + 53] = al;
  mb.n = n + 54;
}

// Face lighting, baked into vertex colours. Order: top, +x, -x, +y, -y, bottom.
var FACE_LIGHT = [1.0, 0.72, 0.60, 0.50, 0.88, 0.40];

// One face of block (x, y, z). face: 0 top, 1 +x, 2 -x, 3 +y, 4 -y, 5 bottom.
function pushFace(mb, x, y, z, face, r, g, b, al) {
  var x1 = x + 1, y1 = y + 1, zt = -z, zb = -z - 1;
  if (face === 0) pushQuad(mb, x, y, zt, x1, y, zt, x1, y1, zt, x, y1, zt, r, g, b, al);
  else if (face === 1) pushQuad(mb, x1, y, zb, x1, y1, zb, x1, y1, zt, x1, y, zt, r, g, b, al);
  else if (face === 2) pushQuad(mb, x, y1, zb, x, y, zb, x, y, zt, x, y1, zt, r, g, b, al);
  else if (face === 3) pushQuad(mb, x1, y1, zb, x, y1, zb, x, y1, zt, x1, y1, zt, r, g, b, al);
  else if (face === 4) pushQuad(mb, x, y, zb, x1, y, zb, x1, y, zt, x, y, zt, r, g, b, al);
  else pushQuad(mb, x, y, zb, x1, y, zb, x1, y1, zb, x, y1, zb, r, g, b, al);
}

function litFace(mb, x, y, z, face, i, col, isOre, nz) {
  var L = FACE_LIGHT[face] * (1 - 0.46 * z / nz);
  if (isOre) L = 0.5 + 0.5 * FACE_LIGHT[face];
  L /= 255;
  pushFace(mb, x, y, z, face, col[i * 3] * L, col[i * 3 + 1] * L, col[i * 3 + 2] * L, 1);
}

// Solid view: every block that is still in the ground, with everything south of `slice` cut away.
function buildSolidMesh(mb, pit, col, grade, nx, ny, nz, slice) {
  mb.n = 0;
  var nxy = nx * ny, z, i, dn;
  for (var y = slice; y < ny; y++) for (var x = 0; x < nx; x++) {
    var c = x + nx * y, d = pit[c];
    if (d >= nz) continue;
    i = c + nxy * d; litFace(mb, x, y, d, 0, i, col, grade[i] >= ORE_MIN, nz);
    dn = x + 1 < nx ? pit[c + 1] : nz;
    for (z = d; z < dn; z++) { i = c + nxy * z; litFace(mb, x, y, z, 1, i, col, grade[i] >= ORE_MIN, nz); }
    dn = x > 0 ? pit[c - 1] : nz;
    for (z = d; z < dn; z++) { i = c + nxy * z; litFace(mb, x, y, z, 2, i, col, grade[i] >= ORE_MIN, nz); }
    dn = y + 1 < ny ? pit[c + nx] : nz;
    for (z = d; z < dn; z++) { i = c + nxy * z; litFace(mb, x, y, z, 3, i, col, grade[i] >= ORE_MIN, nz); }
    dn = y > slice ? pit[c - nx] : nz;
    for (z = d; z < dn; z++) { i = c + nxy * z; litFace(mb, x, y, z, 4, i, col, grade[i] >= ORE_MIN, nz); }
  }
  return mb;
}

// X-ray view, opaque part: every ore block. Ore the pit takes keeps its colour; ore left in the ground is dimmed.
function buildOreMesh(mb, pit, col, oreIdx, grade, nx, ny, nz) {
  mb.n = 0;
  var nxy = nx * ny;
  for (var q = 0; q < oreIdx.length; q++) {
    var i = oreIdx[q], c = i % nxy, z = (i / nxy) | 0, x = c % nx, y = (c / nx) | 0;
    var r = col[i * 3], g = col[i * 3 + 1], b = col[i * 3 + 2];
    if (z >= pit[c]) { var lum = 0.3 * r + 0.55 * g + 0.15 * b; r = (r + lum) * 0.24; g = (g + lum * 0.95) * 0.24; b = (b + lum * 0.9) * 0.24; }
    for (var face = 0; face < 6; face++) {
      var hidden;
      if (face === 0) hidden = z > 0 && grade[i - nxy] >= ORE_MIN;
      else if (face === 5) hidden = z < nz - 1 && grade[i + nxy] >= ORE_MIN;
      else if (face === 1) hidden = x < nx - 1 && grade[i + 1] >= ORE_MIN;
      else if (face === 2) hidden = x > 0 && grade[i - 1] >= ORE_MIN;
      else if (face === 3) hidden = y < ny - 1 && grade[i + nx] >= ORE_MIN;
      else hidden = y > 0 && grade[i - nx] >= ORE_MIN;
      if (hidden) continue;
      var L = (0.5 + 0.5 * FACE_LIGHT[face]) / 255;
      pushFace(mb, x, y, z, face, r * L, g * L, b * L, 1);
    }
  }
  return mb;
}

// X-ray view, see-through part: the pit surface as a ghost shell (drawn additively).
function buildShellMesh(mb, pit, nx, ny, nz) {
  mb.n = 0;
  var r = 0.55, g = 0.68, b = 0.86, z, dn, wall = 0.075, floor = 0.022;
  for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
    var c = x + nx * y, d = pit[c];
    if (d > 0) pushFace(mb, x, y, d, 0, r, g, b, floor);
    // walls: where this column stands higher than its neighbour, the exposed side belongs to the pit wall
    if (x + 1 < nx) { dn = pit[c + 1]; for (z = d; z < dn; z++) pushFace(mb, x, y, z, 1, r, g, b, wall); }
    if (x > 0) { dn = pit[c - 1]; for (z = d; z < dn; z++) pushFace(mb, x, y, z, 2, r, g, b, wall); }
    if (y + 1 < ny) { dn = pit[c + nx]; for (z = d; z < dn; z++) pushFace(mb, x, y, z, 3, r, g, b, wall); }
    if (y > 0) { dn = pit[c - nx]; for (z = d; z < dn; z++) pushFace(mb, x, y, z, 4, r, g, b, wall); }
  }
  pushQuad(mb, 0, 0, 0, nx, 0, 0, nx, ny, 0, 0, ny, 0, r, g, b, 0.03); // the original ground surface
  return mb;
}

// Outline of the block model (12 edges) as line segments: x, y, z, r, g, b, u, v, alpha.
function buildBoxLines(nx, ny, nz) {
  var P = [[0, 0, 0], [nx, 0, 0], [nx, ny, 0], [0, ny, 0], [0, 0, -nz], [nx, 0, -nz], [nx, ny, -nz], [0, ny, -nz]];
  var E = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7], a = new Float32Array(E.length * 9);
  for (var i = 0; i < E.length; i++) {
    var p = P[E[i]];
    a.set([p[0], p[1], p[2], 0.58, 0.63, 0.66, 0.5, 0.5, 0.5], i * 9);
  }
  return a;
}

// ---------- picking ----------
// First solid block hit by a ray (voxel walk). Returns the block or null.
function pickBlock(ox, oy, oz, dx, dy, dz, pit, nx, ny, nz, slice) {
  var o = [ox, oy, -oz], d = [dx, dy, -dz], lo = [0, slice, 0], hi = [nx, ny, nz];
  var t0 = 0, t1 = Infinity, a, t, tt;
  for (a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo[a] || o[a] > hi[a]) return null; }
    else {
      t = (lo[a] - o[a]) / d[a]; tt = (hi[a] - o[a]) / d[a];
      if (t > tt) { var s = t; t = tt; tt = s; }
      if (t > t0) t0 = t; if (tt < t1) t1 = tt;
    }
  }
  if (t0 > t1) return null;
  t0 += 1e-5;
  var p = [o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0], ix = [0, 0, 0], st = [0, 0, 0], tm = [0, 0, 0], td = [0, 0, 0];
  for (a = 0; a < 3; a++) {
    ix[a] = Math.floor(p[a]);
    if (ix[a] < lo[a]) ix[a] = lo[a]; if (ix[a] > hi[a] - 1) ix[a] = hi[a] - 1;
    if (d[a] > 0) { st[a] = 1; tm[a] = t0 + (ix[a] + 1 - p[a]) / d[a]; td[a] = 1 / d[a]; }
    else if (d[a] < 0) { st[a] = -1; tm[a] = t0 + (ix[a] - p[a]) / d[a]; td[a] = -1 / d[a]; }
    else { st[a] = 0; tm[a] = Infinity; td[a] = Infinity; }
  }
  for (var n = nx + ny + nz + 4; n > 0; n--) {
    var c = ix[0] + nx * ix[1];
    if (ix[2] >= pit[c]) return { x: ix[0], y: ix[1], z: ix[2], c: c };
    a = tm[0] < tm[1] ? (tm[0] < tm[2] ? 0 : 2) : (tm[1] < tm[2] ? 1 : 2);
    ix[a] += st[a]; tm[a] += td[a];
    if (ix[a] < lo[a] || ix[a] >= hi[a]) return null;
  }
  return null;
}

// ---------- digging by hand ----------
// Mine column (cx, cy) down to `depth` benches, cutting the walls back as far as the slope rule demands.
function digAt(pit, cx, cy, depth, nx, ny) {
  var stack = [cx + nx * cy, depth], moved = 0;
  while (stack.length) {
    var req = stack.pop(), c = stack.pop(), cur = pit[c];
    if (cur >= req) continue;
    moved += req - cur; pit[c] = req;
    var zTop = req - 1; if (zTop < 1) continue;
    var zOdd = (zTop & 1) ? zTop : zTop - 1, x = c % nx, y = (c / nx) | 0;
    for (var k = 0; k < 9; k++) {
      if (k === 4) continue;
      var dx = k % 3 - 1, dy = ((k / 3) | 0) - 1, need = (dx === 0 || dy === 0) ? zTop : zOdd;
      var xx = x + dx, yy = y + dy;
      if (need >= 1 && xx >= 0 && xx < nx && yy >= 0 && yy < ny && pit[xx + nx * yy] < need) stack.push(xx + nx * yy, need);
    }
  }
  return moved;
}

// Dollar value + tonnage report of any pit at a price (same rounding as the solver's block values).
function pitReport(pit, grade, nx, ny, nz, price) {
  var nxy = nx * ny, rev = ECON.recovery * price / OZ, t = ECON.tonnes;
  var value = 0, ore = 0, waste = 0, grams = 0, maxD = 0;
  for (var c = 0; c < nxy; c++) {
    var d = pit[c]; if (d > maxD) maxD = d;
    for (var z = 0; z < d; z++) {
      var g = grade[c + nxy * z], net = g * rev - ECON.procCost, cm = ECON.mineCost + ECON.mineCostPerBench * z;
      value += Math.round(t * ((net > 0 ? net : 0) - cm));
      if (net > 0) { ore++; grams += g; } else waste++;
    }
  }
  return { value: value, oreT: ore * t, wasteT: waste * t, grade: ore ? grams / ore : 0, ounces: grams * t * ECON.recovery / OZ,
    strip: ore ? waste / ore : 0, depthM: maxD * ECON.blockM, cutoff: ECON.procCost / rev, blocks: ore + waste };
}

// ---------- camera maths (column-major 4x4) ----------
function matPerspective(fovy, aspect, near, far, shiftX, shiftY) {
  var f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[8] = -(shiftX || 0); m[9] = -(shiftY || 0); m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far);
  return m;
}
function camBasis(eye, target) {
  var fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2], l = Math.hypot(fx, fy, fz);
  fx /= l; fy /= l; fz /= l;
  var rx = fy, ry = -fx, rz = 0; l = Math.hypot(rx, ry) || 1; rx /= l; ry /= l;       // right = f x up(0,0,1)
  var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;       // up = r x f
  return { f: [fx, fy, fz], r: [rx, ry, rz], u: [ux, uy, uz] };
}
function matLookAt(eye, target) {
  var B = camBasis(eye, target), f = B.f, r = B.r, u = B.u, m = new Float32Array(16);
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2]; m[12] = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]);
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2]; m[13] = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2]; m[14] = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  m[15] = 1;
  return m;
}
function matMul(a, b) {
  var o = new Float32Array(16);
  for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

if (typeof module !== 'undefined') {
  module.exports = { ORE_MIN: ORE_MIN, oreColor: oreColor, colorizeDeposit: colorizeDeposit, MeshBuf: MeshBuf, pushQuad: pushQuad, pushFace: pushFace,
    buildSolidMesh: buildSolidMesh, buildOreMesh: buildOreMesh, buildShellMesh: buildShellMesh, buildBoxLines: buildBoxLines, pickBlock: pickBlock,
    digAt: digAt, pitReport: pitReport, matPerspective: matPerspective, camBasis: camBasis, matLookAt: matLookAt, matMul: matMul };
}
