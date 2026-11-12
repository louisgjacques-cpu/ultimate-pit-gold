// core.js — deposit generator, economics and the pit solver.
// Shared verbatim by the Node test-suite and the page (main thread + Web Worker).

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(i, j, k, seed) {
  var h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Smooth 3D value noise in [0,1].
function noise3(x, y, z, seed) {
  var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  var fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  var a = hash3(xi, yi, zi, seed), b = hash3(xi + 1, yi, zi, seed);
  var c = hash3(xi, yi + 1, zi, seed), d = hash3(xi + 1, yi + 1, zi, seed);
  var e = hash3(xi, yi, zi + 1, seed), f = hash3(xi + 1, yi, zi + 1, seed);
  var g = hash3(xi, yi + 1, zi + 1, seed), h = hash3(xi + 1, yi + 1, zi + 1, seed);
  var ab = a + (b - a) * fx, cd = c + (d - c) * fx, ef = e + (f - e) * fx, gh = g + (h - g) * fx;
  var abcd = ab + (cd - ab) * fy, efgh = ef + (gh - ef) * fy;
  return abcd + (efgh - abcd) * fz;
}

// Synthetic gold deposit: three dipping ore lenses at increasing depth plus one small
// high-grade pod near the bottom, all with patchy grades. Returns the lens list and the
// grade (grams of gold per tonne) of every block. z = 0 is the surface bench.
var TIERS = [
  { z0: 3.5, z1: 6.0, p0: 1.2, p1: 1.7, a0: 8, a1: 12, b0: 5.0, b1: 7.0, c0: 1.6, c1: 2.4, off: 0.26 },
  { z0: 11.0, z1: 14.0, p0: 1.6, p1: 2.2, a0: 8.5, a1: 12, b0: 5.0, b1: 7.0, c0: 1.8, c1: 2.6, off: 0.20 },
  { z0: 20.0, z1: 23.5, p0: 2.6, p1: 3.4, a0: 8, a1: 10.5, b0: 4.5, b1: 6.0, c0: 1.9, c1: 2.7, off: 0.10 },
  { z0: 26.5, z1: 28.5, p0: 6.0, p1: 9.0, a0: 3.5, a1: 5, b0: 2.5, b1: 3.5, c0: 1.4, c1: 1.9, off: 0.10 }
];
function genLenses(seed, nx, ny, nz) {
  var rnd = mulberry32(Math.imul(seed, 2654435761) | 0);
  var s = nx / 96, sz = nz / 32, lenses = [], base = rnd() * Math.PI * 2;
  for (var t = 0; t < TIERS.length; t++) {
    var T = TIERS[t];
    var ang = t < 3 ? base + t * 2.0944 + (rnd() - 0.5) * 0.9 : rnd() * Math.PI * 2;
    var rad = (0.45 + 0.55 * rnd()) * T.off * nx;
    var th = rnd() * Math.PI, dip = (0.22 + rnd() * 0.42) * (rnd() < 0.5 ? -1 : 1);
    lenses.push({
      cx: nx / 2 + Math.cos(ang) * rad, cy: ny / 2 + Math.sin(ang) * rad,
      cz: (T.z0 + rnd() * (T.z1 - T.z0)) * sz,
      a: (T.a0 + rnd() * (T.a1 - T.a0)) * s, b: (T.b0 + rnd() * (T.b1 - T.b0)) * s,
      c: (T.c0 + rnd() * (T.c1 - T.c0)) * sz,
      peak: T.p0 + rnd() * (T.p1 - T.p0),
      ct: Math.cos(th), st: Math.sin(th), cd: Math.cos(dip), sd: Math.sin(dip)
    });
  }
  return lenses;
}
function genDeposit(seed, nx, ny, nz) {
  var lenses = genLenses(seed, nx, ny, nz);
  var N = nx * ny * nz, grade = new Float32Array(N), s = nx / 96;
  var nseed = (Math.imul(seed, 7919) + 13) | 0, f1 = 1 / (10 * s), f2 = 1 / (4 * s);
  var i = 0;
  for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++, i++) {
    var g = 0;
    for (var l = 0; l < lenses.length; l++) {
      var L = lenses[l];
      var dx = x + 0.5 - L.cx, dy = y + 0.5 - L.cy, dz = z + 0.5 - L.cz;
      var u = dx * L.ct + dy * L.st;            // along strike
      var hh = -dx * L.st + dy * L.ct;          // across strike (horizontal)
      var v = hh * L.cd + dz * L.sd;            // down dip
      var w = -hh * L.sd + dz * L.cd;           // across the lens
      var q = (u * u) / (L.a * L.a) + (v * v) / (L.b * L.b) + (w * w) / (L.c * L.c);
      if (q < 6) g += L.peak * Math.exp(-1.35 * q);
    }
    if (g > 0.01) {
      var n = (noise3(x * f1, y * f1, z * f1 * 1.6, nseed) - 0.5) * 1.5 +
              (noise3(x * f2, y * f2, z * f2 * 1.6, nseed + 101) - 0.5) * 0.9;
      g *= Math.exp(0.95 * n) * (0.9 + 0.2 * hash3(x, y, z, nseed + 7));
    }
    grade[i] = g < 0.02 ? 0 : g;
  }
  return grade;
}

// Economics. One block = 15 m cube of rock at 2.7 t/m3 = 9,112.5 t.
var ECON = {
  blockM: 15, tonnes: 9112.5, recovery: 0.90,
  procCost: 20,          // $ per tonne of ore processed (mill + G&A)
  mineCost: 3.0,         // $ per tonne moved, at surface
  mineCostPerBench: 0.07 // extra haulage $ per tonne for each bench deeper
};
var OZ = 31.1035; // grams per troy ounce

// Net dollar value of each block if mined, at a given gold price ($/oz). Integer dollars.
function blockValues(grade, nx, ny, nz, price, out) {
  var rev = ECON.recovery * price / OZ, nxy = nx * ny, i = 0;
  for (var z = 0; z < nz; z++) {
    var cm = ECON.mineCost + ECON.mineCostPerBench * z;
    for (var j = 0; j < nxy; j++, i++) {
      var net = grade[i] * rev - ECON.procCost;
      out[i] = Math.round(ECON.tonnes * ((net > 0 ? net : 0) - cm));
    }
  }
  return out;
}

// Slope rule: to mine a block you must first mine the blocks above it.
// Odd benches need all 9 blocks above, even benches need 5 (a plus shape).
// Alternating the two gives an octagonal cone: wall slope of about 45 degrees.
function buildTopology(nx, ny, nz) {
  var N = nx * ny * nz, nxy = nx * ny;
  var up = new Uint16Array(N), dn = new Uint16Array(N), off = new Int32Array(9);
  var k, PLUS = 186, ALL = 511, nArcs = 0;
  for (k = 0; k < 9; k++) off[k] = (k % 3 - 1) + nx * (((k / 3) | 0) - 1) - nxy;
  for (var z = 0; z < nz; z++) for (var y = 0; y < ny; y++) for (var x = 0; x < nx; x++) {
    var v = x + nx * (y + ny * z), m, xx, yy, pat;
    if (z > 0) {
      pat = (z & 1) ? ALL : PLUS; m = 0;
      for (k = 0; k < 9; k++) if ((pat >> k) & 1) {
        xx = x + (k % 3 - 1); yy = y + (((k / 3) | 0) - 1);
        if (xx >= 0 && xx < nx && yy >= 0 && yy < ny) { m |= 1 << k; nArcs++; }
      }
      up[v] = m;
    }
    if (z < nz - 1) {
      pat = ((z + 1) & 1) ? ALL : PLUS; m = 0;
      for (k = 0; k < 9; k++) if ((pat >> k) & 1) {
        xx = x - (k % 3 - 1); yy = y - (((k / 3) | 0) - 1);
        if (xx >= 0 && xx < nx && yy >= 0 && yy < ny) m |= 1 << k;
      }
      dn[v] = m;
    }
  }
  return { N: N, nx: nx, ny: ny, nz: nz, up: up, dn: dn, off: off, nArcs: nArcs };
}

// The ultimate-pit problem is a maximum-closure problem, which is a minimum cut:
//   source -> every profitable block (capacity = its value)
//   every loss-making block -> sink (capacity = its cost)
//   block -> each block it needs removed first (infinite capacity)
// Max flow is found with Dinic's algorithm on the implicit grid graph. The blocks still
// reachable from the source at the end are the optimal pit.
function makeWorkspace(topo) {
  var N = topo.N;
  return { capS: new Float64Array(N), capT: new Float64Array(N), flow: new Float64Array(N * 9),
    level: new Int32Array(N), it: new Uint8Array(N), queue: new Int32Array(N),
    pathNode: new Int32Array(N + 1), pathArc: new Uint8Array(N + 1) };
}
function solvePit(val, topo, ws) {
  if (!ws) ws = makeWorkspace(topo);
  var N = topo.N, nx = topo.nx, ny = topo.ny, nz = topo.nz;
  var up = topo.up, dn = topo.dn, off = topo.off, nxy = nx * ny;
  var capS = ws.capS, capT = ws.capT, flow = ws.flow;
  var level = ws.level, it = ws.it, queue = ws.queue, pathNode = ws.pathNode, pathArc = ws.pathArc;
  var roots = [], sumPos = 0, v, w, u, k, m, a, i, lv, b, f, idx;
  capS.fill(0); capT.fill(0); flow.fill(0);
  for (v = 0; v < N; v++) {
    if (val[v] > 0) { capS[v] = val[v]; sumPos += val[v]; roots.push(v); }
    else if (val[v] < 0) capT[v] = -val[v];
  }
  var total = 0, phases = 0, nRoots = roots.length, INF = 0x7fffffff;
  for (;;) {
    // --- BFS: shortest residual distance from the source ---
    level.fill(-1);
    var qh = 0, qt = 0, tL = INF, r;
    for (i = 0; i < nRoots; i++) { r = roots[i]; if (capS[r] > 0) { level[r] = 0; queue[qt++] = r; } }
    while (qh < qt) {
      v = queue[qh++]; lv = level[v];
      if (capT[v] > 0 && lv + 1 < tL) tL = lv + 1;
      if (lv + 1 >= tL) continue;
      m = up[v];
      for (k = 0; m; k++, m >>= 1) if (m & 1) {
        w = v + off[k];
        if (level[w] < 0) { level[w] = lv + 1; queue[qt++] = w; }
      }
      m = dn[v];
      for (k = 0; m; k++, m >>= 1) if (m & 1) {
        u = v - off[k];
        if (level[u] < 0 && flow[u * 9 + k] > 0) { level[u] = lv + 1; queue[qt++] = u; }
      }
    }
    if (tL === INF) break; // sink unreachable: flow is maximum
    phases++;
    // --- DFS: blocking flow in the level graph ---
    it.fill(0);
    for (i = 0; i < nRoots; i++) {
      r = roots[i];
      if (!(capS[r] > 0)) continue;
      var depth = 0; pathNode[0] = r;
      for (;;) {
        v = pathNode[depth]; lv = level[v];
        if (lv === tL - 1) {
          var c = capT[v];
          if (c > 0) {
            b = capS[r] < c ? capS[r] : c;
            for (k = 0; k < depth; k++) {
              a = pathArc[k];
              if (a >= 9) { f = flow[pathNode[k + 1] * 9 + (a - 9)]; if (f < b) b = f; }
            }
            capS[r] -= b; capT[v] -= b; total += b;
            var cut = -1;
            for (k = 0; k < depth; k++) {
              a = pathArc[k];
              if (a < 9) flow[pathNode[k] * 9 + a] += b;
              else { idx = pathNode[k + 1] * 9 + (a - 9); flow[idx] -= b; if (cut < 0 && flow[idx] === 0) cut = k; }
            }
            if (capS[r] === 0) break;
            if (cut >= 0) depth = cut;
            continue;
          }
          level[v] = -2;
          if (depth === 0) break;
          depth--; it[pathNode[depth]]++;
          continue;
        }
        var adv = -1;
        for (a = it[v]; a < 18; a++) {
          if (a < 9) {
            if ((up[v] >> a) & 1) { w = v + off[a]; if (level[w] === lv + 1) { adv = w; break; } }
          } else {
            k = a - 9;
            if ((dn[v] >> k) & 1) { u = v - off[k]; if (level[u] === lv + 1 && flow[u * 9 + k] > 0) { adv = u; break; } }
          }
        }
        it[v] = a;
        if (adv >= 0) { pathArc[depth] = a; pathNode[++depth] = adv; }
        else {
          level[v] = -2;
          if (depth === 0) break;
          depth--; it[pathNode[depth]]++;
        }
      }
    }
  }
  // Source side of the minimum cut = the pit. Stored as depth (benches mined) per column.
  var pit = new Uint8Array(nxy), pitValue = 0, blocks = 0;
  for (v = 0; v < N; v++) if (level[v] >= 0) { pit[v % nxy]++; pitValue += val[v]; blocks++; }
  return { pit: pit, pitValue: pitValue, sumPos: sumPos, flow: total, phases: phases, blocks: blocks, level: level, flowArr: flow, capS: capS, capT: capT };
}

// Independent checks on a pit, used for the on-screen certificate.
// 1) every wall obeys the slope rule; 2) value of the pit, summed directly from block values.
function checkPit(pit, val, topo) {
  var nx = topo.nx, ny = topo.ny, nz = topo.nz, nxy = nx * ny, up = topo.up;
  var value = 0, ok = true, blocks = 0;
  for (var c = 0; c < nxy; c++) {
    var d = pit[c];
    for (var z = 0; z < d; z++) {
      var v = c + nxy * z; value += val[v]; blocks++;
      var m = up[v];
      for (var k = 0; m; k++, m >>= 1) if (m & 1) {
        var c2 = c + (k % 3 - 1) + nx * (((k / 3) | 0) - 1);
        if (pit[c2] < z) ok = false;
      }
    }
  }
  return { feasible: ok, value: value, blocks: blocks };
}

// Tonnage and metal report for a pit at a given price.
function pitStats(pit, grade, nx, ny, nz, price) {
  var nxy = nx * ny, rev = ECON.recovery * price / OZ, cutoff = ECON.procCost / rev;
  var ore = 0, waste = 0, gramsIn = 0, maxD = 0;
  for (var c = 0; c < nxy; c++) {
    var d = pit[c]; if (d > maxD) maxD = d;
    for (var z = 0; z < d; z++) {
      var g = grade[c + nxy * z];
      if (g * rev - ECON.procCost > 0) { ore++; gramsIn += g; } else waste++;
    }
  }
  var t = ECON.tonnes;
  return {
    oreT: ore * t, wasteT: waste * t, oreBlocks: ore, wasteBlocks: waste,
    grade: ore ? gramsIn / ore : 0, ounces: gramsIn * t * ECON.recovery / OZ,
    strip: ore ? waste / ore : 0, depthM: maxD * ECON.blockM, cutoff: cutoff
  };
}

// Message handler shared by the Web Workers (and by the no-worker fallback).
function makeSolverHandler(post) {
  var G = null;
  return function (m) {
    try {
      if (m.type === 'init') {
        G = null;
        var topo = buildTopology(m.nx, m.ny, m.nz);
        G = { epoch: m.epoch, nx: m.nx, ny: m.ny, nz: m.nz, grade: genDeposit(m.seed, m.nx, m.ny, m.nz), topo: topo,
          ws: makeWorkspace(topo), val: new Float64Array(topo.N) };
        post({ type: 'ready', epoch: m.epoch, nArcs: topo.nArcs });
      } else if (m.type === 'free') {
        G = null;
      } else if (m.type === 'solve') {
        if (!G || G.epoch !== m.epoch) return;
        blockValues(G.grade, G.nx, G.ny, G.nz, m.price, G.val);
        var t0 = performance.now(), res = solvePit(G.val, G.topo, G.ws), ms = performance.now() - t0;
        var chk = checkPit(res.pit, G.val, G.topo);
        post({ type: 'shell', epoch: m.epoch, idx: m.idx, price: m.price, pit: res.pit, value: chk.value, flow: res.flow,
          sumPos: res.sumPos, feasible: chk.feasible, blocks: chk.blocks, phases: res.phases, ms: ms }, [res.pit.buffer]);
      }
    } catch (err) {
      G = null;
      post({ type: 'error', epoch: m.epoch, message: String((err && err.message) || err) });
    }
  };
}

if (typeof module !== 'undefined') {
  module.exports = { mulberry32: mulberry32, hash3: hash3, noise3: noise3, genDeposit: genDeposit, genLenses: genLenses, TIERS: TIERS, makeWorkspace: makeWorkspace, makeSolverHandler: makeSolverHandler, ECON: ECON, OZ: OZ,
    blockValues: blockValues, buildTopology: buildTopology, solvePit: solvePit, checkPit: checkPit, pitStats: pitStats };
}
