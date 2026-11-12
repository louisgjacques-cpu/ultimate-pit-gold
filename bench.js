const C = require('./core.js');
const [nx, ny, nz] = (process.argv[2] || '72,72,24').split(',').map(Number);
const seeds = (process.argv[3] || '1').split(',').map(Number);
const step = Number(process.argv[4] || 500);
for (const seed of seeds) {
  let t0 = performance.now();
  const grade = C.genDeposit(seed, nx, ny, nz);
  const tGen = performance.now() - t0;
  t0 = performance.now();
  const topo = C.buildTopology(nx, ny, nz);
  const tTopo = performance.now() - t0;
  let above = 0, maxg = 0, grams = 0;
  for (let i = 0; i < grade.length; i++) { if (grade[i] > 0.3) { above++; grams += grade[i]; } if (grade[i] > maxg) maxg = grade[i]; }
  console.log(`seed ${seed}: ${nx}x${ny}x${nz} = ${topo.N} blocks, ${topo.nArcs} slope constraints; gen ${tGen.toFixed(0)} ms, topo ${tTopo.toFixed(0)} ms; blocks >0.3 g/t: ${above}, max ${maxg.toFixed(1)} g/t, contained ${(grams * C.ECON.tonnes / C.OZ / 1e6).toFixed(2)} Moz`);
  const val = new Float64Array(topo.N);
  let prev = null, totalMs = 0;
  for (let price = 1000; price <= 6000; price += step) {
    C.blockValues(grade, nx, ny, nz, price, val);
    t0 = performance.now();
    const res = C.solvePit(val, topo);
    const ms = performance.now() - t0; totalMs += ms;
    const chk = C.checkPit(res.pit, val, topo), st = C.pitStats(res.pit, grade, nx, ny, nz, price);
    let nested = true, edge = false;
    if (prev) for (let c = 0; c < nx * ny; c++) if (res.pit[c] < prev[c]) nested = false;
    for (let c = 0; c < nx * ny; c++) if (res.pit[c] > 0) { const x = c % nx, y = (c / nx) | 0; if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) edge = true; }
    prev = res.pit;
    console.log(`  $${price}: value $${(res.pitValue / 1e6).toFixed(0)}M  ore ${(st.oreT / 1e6).toFixed(1)}Mt @${st.grade.toFixed(2)}  waste ${(st.wasteT / 1e6).toFixed(0)}Mt  strip ${st.strip.toFixed(1)}  ${(st.ounces / 1e6).toFixed(2)}Moz  depth ${st.depthM}m  | ${ms.toFixed(0)} ms, ${res.phases} phases | cert ${res.sumPos - res.flow === chk.value && chk.feasible ? 'OK' : 'FAIL'} nested ${nested ? 'y' : 'N'}${edge ? ' EDGE' : ''}`);
  }
  console.log(`  total solve time ${totalMs.toFixed(0)} ms`);
}
