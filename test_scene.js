// Checks for the main-thread helpers: hand-digging always yields a legal pit, valuation matches the
// solver's, picking hits the right block, meshes build.
const vm = require('vm'), fs = require('fs');
const ctx = { console, Math, Float32Array, Float64Array, Uint8Array, Uint16Array, Int32Array, Infinity, performance, module: undefined };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('core.js', 'utf8') + '\n' + fs.readFileSync('scene.js', 'utf8'), ctx);
const run = (code) => vm.runInContext(code, ctx);
const out = run(`(function(){
  var nx=96, ny=96, nz=32, seed=9, log=[];
  var grade=genDeposit(seed,nx,ny,nz), topo=buildTopology(nx,ny,nz), val=new Float64Array(topo.N), zero=new Float64Array(topo.N);
  // 1. random hand-digging stays legal
  var rnd=mulberry32(5), pit=new Uint8Array(nx*ny), bad=0;
  for (var t=0;t<4000;t++){ var x=(rnd()*nx)|0, y=(rnd()*ny)|0; digAt(pit,x,y,Math.min(nz,pit[x+nx*y]+1+((rnd()*5)|0)),nx,ny); if(t%200===0 && !checkPit(pit,zero,topo).feasible) bad++; }
  if(!checkPit(pit,zero,topo).feasible) bad++;
  log.push('random digging: '+(bad?'ILLEGAL PIT':'always a legal pit')+' (deepest '+Math.max.apply(null,Array.from(pit))+' benches)');
  // 2. minimality: digging one column to depth d on fresh ground equals the smallest legal pit containing that block
  var p2=new Uint8Array(nx*ny); digAt(p2,48,48,20,nx,ny); var blocks=0; for(var c=0;c<p2.length;c++) blocks+=p2[c];
  var v1=new Float64Array(topo.N); v1.fill(-1); v1[48+nx*48+nx*ny*19]=1e9; var r=solvePit(v1,topo); var same=true; for(c=0;c<p2.length;c++) if(p2[c]!==r.pit[c]) same=false;
  log.push('single dig to bench 20 = smallest legal cone (matches solver): '+same+', '+blocks+' blocks');
  // 3. valuation agrees with the solver
  var ok3=true;
  [1500,3000,6000].forEach(function(price){ blockValues(grade,nx,ny,nz,price,val); var res=solvePit(val,topo); var rep=pitReport(res.pit,grade,nx,ny,nz,price), st=pitStats(res.pit,grade,nx,ny,nz,price);
    if(rep.value!==res.pitValue || rep.oreT!==st.oreT || rep.wasteT!==st.wasteT) ok3=false; });
  log.push('pitReport value == solver value: '+ok3);
  // 4. picking: straight-down ray hits the pit floor of that column; side ray hits the cut face
  blockValues(grade,nx,ny,nz,4500,val); var res=solvePit(val,topo), ok4=true, n4=0;
  for (t=0;t<2000;t++){ var x=(rnd()*nx)|0, y=(rnd()*ny)|0; var h=pickBlock(x+0.5,y+0.5,50,0,0,-1,res.pit,nx,ny,nz,0); n4++; if(!h||h.x!==x||h.y!==y||h.z!==res.pit[x+nx*y]) ok4=false; }
  var h2=pickBlock(30.5,-40,-10.5,0,1,0,res.pit,nx,ny,nz,40);
  log.push('picking: '+n4+' vertical rays '+(ok4?'ok':'WRONG')+'; horizontal ray into cut face -> '+JSON.stringify(h2));
  // 5. meshes
  var cz=colorizeDeposit(grade,nx,ny,nz,seed), mb=new MeshBuf();
  buildSolidMesh(mb,res.pit,cz.col,grade,nx,ny,nz,40); var q1=mb.n/54;
  buildOreMesh(mb,res.pit,cz.col,cz.ore,grade,nx,ny,nz); var q2=mb.n/54;
  buildShellMesh(mb,res.pit,nx,ny,nz); var q3=mb.n/54;
  var nan=false; for(var i=0;i<mb.n;i++) if(mb.a[i]!==mb.a[i]) nan=true;
  log.push('mesh quads: solid '+q1+', ore '+q2+', shell '+q3+', ore blocks '+cz.ore.length+', NaN '+nan);
  log.push('lenses: '+JSON.stringify(genLenses(seed,nx,ny,nz).map(function(L){return [Math.round(L.cx),Math.round(L.cy),Math.round(L.cz),+L.peak.toFixed(1)];})));
  // 6. worker handler round trip
  var msgs=[]; var h=makeSolverHandler(function(m){msgs.push(m);});
  h({type:'init',seed:seed,nx:nx,ny:ny,nz:nz,epoch:1}); h({type:'solve',epoch:1,idx:20,price:3000});
  var m=msgs[1]; log.push('handler: '+msgs[0].type+' nArcs '+msgs[0].nArcs+'; shell value '+m.value+' cert '+(m.feasible && m.sumPos-m.flow===m.value)+' in '+m.ms.toFixed(0)+' ms');
  return log.join('\\n');
})()`);
console.log(out);
