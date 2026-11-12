# Independent re-solve with Google OR-Tools' max-flow (C++ push-relabel), built from explicit arcs.
import json, numpy as np, time
from ortools.graph.python import max_flow
meta = json.load(open('mine.json')); nx, ny, nz = meta['nx'], meta['ny'], meta['nz']
N = nx*ny*nz; nxy = nx*ny
idx = np.arange(N); x = idx % nx; y = (idx // nx) % ny; z = idx // nxy
tails, heads = [], []
for dx in (-1, 0, 1):
    for dy in (-1, 0, 1):
        plus = (dx == 0 or dy == 0)
        ok = (z > 0) & (x+dx >= 0) & (x+dx < nx) & (y+dy >= 0) & (y+dy < ny)
        ok &= ((z % 2 == 1) | plus)          # odd benches: 9 blocks above; even benches: 5
        t = idx[ok]; tails.append(t); heads.append(t + dx + nx*dy - nxy)
tails = np.concatenate(tails); heads = np.concatenate(heads)
print('slope constraints built independently:', len(tails))
S, T = N, N+1
allok = True
for r in meta['results']:
    val = np.fromfile(f"val_{r['price']}.f64", dtype=np.float64).astype(np.int64)
    pos = val > 0; neg = val < 0
    sumpos = int(val[pos].sum()); INF = sumpos + 1
    smf = max_flow.SimpleMaxFlow()
    smf.add_arcs_with_capacity(tails, heads, np.full(len(tails), INF, dtype=np.int64))
    smf.add_arcs_with_capacity(np.full(pos.sum(), S), idx[pos], val[pos])
    smf.add_arcs_with_capacity(idx[neg], np.full(neg.sum(), T), -val[neg])
    t0 = time.time(); status = smf.solve(S, T); dt = time.time() - t0
    best = sumpos - smf.optimal_flow()
    # also re-evaluate my pit directly from the values
    pit = np.fromfile(f"pit_{r['price']}.u8", dtype=np.uint8)
    mined = z < pit[idx % nxy]
    direct = int(val[mined].sum())
    viol = int((mined[tails] & ~mined[heads]).sum())
    ok = (status == smf.OPTIMAL and best == r['pitValue'] == direct and viol == 0)
    allok &= ok
    if not ok or r['price'] % 1000 == 0:
        print(f"${r['price']}/oz: OR-Tools optimum ${best:,} | mine ${int(r['pitValue']):,} | pit re-summed ${direct:,} | slope violations {viol} | {'MATCH' if ok else 'DIFFERENT'} ({dt:.1f}s)")
print(f"{len(meta['results'])} prices checked:", 'ALL MATCH' if allok else 'MISMATCH')
