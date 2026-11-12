(function () {
  'use strict';
  var PRICE_MIN = 1000, PRICE_STEP = 100, NP = 51, FOV = 30 * Math.PI / 180;
  var SIZES = { std: [96, 96, 32], big: [160, 160, 48] };
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), stage = $('stage'), canvas = $('gl'), chart = $('chart');
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var S = { seed: 9, big: false, priceIdx: 20, mode: 'opt', view: 'solid', slice: -1, bite: 1 };
  var dep = null, shells = [], pending = [], epoch = 0, solved = 0;
  var userPit = null, emptyPit = null, undo = [], userRep = null;
  var cam = { az: -1.84, el: 0.5, zoom: 1, az0: -1.84, sway: !reduceMotion, t0: 0 };
  var view = { W: 1, H: 1, shiftX: 0, shiftY: 0, fx: 1, fy: 1 };
  var eye = [0, 0, 1], target = [0, 0, 0], playing = null, hoverC = -1, noticeTimer = null;

  // ---------- formatting ----------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function int(n) { return Math.round(n).toLocaleString('en-US'); }
  function money(v) {
    var s = v < 0 ? '−' : '', a = Math.abs(v);
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e8) return s + '$' + Math.round(a / 1e6) + 'M';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
    return s + '$' + Math.round(a);
  }
  function priceOf(i) { return PRICE_MIN + i * PRICE_STEP; }
  function notice(msg) {
    var el = $('notice'); el.textContent = msg; el.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(function () { el.hidden = true; }, 7000);
  }

  // ---------- WebGL ----------
  var gl = null, prog = null, loc = {}, bufA, bufB, bufL, bufH, nA = 0, nB = 0, nL = 0, nH = 0;
  var mbA = new MeshBuf(), mbB = new MeshBuf(), mbH = new MeshBuf(), drawQueued = false;

  function initGL() {
    var opts = { antialias: true, alpha: false };
    try { gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); } catch (e) { gl = null; }
    if (!gl) return false;
    var deriv = !!gl.getExtension('OES_standard_derivatives');
    var vs = 'attribute vec3 aPos;attribute vec3 aCol;attribute vec2 aUV;attribute float aA;uniform mat4 uMVP;' +
      'varying vec3 vCol;varying vec2 vUV;varying float vA;void main(){vCol=aCol;vUV=aUV;vA=aA;gl_Position=uMVP*vec4(aPos,1.0);}';
    var fs = (deriv ? '#extension GL_OES_standard_derivatives : enable\n#define DERIV 1\n' : '') +
      'precision mediump float;varying vec3 vCol;varying vec2 vUV;varying float vA;uniform float uMode;\n' +
      'void main(){vec2 e2=min(vUV,1.0-vUV);float e=min(e2.x,e2.y);\n' +
      '#ifdef DERIV\nfloat w=max(fwidth(vUV.x),fwidth(vUV.y));float line=(1.0-smoothstep(0.0,0.02+w*1.3,e))*clamp(1.0-w*4.0,0.0,1.0);\n' +
      '#else\nfloat line=(1.0-smoothstep(0.0,0.05,e))*0.6;\n#endif\n' +
      'if(uMode<0.5)gl_FragColor=vec4(vCol*(1.0-0.36*line),1.0);\n' +
      'else if(uMode<1.5)gl_FragColor=vec4(vCol*(1.0+1.5*line),vA);\n' +
      'else gl_FragColor=vec4(vCol,vA);}';
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader failed');
      return s;
    }
    try {
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
    } catch (e) { console.error(e); gl = null; return false; }
    gl.useProgram(prog);
    ['aPos', 'aCol', 'aUV', 'aA'].forEach(function (n) { loc[n] = gl.getAttribLocation(prog, n); gl.enableVertexAttribArray(loc[n]); });
    loc.uMVP = gl.getUniformLocation(prog, 'uMVP'); loc.uMode = gl.getUniformLocation(prog, 'uMode');
    bufA = gl.createBuffer(); bufB = gl.createBuffer(); bufL = gl.createBuffer(); bufH = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST); gl.clearColor(0.047, 0.059, 0.071, 1);
    return true;
  }
  function upload(buf, arr, floats) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, floats), gl.DYNAMIC_DRAW);
    return floats / 9;
  }
  function drawBuf(buf, n, prim) {
    if (!n) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 36, 0);
    gl.vertexAttribPointer(loc.aCol, 3, gl.FLOAT, false, 36, 12);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 36, 24);
    gl.vertexAttribPointer(loc.aA, 1, gl.FLOAT, false, 36, 32);
    gl.drawArrays(prim, 0, n);
  }
  function fitCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function fitDist() {
    var t = Math.tan(FOV / 2), aspect = view.W / view.H;
    var xr = S.view !== 'solid';
    var wide = xr ? 1.42 * dep.nx : dep.nx + 0.5 * (dep.ny - S.slice);
    var tall = xr ? 0.71 * dep.ny + 0.9 * dep.nz : 0.6 * (dep.ny - S.slice * 0.5) + 0.9 * dep.nz;
    return 1.06 * Math.max(wide / (2 * t * aspect * view.fx), tall / (2 * t * view.fy));
  }
  function placeCamera() {
    var D = fitDist() * cam.zoom, ce = Math.cos(cam.el);
    target[0] = dep.nx / 2; target[1] = dep.ny / 2 + (S.view === 'solid' ? S.slice * 0.28 : 0); target[2] = -dep.nz * 0.42;
    eye[0] = target[0] + D * ce * Math.cos(cam.az); eye[1] = target[1] + D * ce * Math.sin(cam.az); eye[2] = target[2] + D * Math.sin(cam.el);
    return D;
  }
  function draw() {
    drawQueued = false;
    if (!gl || !dep) return;
    fitCanvas();
    var D = placeCamera();
    var MVP = matMul(matPerspective(FOV, view.W / view.H, D * 0.05, D * 5, view.shiftX, view.shiftY), matLookAt(eye, target));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(loc.uMVP, false, MVP);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.uniform1f(loc.uMode, 0);
    drawBuf(bufA, nA, gl.TRIANGLES);
    gl.enable(gl.BLEND); gl.depthMask(false);
    if (S.view === 'xray') {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(loc.uMode, 2); drawBuf(bufL, nL, gl.LINES);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.uniform1f(loc.uMode, 1); drawBuf(bufB, nB, gl.TRIANGLES);
    }
    if (nH) { gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.uniform1f(loc.uMode, 1); drawBuf(bufH, nH, gl.TRIANGLES); }
    gl.depthMask(true);
  }
  function requestDraw() { if (cam.sway || drawQueued) return; drawQueued = true; requestAnimationFrame(draw); }
  function tick(ts) {
    if (!cam.sway) return;
    if (!cam.t0) cam.t0 = ts;
    cam.az = cam.az0 + 0.3 * Math.sin((ts - cam.t0) / 1000 * 0.3);
    draw(); requestAnimationFrame(tick);
  }
  function stopSway() { if (cam.sway) { cam.sway = false; requestDraw(); } }

  // ---------- layout: keep the model centred in the part of the stage that panels do not cover ----------
  function measure() {
    var sr = stage.getBoundingClientRect(), W = sr.width, H = sr.height, L = 0, R = 0, T = 0, B = 0;
    if (!W || !H) return;
    function over(el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= sr.left || r.left >= sr.right || r.bottom <= sr.top || r.top >= sr.bottom) return null;
      return r;
    }
    var h = over($('hdr')), f = over($('ftr'));
    if (h) T = Math.max(0, h.bottom - sr.top);
    if (f) B = Math.max(0, sr.bottom - f.top - 18);
    [$('reserve'), $('solver')].forEach(function (el) {
      var r = over(el); if (!r) return;
      if ((r.left + r.right) / 2 < sr.left + W / 2) L = Math.max(L, r.right - sr.left); else R = Math.max(R, sr.right - r.left);
    });
    view.W = W; view.H = H;
    view.shiftX = (L - R) / W; view.shiftY = (B - T) / H;
    view.fx = Math.max(0.3, 1 - (L + R) / W); view.fy = Math.max(0.3, 1 - (T + B) / H);
    var hint = $('hint'), lg = $('legend');
    hint.style.bottom = (B + 10) + 'px'; hint.style.left = Math.round((L + (W - R)) / 2) + 'px';
    lg.style.bottom = (B + 10) + 'px';
    hint.style.display = (W - L - R) < 520 ? 'none' : '';
  }

  // ---------- meshes ----------
  function currentPit() {
    if (S.mode === 'dig') return userPit;
    if (shells[S.priceIdx]) return shells[S.priceIdx].pit;
    for (var r = 1; r < NP; r++) {
      if (S.priceIdx - r >= 0 && shells[S.priceIdx - r]) return shells[S.priceIdx - r].pit;
      if (S.priceIdx + r < NP && shells[S.priceIdx + r]) return shells[S.priceIdx + r].pit;
    }
    return emptyPit;
  }
  function rebuildMesh() {
    if (!gl || !dep) return;
    var pit = currentPit();
    if (S.view === 'solid') {
      buildSolidMesh(mbA, pit, dep.col, dep.grade, dep.nx, dep.ny, dep.nz, S.slice);
      nA = upload(bufA, mbA.a, mbA.n); nB = 0;
    } else {
      buildOreMesh(mbA, pit, dep.col, dep.ore, dep.grade, dep.nx, dep.ny, dep.nz);
      nA = upload(bufA, mbA.a, mbA.n);
      buildShellMesh(mbB, pit, dep.nx, dep.ny, dep.nz);
      nB = upload(bufB, mbB.a, mbB.n);
    }
    setHover(hoverC, true);
  }
  function setHover(c, force) {
    if (!gl || (c === hoverC && !force)) return;
    hoverC = c; mbH.n = 0;
    if (c >= 0 && S.mode === 'dig') {
      var x = c % dep.nx, y = (c / dep.nx) | 0, z = userPit[c] - 0.06;
      pushQuad(mbH, x, y, -z, x + 1, y, -z, x + 1, y + 1, -z, x, y + 1, -z, 1.0, 0.44, 0.26, 0.7);
    }
    nH = mbH.n ? upload(bufH, mbH.a, mbH.n) : 0;
    requestDraw();
  }

  // ---------- panels ----------
  function setRows(rep) {
    $('sOre').textContent = (rep.oreT / 1e6).toFixed(1) + ' Mt';
    $('sGrade').textContent = rep.grade.toFixed(2) + ' g/t';
    $('sGold').textContent = rep.ounces >= 1e6 ? (rep.ounces / 1e6).toFixed(2) + ' Moz' : int(rep.ounces / 1e3) + ' koz';
    $('sWaste').textContent = (rep.wasteT / 1e6).toFixed(1) + ' Mt';
    $('sStrip').textContent = rep.oreT ? rep.strip.toFixed(1) + ' : 1' : 'no ore';
    $('sDepth').textContent = int(rep.depthM) + ' m';
    $('sCut').textContent = rep.cutoff.toFixed(2) + ' g/t';
  }
  function updatePanels() {
    if (!dep) return;
    var price = priceOf(S.priceIdx), sh = shells[S.priceIdx], big = $('bigVal');
    $('priceNum').textContent = '$' + int(price);
    $('price').setAttribute('aria-valuetext', '$' + int(price) + ' per ounce');
    if (S.mode === 'opt') {
      $('resTitle').textContent = 'Best possible pit';
      $('versus').hidden = true; $('digTools').hidden = true;
      if (sh) {
        big.textContent = money(sh.value); big.className = 'big';
        $('bigSub').textContent = sh.value > 0 ? 'Undiscounted operating profit. No pit with stable walls earns more.' : 'At this price the best move is to leave it in the ground.';
        setRows(pitReport(sh.pit, dep.grade, dep.nx, dep.ny, dep.nz, price));
      } else {
        big.textContent = 'solving'; big.className = 'big wait';
        $('bigSub').textContent = 'Working out the best pit at this price.';
      }
    } else {
      userRep = pitReport(userPit, dep.grade, dep.nx, dep.ny, dep.nz, price);
      $('resTitle').textContent = 'Your pit';
      big.textContent = money(userRep.value); big.className = 'big';
      $('bigSub').textContent = 'Undiscounted operating profit from the blocks you have dug.';
      $('versus').hidden = false; $('digTools').hidden = false;
      var pct = 0, txt;
      if (!sh) txt = 'The optimizer is still solving this price.';
      else if (sh.value <= 0) txt = 'At this price the optimizer would not dig at all.';
      else {
        pct = clamp(userRep.value / sh.value, 0, 1);
        if (!userRep.blocks) txt = 'The optimizer made ' + money(sh.value) + ' here. Click the ground to dig.';
        else if (userRep.value <= 0) txt = 'You are losing money. The optimizer made ' + money(sh.value) + '.';
        else if (userRep.value >= sh.value) txt = 'You matched the optimum of ' + money(sh.value) + '.';
        else txt = (Math.floor(pct * 1000) / 10).toFixed(1) + '% of the optimizer’s ' + money(sh.value) + '.';
      }
      $('vsBar').style.width = (pct * 100).toFixed(1) + '%'; $('vsTxt').textContent = txt;
      setRows(userRep);
      $('undo').disabled = !undo.length; $('reset').disabled = !userRep.blocks;
    }
    var pill = $('pill');
    if (sh) {
      var cut = sh.sumPos - sh.value, good = sh.feasible && sh.flow === cut;
      pill.textContent = good ? 'proven optimal' : 'check failed'; pill.className = 'pill ' + (good ? 'ok' : 'bad');
      $('pFlow').textContent = '$' + int(sh.flow); $('pCut').textContent = '$' + int(cut);
      $('tMs').textContent = (sh.ms < 10 ? sh.ms.toFixed(1) : int(sh.ms)) + ' ms';
    } else {
      pill.textContent = 'solving'; pill.className = 'pill';
      $('pFlow').textContent = '...'; $('pCut').textContent = '...'; $('tMs').textContent = '...';
    }
    $('tShells').textContent = solved + ' of ' + NP;
  }

  // ---------- price chart ----------
  function drawChart() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = chart.clientWidth, h = chart.clientHeight;
    if (!w || !h) return;
    if (chart.width !== Math.round(w * dpr) || chart.height !== Math.round(h * dpr)) { chart.width = Math.round(w * dpr); chart.height = Math.round(h * dpr); }
    var g = chart.getContext('2d'); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    var pad = 9, top = 16, base = h - 1, stepW = (w - 2 * pad) / (NP - 1), bw = Math.max(2, stepW - 2), i, x, max = 0;
    for (i = 0; i < NP; i++) if (shells[i] && shells[i].value > max) max = shells[i].value;
    g.strokeStyle = 'rgba(147,160,168,0.16)'; g.lineWidth = 1;
    for (i = 0; i <= 5; i++) { x = Math.round(pad + i * 10 * stepW) + 0.5; g.beginPath(); g.moveTo(x, top - 3); g.lineTo(x, base); g.stroke(); }
    g.beginPath(); g.moveTo(0, base + 0.5); g.lineTo(w, base + 0.5); g.stroke();
    for (i = 0; i < NP; i++) {
      x = pad + i * stepW - bw / 2;
      var sh = shells[i];
      if (!sh) { g.fillStyle = 'rgba(147,160,168,0.25)'; g.fillRect(x, base - 2, bw, 2); continue; }
      var bh = max > 0 ? Math.max(1, sh.value / max * (base - top)) : 1;
      g.fillStyle = i === S.priceIdx ? '#f4b93a' : (i < S.priceIdx ? 'rgba(244,185,58,0.5)' : 'rgba(244,185,58,0.24)');
      g.fillRect(x, base - bh, bw, bh);
    }
    if (S.mode === 'dig' && userRep && max > 0) {
      var y = base - clamp(userRep.value / max, 0, 1) * (base - top);
      g.fillStyle = '#ff6f43'; g.fillRect(pad + S.priceIdx * stepW - bw / 2 - 3, y - 1.5, bw + 6, 3);
    }
    g.font = '10px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace'; g.fillStyle = 'rgba(147,160,168,0.95)'; g.textBaseline = 'top';
    g.textAlign = 'left'; g.fillText(w > 420 ? 'Best pit value at each gold price' : 'Best pit value by price', pad, 0);
    if (max > 0) { g.textAlign = 'right'; g.fillText('tallest ' + money(max), w - pad, 0); }
  }

  function refresh() { rebuildMesh(); updatePanels(); drawChart(); requestDraw(); }

  // ---------- solver workers ----------
  var pool = [];
  function workerSource() {
    var fns = [mulberry32, hash3, noise3, genLenses, genDeposit, blockValues, buildTopology, makeWorkspace, solvePit, checkPit, makeSolverHandler];
    return 'var TIERS=' + JSON.stringify(TIERS) + ',ECON=' + JSON.stringify(ECON) + ',OZ=' + OZ + ';\n' + fns.map(String).join('\n') +
      '\nvar handle=makeSolverHandler(function(m,t){postMessage(m,t||[]);});onmessage=function(e){handle(e.data);};';
  }
  function inlineSlot() {
    var slot = { busy: false, ready: false, active: true, dead: false, inline: true };
    var handle = makeSolverHandler(function (m) { setTimeout(function () { onMsg(slot, m); }, 0); });
    slot.post = function (m) { setTimeout(function () { handle(m); }, 30); };
    return slot;
  }
  function makePool() {
    var n = clamp((navigator.hardwareConcurrency || 2) - 1, 1, 4), url = null;
    try { url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })); } catch (e) { url = null; }
    for (var i = 0; url && i < n; i++) {
      try {
        (function () {
          var slot = { busy: false, ready: false, active: true, dead: false, w: new Worker(url) };
          slot.post = function (m) { slot.w.postMessage(m); };
          slot.w.onmessage = function (e) { onMsg(slot, e.data); };
          slot.w.onerror = function (e) { if (e && e.preventDefault) e.preventDefault(); workerDied(slot); };
          pool.push(slot);
        })();
      } catch (e) { break; }
    }
    if (!pool.length) pool.push(inlineSlot());
  }
  function workerDied(slot) {
    if (slot.dead) return;
    slot.dead = true; slot.active = false;
    if (slot.busy && slot.job >= 0) pending[slot.job] = false;
    slot.busy = false;
    var alive = pool.filter(function (s) { return !s.dead; });
    if (!alive.length) {           // workers are blocked here: solve on the page's own thread instead
      var s = inlineSlot(); pool.push(s);
      s.post({ type: 'init', seed: S.seed, nx: dep.nx, ny: dep.ny, nz: dep.nz, epoch: epoch });
    } else pump();
  }
  function onMsg(slot, m) {
    if (m.epoch !== epoch) return;
    if (m.type === 'ready') { slot.ready = true; dep.nArcs = m.nArcs; $('tArcs').textContent = int(m.nArcs); pump(); }
    else if (m.type === 'shell') {
      slot.busy = false; pending[m.idx] = false;
      if (!shells[m.idx]) solved++;
      shells[m.idx] = { pit: m.pit, value: m.value, flow: m.flow, sumPos: m.sumPos, feasible: m.feasible, ms: m.ms, phases: m.phases, blocks: m.blocks };
      if (m.idx === S.priceIdx || (S.mode === 'opt' && !shells[S.priceIdx])) refresh();
      else { drawChart(); $('tShells').textContent = solved + ' of ' + NP; }
      pump();
    } else if (m.type === 'error') {
      slot.busy = false;
      if (S.big) { notice('This device ran out of memory for 1.2 million blocks. Back to the standard deposit.'); S.big = false; loadDeposit(); }
      else notice('The solver stopped: ' + m.message + '. Reload the page to try again.');
    }
  }
  function nextJob() {
    for (var r = 0; r < NP; r++) {
      var a = S.priceIdx + r, b = S.priceIdx - r;
      if (a < NP && !shells[a] && !pending[a]) return a;
      if (b >= 0 && !shells[b] && !pending[b]) return b;
    }
    return -1;
  }
  function pump() {
    for (var i = 0; i < pool.length; i++) {
      var s = pool[i];
      if (!s.active || s.dead || !s.ready || s.busy) continue;
      var idx = nextJob(); if (idx < 0) return;
      s.busy = true; s.job = idx; pending[idx] = true;
      s.post({ type: 'solve', epoch: epoch, idx: idx, price: priceOf(idx) });
    }
  }

  // ---------- deposit ----------
  function loadDeposit(keep) {
    epoch++;
    var d = SIZES[S.big ? 'big' : 'std'], nx = d[0], ny = d[1], nz = d[2];
    var grade = genDeposit(S.seed, nx, ny, nz), cz = colorizeDeposit(grade, nx, ny, nz, S.seed);
    dep = { nx: nx, ny: ny, nz: nz, grade: grade, col: cz.col, ore: cz.ore, lenses: genLenses(S.seed, nx, ny, nz), nArcs: 0 };
    shells = []; pending = []; solved = 0;
    for (var i = 0; i < NP; i++) { shells.push(null); pending.push(false); }
    emptyPit = new Uint8Array(nx * ny); undo = []; userRep = null; hoverC = -1;
    userPit = keep && keep.userPit && keep.userPit.length === nx * ny ? Uint8Array.from(keep.userPit) : new Uint8Array(nx * ny);
    var L = dep.lenses, cut = Math.round(Math.min(L[1].cy, L[2].cy, L[3].cy));
    S.slice = keep && keep.slice >= 0 ? Math.min(keep.slice, ny - 12) : clamp(cut, 4, ny - 12);
    var sl = $('slice'); sl.max = ny - 12; sl.value = S.slice;
    $('depName').textContent = 'Deposit No. ' + ('000' + S.seed).slice(-4);
    $('dimTxt').textContent = int(nx * 15) + ' × ' + int(ny * 15) + ' × ' + int(nz * 15) + ' m';
    $('tBlocks').textContent = int(nx * ny * nz); $('tArcs').textContent = '...';
    $('goBig').textContent = S.big ? 'Back to 295K blocks' : 'Go big: 1.2M blocks';
    if (gl) { var bl = buildBoxLines(nx, ny, nz); nL = upload(bufL, bl, bl.length); }
    var active = S.big ? Math.min(2, pool.length) : pool.length, k = 0;
    pool.forEach(function (s) {
      if (s.dead) return;
      s.ready = false; s.busy = false; s.active = k < active; k++;
      s.post(s.active ? { type: 'init', seed: S.seed, nx: nx, ny: ny, nz: nz, epoch: epoch } : { type: 'free', epoch: epoch });
    });
    measure(); refresh();
  }

  // ---------- controls ----------
  function setPrice(i) {
    i = clamp(i | 0, 0, NP - 1);
    if (i === S.priceIdx) return;
    S.priceIdx = i; $('price').value = i;
    refresh(); pump();
  }
  function press(a, b, first) { a.setAttribute('aria-pressed', first ? 'true' : 'false'); b.setAttribute('aria-pressed', first ? 'false' : 'true'); }
  function setHint() {
    $('hint').textContent = S.mode === 'dig' ? 'Click the ground to dig. Walls cut back on their own. Drag to orbit.' : 'Slide the gold price or press play. Drag the rock to orbit.';
  }
  function setMode(m) {
    S.mode = m; app.setAttribute('data-mode', m); press($('mOpt'), $('mDig'), m === 'opt');
    hoverC = -1; setHint(); refresh();
  }
  function setView(v) {
    S.view = v; app.setAttribute('data-view', v); press($('vSolid'), $('vXray'), v === 'solid');
    $('slice').disabled = v !== 'solid';
    refresh();
  }
  function stopPlay() {
    if (playing) { clearInterval(playing); playing = null; }
    $('icoPlay').hidden = false; $('icoPause').hidden = true;
    $('play').setAttribute('aria-label', 'Sweep the gold price from low to high');
  }
  function startPlay() {
    if (S.priceIdx >= NP - 1) setPrice(0);
    $('icoPlay').hidden = true; $('icoPause').hidden = false;
    $('play').setAttribute('aria-label', 'Pause the price sweep');
    playing = setInterval(function () {
      if (S.priceIdx >= NP - 1) { stopPlay(); return; }
      if (shells[S.priceIdx + 1]) setPrice(S.priceIdx + 1);
    }, 150);
  }

  // ---------- pointer: orbit, zoom, dig ----------
  var ptrs = {}, drag = null, pinch = null;
  function nPtrs() { return Object.keys(ptrs).length; }
  function pinchDist() { var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; }
  function pickAt(cx, cy) {
    if (!dep) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return null;
    placeCamera();
    var t = Math.tan(FOV / 2), asp = r.width / r.height;
    var px = ((cx - r.left) / r.width * 2 - 1 - view.shiftX) * t * asp, py = (1 - (cy - r.top) / r.height * 2 - view.shiftY) * t;
    var B = camBasis(eye, target);
    return pickBlock(eye[0], eye[1], eye[2], B.f[0] + B.r[0] * px + B.u[0] * py, B.f[1] + B.r[1] * px + B.u[1] * py, B.f[2] + B.r[2] * px + B.u[2] * py,
      userPit, dep.nx, dep.ny, dep.nz, S.view === 'solid' ? S.slice : 0);
  }
  function digAtPointer(cx, cy) {
    var hit = pickAt(cx, cy); if (!hit) return;
    var want = Math.min(dep.nz, userPit[hit.c] + S.bite);
    if (want <= userPit[hit.c]) return;
    undo.push(userPit.slice()); if (undo.length > 80) undo.shift();
    digAt(userPit, hit.x, hit.y, want, dep.nx, dep.ny);
    hoverC = hit.c; refresh();
  }
  canvas.addEventListener('pointerdown', function (e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    stopSway();
    if (nPtrs() === 1) drag = { x: e.clientX, y: e.clientY, moved: 0 };
    else if (nPtrs() === 2) { drag = null; pinch = { d: pinchDist(), z: cam.zoom }; }
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = ptrs[e.pointerId];
    if (!p) {
      if (S.mode === 'dig' && e.pointerType === 'mouse') { var hit = pickAt(e.clientX, e.clientY); setHover(hit ? hit.c : -1); }
      return;
    }
    var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (pinch && nPtrs() === 2) { cam.zoom = clamp(pinch.z * pinch.d / pinchDist(), 0.3, 2.6); requestDraw(); return; }
    if (!drag) return;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 5) {
      cam.az -= dx * 0.0055; cam.el = clamp(cam.el + dy * 0.0045, 0.06, 1.5);
      canvas.style.cursor = 'grabbing'; requestDraw();
    }
  });
  function endPtr(e) {
    var had = !!ptrs[e.pointerId]; delete ptrs[e.pointerId];
    if (had && drag && drag.moved <= 5 && e.type === 'pointerup' && S.mode === 'dig') digAtPointer(e.clientX, e.clientY);
    if (nPtrs() < 2) pinch = null;
    if (nPtrs() === 0) { drag = null; canvas.style.cursor = ''; }
  }
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('pointerleave', function () { if (!nPtrs()) setHover(-1); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault(); stopSway();
    cam.zoom = clamp(cam.zoom * Math.exp(e.deltaY * 0.0012), 0.3, 2.6); requestDraw();
  }, { passive: false });
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', function () { if (initGL() && dep) { var bl = buildBoxLines(dep.nx, dep.ny, dep.nz); nL = upload(bufL, bl, bl.length); refresh(); } });

  $('price').addEventListener('input', function () { stopPlay(); setPrice(+this.value); });
  $('play').addEventListener('click', function () { if (playing) stopPlay(); else startPlay(); });
  $('mOpt').addEventListener('click', function () { setMode('opt'); });
  $('mDig').addEventListener('click', function () { stopPlay(); setMode('dig'); });
  $('vSolid').addEventListener('click', function () { setView('solid'); });
  $('vXray').addEventListener('click', function () { setView('xray'); });
  $('bite1').addEventListener('click', function () { S.bite = 1; press($('bite1'), $('bite4'), true); });
  $('bite4').addEventListener('click', function () { S.bite = 4; press($('bite1'), $('bite4'), false); });
  $('undo').addEventListener('click', function () { if (undo.length) { userPit = undo.pop(); refresh(); } });
  $('reset').addEventListener('click', function () { undo.push(userPit.slice()); userPit = new Uint8Array(dep.nx * dep.ny); refresh(); });
  $('slice').addEventListener('input', function () { S.slice = +this.value; stopSway(); rebuildMesh(); requestDraw(); });
  $('newDep').addEventListener('click', function () { stopPlay(); S.seed = 1 + Math.floor(Math.random() * 9998); loadDeposit(); });
  $('goBig').addEventListener('click', function () { stopPlay(); S.big = !S.big; loadDeposit(); });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && S.mode === 'dig' && undo.length) { e.preventDefault(); userPit = undo.pop(); refresh(); }
  });

  var relayout = function () { measure(); drawChart(); requestDraw(); };
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(app);
  window.addEventListener('resize', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  // ---------- start (keeps your place if the page is republished while open) ----------
  function start(data) {
    data = data || {};
    if (data.seed) {
      S.seed = data.seed | 0; S.big = !!data.big; S.priceIdx = clamp(data.priceIdx | 0, 0, NP - 1);
      S.mode = data.mode === 'dig' ? 'dig' : 'opt'; S.view = data.view === 'xray' ? 'xray' : 'solid';
    }
    if (!initGL()) {
      var p = document.createElement('p'); p.className = 'nogl';
      p.textContent = 'This browser has WebGL turned off, so the 3D view cannot draw. The solver and the numbers still work.';
      stage.appendChild(p); canvas.style.display = 'none';
    }
    makePool();
    $('price').value = S.priceIdx;
    app.setAttribute('data-mode', S.mode); press($('mOpt'), $('mDig'), S.mode === 'opt');
    app.setAttribute('data-view', S.view); press($('vSolid'), $('vXray'), S.view === 'solid');
    $('slice').disabled = S.view !== 'solid';
    setHint();
    loadDeposit(data.seed ? { slice: typeof data.slice === 'number' ? data.slice : -1, userPit: data.userPit } : null);
    if (cam.sway) requestAnimationFrame(tick);
  }
  var hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) {
    hot.snapshot(function () {
      var dug = false, i;
      for (i = 0; userPit && i < userPit.length; i++) if (userPit[i]) { dug = true; break; }
      return { seed: S.seed, big: S.big, priceIdx: S.priceIdx, mode: S.mode, view: S.view, slice: S.slice, userPit: dug ? Array.from(userPit) : null };
    });
  }
  if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();
