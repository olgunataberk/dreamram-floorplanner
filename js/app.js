// UI wiring: state, navigation up/down the hierarchy, layer toggles, parameter panel, metrics.
(function () {
  'use strict';
  const DR = window.DR;
  const $ = (id) => document.getElementById(id);

  // [key, label, palette colour, default on]
  const LAYERS = [
    { group: 'Hierarchy outlines', items: [
      ['channel', 'Channels', 'channel', true], ['pch', 'Pseudo-channels', 'pch', true], ['bg', 'Bank groups', 'bg', true],
      ['bank', 'Banks', 'bank', true], ['subarray', 'Subarrays', 'subarray', true],
    ] },
    { group: 'Bank internals', items: [
      ['mat', 'MAT cell arrays', 'mat', true], ['eccmat', 'ECC MATs (MD / OD)', 'eccmat', true],
      ['blsa', 'Bitline sense amps', 'blsa', true], ['swd', 'Sub-WL drivers (LWD)', 'swd', true],
      ['rowdec', 'Row decoder', 'rowdec', true], ['coldec', 'Column decoder', 'coldec', true],
      ['dummy', 'Dummy half-subarrays', 'dummy', true], ['salpbuf', 'SALP buffer subarrays', 'salpbuf', true],
      ['extrarow', 'Extra (+1) subarray row', 'extrarow', true],
    ] },
    { group: 'Die periphery', items: [
      ['ctrl', 'Bank control stripes', 'ctrl', true], ['ioctl', 'I/O control (per bank group)', 'ioctl', true],
      ['mbus', 'GBUS CTRL / periphery', 'mbus', true], ['tsvcmd', 'Command TSVs', 'tsvcmd', true],
      ['tsvdata', 'Data TSVs', 'tsvdata', true], ['tsvother', 'Power TSVs / KOZ', 'tsvother', true],
      ['tsvdots', 'Individual TSVs', 'tsvDot', true], ['tsvpurpose', 'Colour TSVs by purpose', 'tsvp', true],
    ] },
    { group: 'Wires', items: [
      ['wl', 'Wordlines (WL)', 'wl', false], ['bl', 'Bitlines (BL)', 'bl', false], ['mwl', 'Main wordlines (MWL, 1 per 8 WL)', 'mwl', false],
      ['csl', 'Column select (CSL)', 'csl', true], ['mdl', 'Main datalines (MDL)', 'mdl', true],
      ['ldl', 'Local datalines (LDL / LSL)', 'ldl', true], ['bgbus', 'Bank-group bus (BGBUS)', 'bgbus', false],
      ['gbus', 'Global bus (GBUS)', 'gbus', false],
    ] },
    { group: 'Overlays', items: [
      ['labels', 'Labels', 'text', true], ['pages', 'Row-page partitions', 'pages', true],
      ['coupled', 'Coupled-row halves', 'cpl', true], ['edgepair', 'Paired edge subarrays', 'edge', true],
      ['eccsym', 'OD-ECC codewords (A / B)', 'cw', false],
      ['path', 'Example ACT + RD path', 'path', false],
    ] },
  ];

  const NOTES = {
    die: 'Width = channels/die × pseudo-channels × horizontal BGs × (bank_x + control stripe). Height = banks + OD-ECC + MBUS + TSV region (Hbm.bankdie_dims, calc_stack_dims).',
    channel: 'Independent CA + DQ interface. Its pseudo-channels share the CA bus; banks sit above and below the TSV region (paper Fig. 2b).',
    pch: 'Pseudo-channel: separate command decoders, banks and DQs; shares the channel CA bus.',
    bg: 'Bank group: banks sharing one BG-BUS. Its I/O control block sits mid-group with the banks on either side mirrored toward it (Ryu et al., JSSC 2023, Fig. 3); the BG-BUS runs from there to the GBUS CTRL.',
    bank: 'bank_x = row-dec + cells + SWDs; bank_y = col-dec + cells + BLSAs (Hbm.bank_dims). The slot also holds the open-bitline dummy half-subarrays.',
    subarray: 'One row of MATs sharing a main wordline, with its BLSA stripe on the column-decoder side.',
    salpbuf: 'SALP-groups buffer subarray inserted between subarray groups to avoid adjacent-subarray conflicts (Hbm.bank_dims: + salp_groups − 1).',
    extrarow: 'DreamRAM sizes the cell array as subarrays + (SALP groups − 1) + repair + 1 rows; this is that +1 row (and its BLSA stripe).',
    mat: 'Cell array of wordlines × bitlines with isolation overheads. Routing over the MAT follows the MDL/CSL config (paper Fig. 3).',
    eccmat: 'ECC columns: (MD-ECC 1/16 + OD-ECC 1/8) × data bits per row, drawn as whole MATs. Each adds an SWD stripe.',
    blsa: 'Bitline sense-amp stripe. Height grows with BRVSA (×1.33), MDL drivers inside the BLSA (×1.26) and >8 LDLs (Hbm.blsa_height).',
    swd: 'Local wordline (sub-wordline) driver stripe; one between every pair of MATs, plus one per extra subchannel boundary.',
    conj: 'Where an SWD stripe crosses a BLSA stripe (counted in both bank_x and bank_y).',
    rowdec: 'Row decoder: 82.5 µm at 2y nm, scaled by (f/f₀)^0.9.',
    coldec: 'Column decoder: 150 µm at 2y nm, scaled by (f/f₀)^0.9. CSLs and MDLs terminate here.',
    corner: 'Corner between row and column decoders (part of the bank rectangle).',
    dummy: 'Open-bitline edge: two dummy half-subarrays per bank (Hbm.dummy_subarray_height).',
    ioctl: 'Bank-group I/O control (Ryu et al., JSSC 2023, Fig. 3): I/O sense amps and write drivers for the banks on both sides, the per-group OD-ECC + DBI logic (304 → 272 b + 32 DBI flags), and the BG-BUS drivers. Height = DreamRAM\'s per-group OD-ECC height (1% of the baseline bank, Hbm.od_ecc_height) unless the I/O-control height extension is set.',
    ctrl: 'Strip of 2 × row-decoder width per bank column ("ASSUME from die shot" in Hbm.bankdie_dims).',
    mbus: 'GBUS CTRL for this column (Ryu et al., Fig. 3): receives the BG-BUSes of the bank groups on this side and drives the two alternating GBUS sets (ADL). All GBUS CTRL rows together are DreamRAM\'s MBUS / periphery height, 0.55 × baseline bank height (Hbm.mbus_peri_height).',
    tsvregion: 'Rows of TSVs at max(µbump, TSV) pitch across the die width minus keep-out (Hbm.calc_stack_dims).',
    tsvcmd: 'AWORD block in the gap between a channel\'s mirrored pseudo-channel columns (Ryu et al., Fig. 3). It holds the command TSVs of every channel stacked at this position; this die\'s channel is drawn solid, pass-through channels faded. Block widths split the slice by TSV count, so total TSV area is DreamRAM\'s.',
    tsvdata: 'DWORD block under its pseudo-channel column (Ryu et al., Fig. 3), between the top and bottom GBUS CTRL. It holds this column\'s share of the data TSVs of every channel stacked at this position; this die\'s channel is drawn solid, pass-through channels faded.',
    tsvother: 'DreamRAM sizes power TSVs as 20% of the command + data TSV area, plus a keep-out band on each edge of the TSV region.',
  };

  const app = {
    params: Object.assign({}, DR.BASELINE),
    techKey: '16nm',
    theme: 'dark',
    layers: {},
    model: null,
    dies: new Map(),
    stackNode: null,
    currentDie: null,
    focus: null,
    selected: null,
    hover: null,
    stackHover: null,
    selectedDieIdx: 0,
    exportData: null,
    exportActive: false,
    _raf: 0,
    requestDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame((t) => {
        this._raf = 0;
        R.draw(t);
        if (R.anim) this.requestDraw();
      });
    },
    traceBank() {
      for (const n of [this.selected, this.focus]) {
        for (let a = n; a; a = a.parent) if (a.type === 'bank') return a;
      }
      // default: inside the focus, walk down to the top-half bank nearest the TSVs
      let n = this.focus && this.focus.type !== 'stack' ? this.focus : this.currentDie;
      const pick = { die: (k) => k.type === 'channel', channel: (k) => k.type === 'pch', pch: (k) => k.type === 'bg' && k.top, bg: (k) => k.type === 'bank' };
      while (n && pick[n.type]) {
        const kids = DR.children(n).filter(pick[n.type]);
        n = n.type === 'pch' || n.type === 'bg' ? kids[kids.length - 1] : kids[0];
      }
      return n && n.type === 'bank' ? n : null;
    },
  };
  window.app = app; // handy for console scripting: app.navigate(node), DR.children(app.focus)
  for (const g of LAYERS) for (const [k, , , on] of g.items) app.layers[k] = on;

  const R = new DR.Renderer($('cv'), app);
  Object.defineProperty(app, 'renderer', { value: R, writable: true });

  // ---------- model / tree ----------
  function getDie(i) {
    if (!app.dies.has(i)) {
      const d = DR.buildDie(app.model, i);
      d.parent = app.stackNode;
      app.dies.set(i, d);
    }
    return app.dies.get(i);
  }

  function pathNames(n) {
    return DR.ancestors(n).slice(1).map((a) => a.name);
  }

  function rebuild(keepView) {
    const oldPath = app.focus && app.focus.type !== 'stack' ? pathNames(app.focus) : null;
    const oldSel = app.selected && app.selected.type !== 'stack' ? pathNames(app.selected) : null;
    const wasStack = app.focus && app.focus.type === 'stack';
    app.model = DR.compute(app.params, app.techKey);
    app.dies = new Map();
    app.stackNode = { type: 'stack', name: 'Stack', parent: null, kids: null };
    app.selectedDieIdx = Math.min(app.selectedDieIdx, app.model.stack.dies - 1);
    app.currentDie = getDie(app.selectedDieIdx);
    app.hover = null;
    let focus = app.currentDie;
    if (wasStack) focus = app.stackNode;
    else if (oldPath) focus = resolve(oldPath) || app.currentDie;
    app.selected = oldSel ? resolve(oldSel) : null;
    navigate(focus, !keepView);
    updatePanels();
  }

  function resolve(names) {
    let n = app.currentDie;
    for (const nm of names.slice(1)) {
      const k = DR.children(n).find((c) => c.name === nm);
      if (!k) break;
      n = k;
    }
    return n;
  }

  function navigate(n, animate) {
    app.focus = n;
    hideTip();
    if (n.type !== 'stack') {
      const die = DR.ancestors(n).find((a) => a.type === 'die');
      if (die && die !== app.currentDie) app.currentDie = die;
      app.selectedDieIdx = app.currentDie.dieIdx;
      R.fitRect(n, animate !== false);
    }
    app.requestDraw();
    renderCrumbs();
    renderTree();
    renderInfo();
  }

  app.navigate = (n) => { app.selected = n; navigate(n); };

  function goUp() {
    const f = app.focus;
    if (!f || f.type === 'stack') return;
    app.selected = f;
    navigate(f.parent || app.stackNode);
  }

  function goDownToward(target) {
    if (!target) return;
    const chain = DR.ancestors(target);
    const i = chain.indexOf(app.focus);
    const next = i >= 0 ? chain[i + 1] : chain.find((a) => a.type !== 'stack' && a.type !== 'die') || target;
    if (!next) return;
    app.selected = next;
    navigate(next);
  }

  // ---------- canvas interaction ----------
  const cv = $('cv');
  let drag = null;
  cv.addEventListener('mousedown', (e) => {
    drag = { x: e.offsetX, y: e.offsetY, cx: R.cam.x, cy: R.cam.y, moved: false };
  });
  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const wasClick = !drag.moved;
    drag = null;
    cv.classList.remove('grab');
    if (wasClick && e.target === cv) onClick(e);
  });
  cv.addEventListener('mousemove', (e) => {
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved && app.focus.type !== 'stack') {
        cv.classList.add('grab');
        R.anim = null;
        R.cam.x = drag.cx - dx / R.cam.s;
        R.cam.y = drag.cy - dy / R.cam.s;
        hideTip();
        app.requestDraw();
        return;
      }
    }
    onHover(e);
  });
  cv.addEventListener('mouseleave', () => { app.hover = null; app.stackHover = null; hideTip(); app.requestDraw(); });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (app.focus.type === 'stack') return;
    R.anim = null;
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    R.zoomAt(e.offsetX, e.offsetY, f);
    onHover(e);
    app.requestDraw();
  }, { passive: false });
  cv.addEventListener('dblclick', (e) => {
    if (app.focus.type === 'stack') return;
    goDownToward(R.hit(e.offsetX, e.offsetY));
  });

  function onClick(e) {
    if (app.focus.type === 'stack') {
      const h = R.hitStack(e.offsetX, e.offsetY);
      if (h && !h.isBase) {
        app.selectedDieIdx = h.dieIdx;
        app.currentDie = getDie(h.dieIdx);
        app.selected = app.currentDie;
        navigate(app.currentDie);
      }
      return;
    }
    app.selected = R.hit(e.offsetX, e.offsetY);
    renderTree();
    renderInfo();
    app.requestDraw();
  }

  function onHover(e) {
    if (app.focus.type === 'stack') {
      const h = R.hitStack(e.offsetX, e.offsetY);
      const i = h ? h.i : null;
      if (i !== app.stackHover) { app.stackHover = i; app.requestDraw(); }
      if (h && h.isBase) showTip(e, '<b>Base (logic) die</b><br>Same footprint as a core die; counted in total area but not floorplanned by DreamRAM.');
      else if (h) showTip(e, `<b>Core die ${h.dieIdx}</b><br>Click to open the floorplan`);
      else hideTip();
      cv.style.cursor = h && !h.isBase ? 'pointer' : 'default';
      return;
    }
    cv.style.cursor = '';
    const n = R.hit(e.offsetX, e.offsetY);
    if (n !== app.hover) { app.hover = n; app.requestDraw(); }
    const w = R.hitWire(e.offsetX, e.offsetY);
    if (w) return showTip(e, wireTip(w));
    if (n) showTip(e, nodeTip(n));
    else hideTip();
  }

  function wireTip(w) {
    const m = app.model, p = m.p, pr = m.pitch;
    const names = {
      wl: 'Wordline', bl: 'Bitline', mwl: 'Main wordline', csl: 'Column select line', mdl: 'Main dataline', ldl: 'Local dataline',
      bgbus: 'Bank-group bus', gbus: 'Global bus',
    };
    if (w.kind === 'tsv') {
      const own = w.ch === null ? '' : w.ch >= app.currentDie.chBase && w.ch < app.currentDie.chBase + p.ch_per_die ? ' (this die)' : ' (passes through)';
      const q = w.part;
      return `<b>${w.tsvKind === 'power' ? 'Power TSV' : `${q.label} TSV`}</b>${w.ch === null ? '' : ` · CH${w.ch}${own}`}`
        + (q.note ? `<br><span class="mono">${esc(q.note)}</span>` : '');
    }
    let t = `<b>${w.label || names[w.kind]}</b>`;
    if (w.total) t += ` <span class="mono">#${w.idx} of ${w.total}</span>`;
    if (w.kind === 'csl') t += `<br>Selects ${p.ldls_mdls} BLs onto the LDLs · pitch ${pr.csl_to_bl.toFixed(2)} BL (${pr.csl_ratio.toFixed(2)}× baseline)`;
    if (w.kind === 'mdl') t += `<br>${p.ldls_mdls} differential pairs / MAT · pitch ${pr.mdl_to_bl.toFixed(2)} BL (${pr.mdl_ratio.toFixed(2)}× baseline)${w.idx % 2 ? ' · complement' : ''}`;
    if (w.kind === 'ldl') t += `<br>${w.label === 'LSL' ? 'DLOMAT: former LDLs carry column selects to the BLSAs' : 'BLSA → MDL'} · along the BLSA stripe`;
    if (w.kind === 'bgbus') t += `<br>I/O control → GBUS CTRL · ${m.wires.bgbus} b data + metadata (DreamRAM) + ${Math.round(m.wires.bgbus * (m.t.dbi - 1))} DBI flags`;
    if (w.kind === 'gbus') t += `<br>${m.wires.gbus} b · GBUS CTRL → DWORD TSVs · ${p.bgbuses_per_gbus} sets alternate per column command (ADL)`;
    return t;
  }

  function nodeTip(n) {
    const T = DR.TYPES[n.type] || {};
    return `<b>${esc(n.name)}</b><br><span class="mono">${T.label || n.type} · ${DR.fmtLen(n.w)} × ${DR.fmtLen(n.h)}</span>`;
  }

  const tip = $('tip');
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const st = cv.getBoundingClientRect();
    let x = e.offsetX + 14, y = e.offsetY + 14;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > st.width - 6) x = e.offsetX - tw - 10;
    if (y + th > st.height - 6) y = e.offsetY - th - 10;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.hidden = true; }

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); goUp(); }
    else if (e.key === 'Enter' && app.selected) goDownToward(app.selected);
    else if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === 'l' || e.key === 'L') { app.layers.labels = !app.layers.labels; renderLayers(); app.requestDraw(); }
  });

  function fit() { if (app.focus.type !== 'stack') R.fitRect(app.focus, true); }

  // ---------- panels ----------
  function swatch(type) {
    const P = DR.PALETTES[app.theme];
    const c = P[type] || (type === 'tsvregion' ? P.tsvdata : type === 'die' ? P.bank : P.textDim);
    return `<span class="sw" style="background:${c}"></span>`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function crumbLabel(n) {
    switch (n.type) {
      case 'stack': return `Stack (${app.model.stack.dies}+1 dies)`;
      case 'die': return `Die ${n.dieIdx}`;
      case 'channel': return n.name;
      case 'pch': return 'PC' + n.pcIdx;
      case 'bg': return n.bgName;
      case 'bank': return 'Bank ' + n.bankIdx;
      default: return n.name;
    }
  }

  function renderCrumbs() {
    const el = $('crumbs');
    el.innerHTML = '';
    const chain = app.focus.type === 'stack' ? [app.stackNode] : DR.ancestors(app.focus);
    chain.forEach((n, i) => {
      if (i) el.insertAdjacentHTML('beforeend', '<span class="sep">›</span>');
      const a = document.createElement('a');
      a.textContent = crumbLabel(n);
      if (n === app.focus) a.className = 'cur';
      a.onclick = () => navigate(n);
      el.appendChild(a);
    });
    $('btn-up').disabled = app.focus.type === 'stack';
  }

  function treeRow(n, depth, isCur) {
    const d = document.createElement('div');
    d.className = 't' + (isCur ? ' cur' : '') + (n === app.selected ? ' sel' : '');
    d.style.paddingLeft = 4 + depth * 12 + 'px';
    const kids = n.type === 'stack' ? app.model.stack.dies : null;
    d.innerHTML = `${n.type === 'stack' ? '' : swatch(n.type)}<span>${esc(crumbLabel(n))}</span>${kids ? `<span class="cnt">${kids} dies</span>` : ''}`;
    d.onclick = () => {
      if (n.type === 'stack' || isCur) return navigate(n);
      app.selected = n;
      navigate(n);
    };
    d.onmouseenter = () => { if (n.type !== 'stack') { app.hover = n; app.requestDraw(); } };
    d.onmouseleave = () => { app.hover = null; app.requestDraw(); };
    return d;
  }

  function renderTree() {
    const el = $('tree');
    el.innerHTML = '';
    const chain = app.focus.type === 'stack' ? [app.stackNode] : DR.ancestors(app.focus);
    chain.forEach((n, i) => el.appendChild(treeRow(n, i, n === app.focus)));
    const depth = chain.length;
    let kids;
    if (app.focus.type === 'stack') kids = Array.from({ length: app.model.stack.dies }, (_, i) => getDie(i));
    else kids = DR.children(app.focus);
    // group children by type; long groups collapse into a <details>
    const groups = new Map();
    for (const k of kids) {
      if (!groups.has(k.type)) groups.set(k.type, []);
      groups.get(k.type).push(k);
    }
    for (const [type, list] of groups) {
      if (list.length <= 10) list.forEach((k) => el.appendChild(treeRow(k, depth, false)));
      else {
        const det = document.createElement('details');
        det.style.paddingLeft = depth * 12 + 'px';
        if (list.includes(app.selected)) det.open = true;
        const T = DR.TYPES[type] || {};
        det.innerHTML = `<summary>${swatch(type)} ${list.length} × ${esc(T.label || type)}</summary>`;
        list.forEach((k) => det.appendChild(treeRow(k, 1, false)));
        el.appendChild(det);
      }
    }
  }

  function renderLayers() {
    const el = $('layers');
    el.innerHTML = '';
    const P = DR.PALETTES[app.theme];
    for (const g of LAYERS) {
      const box = document.createElement('div');
      box.className = 'grp';
      const h = document.createElement('div');
      h.className = 'grp-h';
      h.innerHTML = `<span>${g.group}</span>`;
      const tog = document.createElement('button');
      const allOn = g.items.every(([k]) => app.layers[k] !== false);
      tog.textContent = allOn ? 'hide' : 'show';
      tog.onclick = () => { g.items.forEach(([k]) => (app.layers[k] = !allOn)); renderLayers(); updateArea(); app.requestDraw(); };
      h.appendChild(tog);
      box.appendChild(h);
      for (const [k, label, colKey] of g.items) {
        const lab = document.createElement('label');
        const col = k === 'eccsym' ? `linear-gradient(90deg, ${P.cw[0]} 50%, ${P.cw[1]} 50%)` : k === 'tsvpurpose' ? `linear-gradient(90deg, ${['ra', 'ca', 'dq', 'ecc', 'dbi', 'pwr'].map((q) => P.tsvp[q]).join(',')})` : k === 'pages' ? `linear-gradient(90deg, ${P.pages.slice(0, 4).join(',')})` : k === 'coupled' ? `linear-gradient(90deg, ${P.cpl[0]} 50%, ${P.cpl[1]} 50%)` : P[colKey];
        lab.innerHTML = `<input type="checkbox" ${app.layers[k] !== false ? 'checked' : ''}><span class="sw" style="background:${col}"></span>${label}`;
        if (k === 'pages' && app.model) lab.insertAdjacentHTML('beforeend', `<span class="note">${app.model.pages.ind_row_pages}</span>`);
        if (k === 'coupled' && app.model) lab.insertAdjacentHTML('beforeend', `<span class="note">${app.model.p.coupled_rows > 1 ? app.model.p.coupled_rows + '/WL' : 'off'}</span>`);
        if (k === 'edgepair' && app.model) lab.insertAdjacentHTML('beforeend', `<span class="note">${app.model.p.edge_pairing ? 'on' : 'off'}</span>`);
        lab.querySelector('input').onchange = (e) => { app.layers[k] = e.target.checked; renderLayers(); updateArea(); app.requestDraw(); };
        box.appendChild(lab);
      }
      el.appendChild(box);
    }
  }
  document.querySelectorAll('[data-layers]').forEach((b) => (b.onclick = () => {
    const on = b.dataset.layers === 'all';
    for (const k in app.layers) if (k !== 'path') app.layers[k] = on;
    if (!on) app.layers.labels = true;
    renderLayers(); updateArea(); app.requestDraw();
  }));

  const fmt = (v, d) => (v === undefined || v === null || !isFinite(v) ? '–' : (+v).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 2 : d }));
  const pct = (f) => (f >= 0.01 ? fmt(100 * f, 2) : (100 * f).toPrecision(2)) + ' %';
  const kv = (rows) => rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('');

  // Host-visible row numbers stored on a subarray row's wordlines (one entry per coupled half).
  // MSB coupling: Row[w] ↔ Row[w + N/2]; LSB coupling: Row[2w] ↔ Row[2w+1]. Ignores half-page splits.
  function hostRows(row) {
    const p = app.model.p;
    if (!row || row.kind !== 'subarray') return null;
    const C = p.coupled_rows, Rp = p.subarrays * p.mat_rows; // physical wordlines per bank
    const w0 = row.idx * p.mat_rows, w1 = w0 + p.mat_rows - 1;
    return Array.from({ length: C }, (_, h) => p.coupled_lsb
      ? `Row[${C * w0 + h}], Row[${C * (w0 + 1) + h}], … Row[${C * w1 + h}]`
      : `Row[${h * Rp + w0}–${h * Rp + w1}]`);
  }

  // Capacity (data bits, no ECC, binary units as in Hbm.capacity) and row counts for `banks` banks.
  // Host rows are what the controller addresses (row page = physical row / ind_pages, which includes
  // subchannels, half-page and coupled rows); wordlines are the physical rows.
  function capRows(banks) {
    const p = app.model.p, pg = app.model.pages;
    const wlPerBank = p.subarrays * p.mat_rows;
    const bits = banks * wlPerBank * p.mats * p.mat_cols;
    const host = bits / pg.page_bits;
    const out = [['Capacity', fmtBits(bits)], ['Host rows', `${fmtCount(host)} × ${fmtBytes(pg.page_bits / 8)}`]];
    if (pg.page_bits !== pg.phys_row_bits) out.push(['Wordlines', `${fmtCount(banks * wlPerBank)} × ${fmtBytes(pg.phys_row_bits / 8)}`]);
    return out;
  }
  function fmtBits(b) {
    const units = [['Gb', 2 ** 30], ['Mb', 2 ** 20], ['Kb', 2 ** 10]];
    const [u, d] = units.find(([, d]) => b >= d) || ['b', 1];
    return `${fmt(b / d, 2)} ${u} <small>(${fmt(b / 2 ** 33, b >= 2 ** 33 ? 2 : 4)} GB)</small>`;
  }
  function fmtCount(n) {
    if (n >= 2 ** 20 && n % 2 ** 20 === 0) return `${n / 2 ** 20} M`;
    if (n >= 2 ** 10 && n % 2 ** 10 === 0) return `${n / 2 ** 10} K`;
    return fmt(n, 0);
  }
  function fmtBytes(B) { return B >= 1024 && B % 1024 === 0 ? `${B / 1024} KiB` : `${fmt(B, 0)} B`; }

  // TSV allocation by purpose (Hbm.calc_stack_dims terms): per channel and for the whole stack. Every die's
  // TSV array carries all channels of the stack; only this die's channels terminate on it.
  function tsvBreakdown(groups, perChannelOnly) {
    const m = app.model, s = m.stack, P = DR.PALETTES[app.theme], C = m.p.channels;
    const num = (x) => (Math.abs(x - Math.round(x)) < 1e-9 ? fmt(x, 0) : fmt(x, 2));
    const section = {
      cmd: ['Command', s.tsv_cmd],
      data: ['Data', s.tsv_data],
      power: ['Power', [{ key: 'pwr', label: 'Power / ground', note: '20% of signal-TSV area', perCh: s.power_tsv_count / C }]],
    };
    let h = `<table class="val tsvt"><tr><th>Purpose</th><th>/ ch</th>${perChannelOnly ? '' : `<th>× ${C} ch</th><th>%</th>`}</tr>`;
    const total = s.cmd_tsv_count + s.data_tsv_count + s.power_tsv_count;
    for (const g of groups) {
      const [title, parts] = section[g];
      const sub = parts.reduce((a, q) => a + q.perCh, 0);
      h += `<tr class="grp"><td>${title}</td><td>${num(sub)}</td>${perChannelOnly ? '' : `<td>${num(sub * C)}</td><td>${fmt(100 * sub * C / total, 1)}</td>`}</tr>`;
      for (const q of parts) {
        h += `<tr title="${esc(q.note || '')}"><td><span class="sw" style="background:${P.tsvp[q.key]}"></span>${q.label}</td><td>${num(q.perCh)}</td>${perChannelOnly ? '' : `<td>${num(q.perCh * C)}</td><td>${fmt(100 * q.perCh * C / total, 1)}</td>`}</tr>`;
      }
    }
    if (groups.length > 1 && !perChannelOnly) h += `<tr class="grp"><td>Total</td><td>${num(total / C)}</td><td>${num(total)}</td><td>100</td></tr>`;
    return h + '</table>';
  }

  // Where a MAT's bits land in the two OD-ECC codewords of one access
  function eccWhere(col) {
    const e = DR.eccLayout(app.model), segs = Math.max(1, Math.round(e.spm));
    if (segs === 1) return `codeword ${DR.codeword(e.spm, col.acc, 0)}, symbol ${Math.floor(col.acc / 2)} of ${fmt(e.n, 1)}`;
    return `${segs} symbols: ${Array.from({ length: segs }, (_, k) => DR.codeword(e.spm, col.acc, k)).join(' + ')} (access position ${col.acc})`;
  }

  function renderInfo() {
    const el = $('info');
    const n = app.selected || app.focus;
    const m = app.model, p = m.p, b = m.bank, s = m.stack;
    if (!n || n.type === 'stack') {
      el.innerHTML = `<div class="title">Stack</div><div class="type">${m.stack.dies} core dies + 1 base die</div>
        <div class="kv">${kv([...capRows(m.banksPerDie * m.stack.dies), ['SIDs', p.sids], ['Channels', p.channels], ['Dies per SID', p.channels / p.ch_per_die], ['Total area', fmt(m.totalArea, 1) + ' mm²']])}</div>
        <div class="note">Channels of different SIDs are stacked on separate dies and share TSVs (paper Fig. 2a).</div>`;
      return;
    }
    const T = DR.TYPES[n.type] || {};
    const area = n.w * n.h;
    const rows = [
      ['Size', `${DR.fmtLen(n.w)} × ${DR.fmtLen(n.h)}`],
      ['Area', area > 1e5 ? fmt(area / 1e6, 3) + ' mm²' : fmt(area, 1) + ' µm²'],
      ['Of die', pct(area / (s.die_w * s.die_h))],
    ];
    const per = (x) => fmt(x, 0);
    const cap = (banks) => capRows(banks);
    const ecc = DR.eccLayout(m);
    switch (n.type) {
      case 'die': rows.push(...cap(m.banksPerDie), ['Banks', m.banksPerDie], ['Cell efficiency', fmt(100 * m.cellEff, 1) + ' %'], ['Channels', `CH${n.chBase}–CH${n.chBase + p.ch_per_die - 1}`]); break;
      case 'channel': rows.push(...cap(p.pch * p.horiz_bg * p.vert_bg * p.banks), ['Pseudo-channels', p.pch], ['Banks', p.pch * p.horiz_bg * p.vert_bg * p.banks], ['DQs', per(m.wires.dq_count / p.channels)]); break;
      case 'pch': rows.push(...cap(p.horiz_bg * p.vert_bg * p.banks), ['Bank groups', p.horiz_bg * p.vert_bg], ['Banks', p.horiz_bg * p.vert_bg * p.banks], ['DQs', per(m.wires.dq_count / p.channels / p.pch)]); break;
      case 'bg': rows.push(...cap(p.banks), ['Banks', `${p.banks} (${Math.ceil(p.banks / 2)} | I/O ctrl | ${p.banks - Math.ceil(p.banks / 2)})`], ['BG-BUS width', m.wires.bgbus + ' b + DBI'],
        ...(m.timing ? [['Data rate', `${fmt(m.timing.bg_rate, 1)} GB/s <small>one atom / tCCD_L = ${fmt(m.timing.tccdl, 2)} ns</small>`], ['Share of PC peak', fmt(100 * m.timing.bg_rate / m.timing.pc_rate, 0) + ' %']] : [])); break;
      case 'ioctl': rows.push(['Serves', `${p.banks} banks (${Math.ceil(p.banks / 2)} above, ${p.banks - Math.ceil(p.banks / 2)} below)`], ['Bits / access', `${ecc.active * p.ldls_mdls} (${ecc.active} MATs × ${p.ldls_mdls})`], ['BG-BUS out', m.wires.bgbus + ' b + DBI'], ['Height', DR.fmtLen(s.od_ecc_h) + (p.ioctl_h > 0 ? ' (extension)' : ' (DreamRAM OD-ECC)')]); break;
      case 'mbus': rows.push(['GBUS sets', `${p.bgbuses_per_gbus} × ${m.wires.gbus} b (ADL)`], ['Bank groups in', n.half === 'top' ? Math.ceil(p.vert_bg / 2) : p.vert_bg - Math.ceil(p.vert_bg / 2)]); break;
      case 'bank': rows.push(...cap(1), ['bank_x × bank_y', `${fmt(b.bank_x, 1)} × ${fmt(b.bank_y, 1)} µm`], ['Subarrays', `${p.subarrays} (+${b.rows - p.subarrays} rows)`], ['MATs / subarray', `${p.mats} + ${b.ecc_mats} ECC`], ['SWD stripes', b.swd_count], ['Bank cell eff.', fmt(100 * b.cell_area_bank / (b.bank_x * b.bank_y), 1) + ' %'], ['Row page', `${m.pages.page_bits / 8} B × ${m.pages.ind_row_pages}`]); break;
      case 'subarray': case 'salpbuf': case 'extrarow': {
        rows.push(['MATs', `${p.mats} + ${b.ecc_mats} ECC`], ['Wordlines', p.mat_rows], ['BLSA height', DR.fmtLen(b.blsa_h)], ['Row pages', m.pages.ind_row_pages]);
        const hr = hostRows(n.row);
        if (hr) hr.forEach((r, h) => rows.push([p.coupled_rows > 1 ? `Host rows (${['blue', 'rose', 'green', 'gold'][h]})` : 'Host rows', r]));
        if (n.row.edge) rows.push(['Edge half', `${n.row.edge === 'far' ? 'even' : 'odd'} bitlines live; pairs with the ${n.row.edge === 'far' ? 'column-decoder-side' : 'far'} edge`]);
        break;
      }
      case 'mat': {
        const hr = hostRows(n.sa.row);
        if (hr) rows.push([p.coupled_rows > 1 ? 'Host rows (this half)' : 'Host rows', hr[n.col.cpl || 0]]);
        if (hr && p.coupled_rows > 1) rows.push(['Coupled with', hr.filter((_, h) => h !== (n.col.cpl || 0)).join(', ')]);
      }
      if (n.rowKind === 'subarray') rows.push(['OD-ECC', eccWhere(n.col)]);
      rows.push(['WL × BL', `${p.mat_rows} × ${p.mat_cols}`], ['Capacity', `${p.mat_rows * p.mat_cols / 1024} Kib`], ['Row page', n.col.page], ['Subchannel', n.col.sc], ['MDLs', `${p.ldls_mdls} pairs`], ['CSLs', fmt(m.pitch.csl_count, 0)], ['Routing', { 0: 'MDL/SWD · CSL/MAT', 1: 'DLOMAT', 3: p.csl_mdl_shared_layer ? 'MDL+CSL/MAT, shared' : 'MDL+CSL/MAT, 2 layers' }[p.mdlcsl]], ['Cell eff. (MAT)', fmt(100 * (b.mat_w * b.mat_h) / ((b.mat_w + b.swd_w) * (b.mat_h + b.blsa_h)), 1) + ' %']); break;
      case 'eccmat': rows.push(['Kind', n.col.ecc], ['Bits / row', fmt(n.col.w / (m.t.pitch_bl * m.t.iso_cols), 0)], ['OD-ECC', eccWhere(n.col)]); break;
      case 'blsa': rows.push(['Height', DR.fmtLen(b.blsa_h)], ['Sense amp', p.brvsa ? 'BRVSA / OCSA' : 'BLSA']); break;
      case 'swd': {
        rows.push(['Width', DR.fmtLen(b.swd_w)], ['Stripes / row', b.swd_count]);
        // a driver fault hits the local wordline in both neighbouring MATs (Ryu et al., Fig. 5b)
        const [l, r] = n.between || [];
        if (l && r && n.sa.row.kind === 'subarray') {
          const name = (c) => (c.kind === 'mat' ? 'MAT ' + c.idx : 'ECC ' + c.idx);
          const sym = (c) => Array.from({ length: Math.max(1, Math.round(ecc.spm)) }, (_, k) => DR.codeword(ecc.spm, c.acc, k));
          // MATs read by different column accesses (subchannels, half pages, coupled rows) are decoded apart
          const groups = l.grp === r.grp ? [[l, r]] : [[l], [r]];
          const verdicts = groups.map((cs) => {
            const per = { A: 0, B: 0 };
            for (const c of cs) for (const w of sym(c)) per[w]++;
            return { per, ok: per.A <= 1 && per.B <= 1 };
          });
          const ok = verdicts.every((v) => v.ok);
          rows.push(['Driver fault hits', `${name(l)} + ${name(r)} = ${2 * p.ldls_mdls} b${groups.length > 1 ? ' (in two different accesses)' : ''}`],
            ['Symbols / codeword', `${verdicts.map((v) => `A: ${v.per.A}, B: ${v.per.B}`).join('; ')} → ${ok ? 'correctable' : 'not correctable'} by RS(${ecc.n},${ecc.k})`]);
        } else if (l || r) rows.push(['Driver fault hits', 'one MAT (edge or subchannel boundary)']);
        break;
      }
      case 'tsvcmd': case 'tsvdata': rows.push(['TSVs in block', fmt(n.count, 1)], ['Channels', n.chs.map((c) => 'CH' + c).join(', ')], ['Grid pitch', s.tsv_grid_pitch + ' µm']); break;
      case 'tsvregion': rows.push(['TSVs', per(s.cmd_tsv_count + s.data_tsv_count + s.power_tsv_count)], ['Pitch', s.tsv_grid_pitch + ' µm (max of µbump, TSV)']); break;
      case 'tsvother': rows.push(['Power TSVs', per(n.count)], ['Keep-out band', DR.fmtLen(m.t.tsv_koz)]); break;
    }
    const canGo = n !== app.focus && (n.gen || (n.kids && n.kids.length));
    const tsvTable = { tsvregion: ['cmd', 'data', 'power'], tsvcmd: ['cmd'], tsvdata: ['data'], tsvother: ['power'], channel: ['cmd', 'data'] }[n.type];
    el.innerHTML = `<div class="title">${esc(n.name)}</div><div class="type">${swatch(n.type)}${T.label || n.type}</div>
      <div class="kv">${kv(rows)}</div>${tsvTable ? tsvBreakdown(tsvTable, n.type === 'channel') : ''}${NOTES[n.type] ? `<div class="note">${NOTES[n.type]}</div>` : ''}
      <div class="actions">${canGo ? '<button id="act-into">Go into ↓</button>' : ''}${n !== app.focus ? '<button id="act-zoom">Zoom to</button>' : ''}${n.layer || T.layer ? `<button id="act-hide">Hide ${esc((T.label || '').toLowerCase())}s</button>` : ''}</div>`;
    const into = $('act-into'), zoom = $('act-zoom'), hide = $('act-hide');
    if (into) into.onclick = () => navigate(n);
    if (zoom) zoom.onclick = () => R.fitRect(n, true, 0.3);
    if (hide) hide.onclick = () => { app.layers[T.layer] = false; renderLayers(); updateArea(); app.requestDraw(); };
  }

  function renderMetrics() {
    const m = app.model, p = m.p, s = m.stack, tm = m.timing;
    const ex = app.exportActive ? app.exportData.metrics || {} : {};
    const rows = [
      ['Capacity (stack)', fmt(m.capacity, 3) + ' GB'],
      ['Bandwidth', tm ? fmt(tm.bw, 1) + ' GB/s' + (tm.bw < tm.bw_peak - 1e-9 ? ` <small>capped by bank groups (peak ${fmt(tm.bw_peak, 1)})</small>` : '') : '–'],
      ['Row-miss latency', tm ? fmt(tm.latency, 1) + ' ns <small>tCL+tRCD+tRP</small>' : '–'],
      ['DQ rate', tm ? fmt(tm.dq_rate, 2) + ' Gb/s' : '–'],
      ...(tm ? [
        ['tCCD_L / tCCD_S', `${fmt(tm.tccdl, 2)} / ${fmt(tm.tccds, 2)} ns`],
        ['Column cycle stages', `bank ${fmt(tm.tck_bank, 2)} · BG-BUS ${fmt(tm.tck_bgbus, 2)} ns <small>${p.tccd_bgbus ? 'limited by ' + tm.limiter : (tm.tck_bgbus > tm.tck_bank ? 'BG-BUS slower, not enforced' : 'bank path sets it')}</small>`],
        ['Fixed share of cycle', `${fmt(tm.tck_fixed, 2)} ns <small>driver / sense / precharge, not wire-scaled</small>`],
        ...tm.levels.map((l) => [`${l.label} / PC`, `${fmt(l.wires, 0)} × ${fmt(l.rate, 2)} Gb/s <small>= ${fmt(l.wires * l.rate / 8, 1)} GB/s</small>`]),
        ['Per bank group', `${fmt(tm.bg_rate, 1)} GB/s <small>${p.atom_size} b / tCCD_L</small>`],
        ['Per pseudo-channel', `${fmt(tm.pc_rate, 1)} GB/s <small>needs ${fmt(tm.bgs_needed, 1)} BGs, has ${tm.bgs_per_pc}</small>`
          + (tm.bgs_per_pc < tm.bgs_needed - 1e-9 ? ' <span class="warn" title="Peak bandwidth assumes bank groups alternating every tCCD_S; with fewer groups a pseudo-channel tops out at bank groups × per-group rate.">⚠</span>' : '')],
      ] : []),
    ];
    if (ex.metric_e_per_bit_closed !== undefined) {
      rows.push(['Energy/bit (closed)', fmt(ex.metric_e_per_bit_closed, 3) + ' pJ'], ['Energy/bit (stream)', fmt(ex.metric_e_per_bit_seq, 3) + ' pJ'], ['Worst-case power', fmt(ex.worst_power_w, 1) + ' W']);
    }
    rows.push(
      ['Die', `${fmt(s.die_w / 1000, 3)} × ${fmt(s.die_h / 1000, 3)} mm`],
      ['Stack area', fmt(m.totalArea, 1) + ' mm² <small>(' + (s.dies + 1) + ' dies)</small>'],
      ['Cell efficiency', fmt(100 * m.cellEff, 1) + ' %'],
      ['Banks / die', m.banksPerDie],
      ['Row page', `${m.pages.page_bits / 8} B <small>× ${m.pages.ind_row_pages} indep.</small>`],
      ...(p.coupled_rows > 1 ? [['Physical wordline', `${m.pages.phys_row_bits / 8 / m.pages.ind_row_pages} B <small>= ${p.coupled_rows} coupled rows</small>`]] : []),
      ['Pumps / atom', fmt(m.pumps, 0)],
      ['OD-ECC', (() => { const e = DR.eccLayout(m); return `2 × RS(${fmt(e.n, 1)},${fmt(e.k, 1)}) <small>sub-WL fault ${e.correctable ? '✓' : '✗'}</small>`; })()],
      ['DQs', m.wires.dq_count],
      ['Bank', `${fmt(m.bank.bank_x, 0)} × ${fmt(m.bank.bank_y, 0)} µm`],
    );
    $('metrics').innerHTML = kv(rows);
    if (!ex.metric_e_per_bit_closed) $('metrics').insertAdjacentHTML('beforeend', '<div class="k" style="grid-column:1/-1;font-size:11.5px;margin-top:4px">Energy needs a DreamRAM export (tools/export_floorplan.py).</div>');
  }

  const AREA_LAYERS = { cells: ['mat'], ecc: ['eccmat'], extrarow: ['extrarow', 'salpbuf'], blsa: ['blsa'], swd: ['swd'], rowdec: ['rowdec'], coldec: ['coldec'], dummy: ['dummy'], ctrl: ['ctrl'], ioctl: ['ioctl'], mbus: ['mbus'], tsv: ['tsvcmd', 'tsvdata', 'tsvother'] };
  const AREA_COLOR = { cells: 'mat', ecc: 'eccmat', extrarow: 'extrarow', blsa: 'blsa', swd: 'swd', rowdec: 'rowdec', coldec: 'coldec', dummy: 'dummy', ctrl: 'ctrl', ioctl: 'ioctl', mbus: 'mbus', tsv: 'tsvdata' };
  function updateArea() {
    const P = DR.PALETTES[app.theme];
    const parts = DR.areaBreakdown(app.model);
    const bar = parts.map((q) => `<span title="${q.label} ${fmt(100 * q.frac, 1)}%" style="width:${100 * q.frac}%;background:${P[AREA_COLOR[q.key]]}"></span>`).join('');
    const leg = parts.map((q) => {
      const off = AREA_LAYERS[q.key].every((k) => app.layers[k] === false);
      return `<div class="l${off ? ' off' : ''}" data-k="${q.key}" title="Click to show/hide"><span class="sw" style="background:${P[AREA_COLOR[q.key]]}"></span>${q.label}</div><div class="p">${fmt(100 * q.frac, 1)}%</div>`;
    }).join('');
    $('area').innerHTML = `<div class="bar">${bar}</div><div class="legend">${leg}</div>`;
    $('area').querySelectorAll('.l').forEach((d) => (d.onclick = () => {
      const keys = AREA_LAYERS[d.dataset.k];
      const on = keys.every((k) => app.layers[k] === false);
      keys.forEach((k) => (app.layers[k] = on));
      renderLayers(); updateArea(); app.requestDraw();
    }));
  }

  function renderParams() {
    const el = $('params');
    el.innerHTML = '';
    const p = DR.normalize(app.params);
    for (const g of DR.PARAMS) {
      el.insertAdjacentHTML('beforeend', `<div class="pg">${g.group}</div>`);
      for (const [key, label, values] of g.items) {
        const row = document.createElement('div');
        row.className = 'row' + (p[key] !== DR.normalize({})[key] ? ' changed' : '');
        const opts = values.map((v) => (Array.isArray(v) ? v : [v, String(v)]));
        if (!opts.some(([v]) => v === p[key])) opts.push([p[key], String(p[key])]);
        row.innerHTML = `<label>${label}</label><select aria-label="${label}">${opts.map(([v, l]) => `<option value="${v}" ${v === p[key] ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        row.querySelector('select').onchange = (e) => setParam(key, +e.target.value);
        el.appendChild(row);
      }
    }
    const tech = $('tech');
    tech.innerHTML = Object.entries(DR.TECH_PRESETS).map(([k, t]) => `<option value="${k}" ${k === app.techKey ? 'selected' : ''}>${t.label}</option>`).join('');
  }
  $('tech').onchange = (e) => { app.techKey = e.target.value; app.exportActive = false; rebuild(true); };

  function setParam(key, v) {
    if (key === 'mdlcsl') {
      app.params.mdl_over_mat = v & 1;
      app.params.csl_mdl_over_mat = v >> 1;
    } else app.params[key] = v;
    delete app.params.mdlcsl;
    app.exportActive = false;
    rebuild(true);
  }

  function renderProblems() {
    const m = app.model;
    let h = '';
    if (m.problems.length) {
      h += `<div class="problem"><b>DreamRAM would discard this design</b>${m.problems.map((q) => `<br>· ${esc(q.msg)} <span style="opacity:.7">(status ${q.code})</span>`).join('')}<br><span style="opacity:.8">The floorplan is still drawn from the model.</span></div>`;
    } else h += '<div class="ok">✓ Passes DreamRAM\'s design filters</div>';
    $('problems').innerHTML = h;
    const src = app.exportActive
      ? `Source: <b>DreamRAM export</b>${app.exportData._name ? ' · ' + esc(app.exportData._name) : ''}`
      : 'Source: <b>in-browser port</b> of DreamRAM\'s model';
    $('source').innerHTML = src;
  }

  function renderValidation() {
    const sec = $('validation-sec');
    if (!app.exportActive) { sec.hidden = true; return; }
    sec.hidden = false;
    const rows = DR.compareExport(app.model, app.exportData);
    const worst = Math.max(...rows.map((r) => r.rel));
    $('validation').innerHTML = `<div class="${worst < 1e-6 ? 'ok' : 'problem'}" style="margin:0 0 6px">${worst < 1e-6 ? '✓ Port matches DreamRAM' : 'Port differs from DreamRAM'} (max rel. error ${worst.toExponential(1)})</div>
      <table class="val"><tr><th></th><th>DreamRAM</th><th>port</th></tr>${rows.map((r) => `<tr><td>${r.label}</td><td>${fmt(r.py, 4)}</td><td>${fmt(r.js, 4)}</td></tr>`).join('')}</table>`;
  }

  function updatePanels() {
    renderParams();
    renderMetrics();
    updateArea();
    renderProblems();
    renderValidation();
    renderLayers();
    renderInfo();
    writeHash();
  }

  // ---------- exports / examples ----------
  function techKeyFor(t) {
    for (const [k, v] of Object.entries(DR.TECH_PRESETS)) {
      if (Math.abs(v.pitch_wl - t.pitch_wl) > 1e-9 || Math.abs(v.pitch_bl - t.pitch_bl) > 1e-9 || (t.f && Math.abs(v.f - t.f) > 1e-9)) continue;
      if (!t.max_die_um || t.max_die_um === v.max_die_um) return k;
      // export made with a relaxed die-size filter (--max-die-mm)
      const k2 = `${k}@${t.max_die_um / 1000}mm`;
      DR.TECH_PRESETS[k2] = Object.assign({}, v, { label: `${v.label} · die limit ${t.max_die_um / 1000} mm`, max_die_um: t.max_die_um });
      return k2;
    }
    const key = 'custom';
    DR.TECH_PRESETS[key] = Object.assign({}, DR.TECH_PRESETS['16nm'], { label: `Custom (f=${t.f}, WL ${t.pitch_wl}, BL ${t.pitch_bl})`, f: t.f || 0.016, pitch_wl: t.pitch_wl, pitch_bl: t.pitch_bl, tsv_pitch: t.tsv_pitch, ubump_pitch: t.ubump_pitch, tsv_koz: t.tsv_koz });
    return key;
  }

  function loadExport(ex, name) {
    if (!ex || ex.source !== 'dreamram' || !ex.params) throw new Error('Not a DreamRAM floorplan export (expected output of tools/export_floorplan.py)');
    ex._name = name;
    app.exportData = ex;
    app.exportActive = true;
    app.params = Object.assign({}, DR.BASELINE);
    for (const [k, v] of Object.entries(ex.params)) if (k in DR.BASELINE) app.params[k] = v;
    app.techKey = techKeyFor(ex.tech);
    app.focus = null;
    app.selected = null;
    rebuild(false);
  }

  const exSel = $('example');
  const EX = window.DR_EXAMPLES || {};
  const exLabels = {
    hbm3_baseline: 'HBM3 baseline (16 GB, 1 TB/s)',
    high_bw_subchannels: '32 ch · 4 subchannels · BRVSA',
    dlomat_halfpage: 'DLOMAT · 32 MDLs · half-page',
    conventional_salp: '1024-BL MATs · SALP groups',
    hbm3_org_17nm: 'HBM3 organisation @ 17 nm',
    hbm4_1sid_4h: 'HBM4 · 1 SID, 4-high · 1 KiB rows · 34/36 nm (die limit 18 mm)',
    hbm4_1sid_coupled: 'HBM4 · 1 SID · coupled rows, 2 KiB WL = 2 × 1 KiB (die limit 16 mm)',
    hbm3_coupled_edgepair: 'HBM3 org · coupled rows + paired edge subarrays',
    samsung_hbm4_12h_coupled: 'Samsung HBM4 org (ISSCC 26) · 12-high, 2 channel rows · coupled rows',
    samsung_hbm4_12h_1k_2wide: 'Samsung HBM4 org (ISSCC 26) · 12-high, 2 channel rows · 1 KiB rows, banks 2 wide',
    alternative_samsung: 'Alternative Samsung · 1 SID, 2 channel rows, coupled rows, banks 2 wide',
    hbm5_2bg_min_area: 'HBM5 · smallest die · 1 KiB rows, 1024-WL MATs · 17.2 × 11.2 mm · 8.24 Gb/s',
    hbm5_2bg_hbm4_latency: 'HBM5 · HBM4 latency (63.6 ns) · 1 KiB rows, 512-WL MATs · 17.2 × 11.5 mm · 8.07 Gb/s',
    hbm5_2bg_low_latency: 'HBM5 · lowest latency (57.3 ns) · BRVSA, bank groups side by side · 34.5 × 5.8 mm · 9.12 Gb/s',
    hbm5_2bg_hbm4_mats: 'HBM5 · HBM4 MATs + coupled 2 KiB wordline · 30.2 × 7.1 mm · 9.79 Gb/s',
    g32_min_die_dreamram: '32G · DreamRAM tCCD_L · smallest die · 8×2 BGs × 2 banks · 17.2 × 10.9 mm · 36.7 Gb/s',
    g32_low_latency_dreamram: '32G · DreamRAM tCCD_L · lowest latency (95 ns) · BRVSA · 18.8 × 11.1 mm · 37.8 Gb/s',
    g32_min_die_bankpath: '32G · bank path only · smallest die · 8 BGs × 2 banks, coupled · 14.3 × 11.4 mm · 42.8 Gb/s',
    g32_32banks_bankpath: '32G · bank path only · 4×2 BGs × 4 banks (32 / PC) · 17.2 × 10.8 mm · 42.2 Gb/s',
    g32_low_latency_bankpath: '32G · bank path only · lowest latency (63 ns) · 256-WL MATs, BRVSA · 17.2 × 11.9 mm · 32.6 Gb/s',
    g32_2bg_64b_bankpath: '32G · bank path only · 2 BGs × 16 banks, 64 B access, coupled ×4 · 26.5 × 10.9 mm · 33.1 Gb/s',
  };
  exSel.innerHTML = '<option value="">Example designs…</option>'
    + '<optgroup label="DreamRAM exports">' + Object.keys(EX).filter((k) => !k.startsWith('hbm5_') && !k.startsWith('g32_')).map((k) => `<option value="ex:${k}">${exLabels[k] || k}</option>`).join('') + '</optgroup>'
    // HBM5: 16 channels/die, 4096 DQs, 2 bank groups × 8 banks, half the rows per channel of our HBM4,
    // evaluated with the BG-BUS-limited tCCD_L extension (README)
    + '<optgroup label="HBM5 exploration">' + Object.keys(exLabels).filter((k) => k.startsWith('hbm5_') && EX[k]).map((k) => `<option value="ex:${k}">${exLabels[k] || k}</option>`).join('') + '</optgroup>'
    // 32 data DQs per pseudo-channel at >= 32 Gb/s, 16 GB, from tools/sweep_pin_rate.py (README)
    + '<optgroup label="32 Gb/s exploration">' + Object.keys(exLabels).filter((k) => k.startsWith('g32_') && EX[k]).map((k) => `<option value="ex:${k}">${exLabels[k] || k}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Presets (in-browser model)">' + Object.entries(DR.DESIGN_PRESETS).map(([k, d]) => `<option value="pre:${k}">${d.label}</option>`).join('') + '</optgroup>';
  exSel.onchange = () => {
    const [kind, k] = exSel.value.split(':');
    exSel.value = '';
    if (kind === 'ex') return loadExport(JSON.parse(JSON.stringify(EX[k])), exLabels[k] || k);
    if (kind === 'pre') {
      const d = DR.DESIGN_PRESETS[k];
      app.params = Object.assign({}, DR.BASELINE, d.params);
      app.techKey = d.tech;
      app.exportActive = false;
      app.focus = null;
      app.selected = null;
      rebuild(false);
    }
  };

  $('file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { try { loadExport(JSON.parse(t), f.name); } catch (err) { alert(err.message); } });
    e.target.value = '';
  };
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) f.text().then((t) => { try { loadExport(JSON.parse(t), f.name); } catch (err) { alert(err.message); } });
  });

  $('btn-reset').onclick = () => { app.params = Object.assign({}, DR.BASELINE); app.techKey = '16nm'; app.exportActive = false; rebuild(true); };
  $('btn-up').onclick = goUp;
  $('btn-fit').onclick = fit;
  $('btn-theme').onclick = () => {
    app.theme = app.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = app.theme;
    try { localStorage.setItem('dreamram-theme', app.theme); } catch (e) { /* storage unavailable */ }
    renderLayers(); updateArea(); renderTree(); renderInfo(); app.requestDraw();
  };

  // ---------- URL hash keeps the design shareable ----------
  function writeHash() {
    const q = new URLSearchParams();
    const base = DR.normalize({}), p = DR.normalize(app.params);
    for (const k of Object.keys(DR.BASELINE)) if (p[k] !== base[k]) q.set(k, p[k]);
    if (app.techKey !== '16nm' && DR.TECH_PRESETS[app.techKey] && !app.techKey.includes('@') && app.techKey !== 'custom') q.set('tech', app.techKey);
    const h = q.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    for (const [k, v] of q) {
      if (k === 'tech' && DR.TECH_PRESETS[v]) app.techKey = v;
      else if (k in DR.BASELINE && isFinite(+v)) app.params[k] = +v;
    }
  }

  // ---------- boot ----------
  try { const th = localStorage.getItem('dreamram-theme'); if (th === 'light' || th === 'dark') app.theme = th; } catch (e) { /* storage unavailable */ }
  document.documentElement.dataset.theme = app.theme;
  readHash();
  const ro = new ResizeObserver(() => {
    R.resize();
    if (app.focus && app.focus.type !== 'stack' && !app._userCam) R.fitRect(app.focus, false);
    app.requestDraw();
  });
  R.resize();
  rebuild(false);
  ro.observe(cv);
})();
