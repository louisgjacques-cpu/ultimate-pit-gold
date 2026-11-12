// Exhaustive check: on small deposits, enumerate EVERY legal pit and compare the best one
// with what the solver returns.
const C = require('./core.js');

function feasibleFields(nx, ny, nz, topo) {
  const nxy = nx * ny, out = [], d = new Uint8Array(nxy);
  const total = Math.pow(nz + 1, nxy);
  for (let n = 0; n < total; n++) {
    let t = n;
    for (let c = 0; c < nxy; c++) { d[c] = t % (nz + 1); t = (t / (nz + 1)) | 0; }
    let ok = true;
    outer: for (let c = 0; c < nxy; c++) for (let z = 1; z < d[c]; z++) {
      let m = topo.up[c + nxy * z];
      for (let k = 0; m; k++, m >>= 1) if (m & 1) {
        const c2 = c + (k % 3 - 1) + nx * (((k / 3) | 0) - 1);
        if (d[c2] < z) { ok = false; break outer; }
      }
    }
    if (ok) out.push(Uint8Array.from(d));
  }
  return out;
}

function conservationOK(val, topo, res) {
  const { N, up, dn, off } = topo, fl = res.flowArr;
  for (let i = 0; i < fl.length; i++) if (fl[i] < 0) return false;
  for (let v = 0; v < N; v++) {
    let inflow = val[v] > 0 ? val[v] - res.capS[v] : 0, outflow = val[v] < 0 ? -val[v] - res.capT[v] : 0;
    if (res.capS[v] < 0 || res.capT[v] < 0) return false;
    let m = up[v]; for (let k = 0; m; k++, m >>= 1) if (m & 1) outflow += fl[v * 9 + k];
    m = dn[v]; for (let k = 0; m; k++, m >>= 1) if (m & 1) inflow += fl[(v - off[k]) * 9 + k];
    if (inflow !== outflow) return false;
  }
  return true;
}

const configs = [[3, 3, 3, 4000], [5, 1, 4, 4000], [1, 6, 5, 3000], [2, 2, 6, 3000], [3, 2, 5, 3000], [3, 3, 4, 1500], [4, 3, 3, 600], [4, 2, 4, 1500]];
let grand = 0, bad = 0;
const rnd = C.mulberry32(20261109);
for (const [nx, ny, nz, trials] of configs) {
  const topo = C.buildTopology(nx, ny, nz), N = topo.N, nxy = nx * ny;
  const fields = feasibleFields(nx, ny, nz, topo);
  const val = new Float64Array(N);
  let mism = 0, nonEmpty = 0;
  for (let t = 0; t < trials; t++) {
    const style = t % 3;
    for (let v = 0; v < N; v++) {
      const z = (v / nxy) | 0, r = rnd();
      if (style === 0) val[v] = Math.round((r - 0.62) * 40);                       // mixed, mostly waste
      else if (style === 1) val[v] = r < 0.18 + 0.08 * z ? Math.round(rnd() * 90) : -Math.round(1 + rnd() * 9); // rich ore at depth
      else val[v] = Math.round((rnd() - 0.5) * 6);                                // lots of ties and zeros
    }
    // brute force optimum
    let best = -Infinity;
    for (const d of fields) {
      let s = 0;
      for (let c = 0; c < nxy; c++) for (let z = 0; z < d[c]; z++) s += val[c + nxy * z];
      if (s > best) best = s;
    }
    const res = C.solvePit(val, topo), chk = C.checkPit(res.pit, val, topo);
    const ok = res.pitValue === best && chk.feasible && chk.value === best && chk.blocks === res.blocks &&
               res.sumPos - res.flow === best && conservationOK(val, topo, res);
    if (!ok) { mism++; if (mism < 3) console.log('MISMATCH', nx, ny, nz, 'best', best, 'solver', res.pitValue, chk); }
    if (best > 0) nonEmpty++;
  }
  grand += trials; bad += mism;
  console.log(`${nx}x${ny}x${nz}: ${fields.length} legal pits enumerated, ${trials} random deposits, ${mism} mismatches (${nonEmpty} with a profitable pit)`);
}
console.log(`TOTAL: ${grand - bad}/${grand} match exhaustive search`);
