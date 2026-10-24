// Design space tab: every 32 Gb/s HBM4 die organisation with a 64 B column access (window.DR_DESIGNSPACE, built by
// tools/build_designspace.py), as two scatter plots: worst-case power vs die area for all designs, and power vs die
// aspect ratio for those within the JEDEC HBM4 footprint. Colours come from the --seq-lo / --seq-hi tokens, so the
// plots follow the theme; render again after a theme change.
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});
  const state = { onlyBank: false, onlyOk: false, tol: 0.01 };

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const rgb = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const ramp = (lo, hi) => (v) => {
    const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
    const a = rgb(css('--seq-lo')), b = rgb(css('--seq-hi'));
    return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(',')})`;
  };
  const SHAPES = [
    { hits: 2, label: 'Corrects a driver fault' },
    { hits: 4, label: 'Misses it (4 symbols / codeword)' },
    { hits: 8, label: 'Misses it (8 symbols / codeword)' },
  ];
  function shape(hits, x, y, r) {
    if (hits <= 2) return `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
    if (hits <= 4) { const s = r * 1.25; return `M${x},${y - s}L${x + s},${y + s * 0.8}L${x - s},${y + s * 0.8}Z`; }
    const s = r * 0.9; return `M${x - s},${y - s}h${2 * s}v${2 * s}h${-2 * s}Z`;
  }
  const org = (d) => `${d.subarrays} × ${d.mat_rows}-WL subarrays, ${d.mats} × ${d.mat_cols}-BL MATs, ${d.ldls_mdls} MDLs` +
    `${d.coupled_rows > 1 ? `, coupled ×${d.coupled_rows}` : ''}${d.brvsa ? ', BRVSA' : ''}, ${d.channel_rows} channel row${d.channel_rows > 1 ? 's' : ''}`;
  const ok = (d) => d.hits <= d.t;
  const fits = (d, fp, tol) => Math.max(d.w, d.h) <= fp[0] * (1 + tol) + 1e-9 && Math.min(d.w, d.h) <= fp[1] * (1 + tol) + 1e-9;
  const ticks = (lo, hi, step) => { const t = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) t.push(+v.toFixed(3)); return t; };

  // Pareto front: lower x and lower y
  function front(pts, xk, yk) {
    const s = [...pts].sort((a, b) => a[xk] - b[xk] || a[yk] - b[yk]), f = [];
    let best = Infinity;
    for (const p of s) if (p[yk] < best) { f.push(p); best = p[yk]; }
    return f;
  }

  // One scatter: x/y {key, label, lo, hi, step, fmt}, colour {key, lo, hi}, dim(d) for filtered-out marks
  function scatter(o) {
    const W = 900, H = o.h || 460, m = { l: 66, r: 20, t: 16, b: 50 };
    const X = (v) => m.l + (v - o.x.lo) / (o.x.hi - o.x.lo) * (W - m.l - m.r);
    const Y = (v) => H - m.b - (v - o.y.lo) / (o.y.hi - o.y.lo) * (H - m.t - m.b);
    const col = ramp(o.color.lo, o.color.hi);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="dssvg" role="img" aria-label="${o.aria}"><g class="dsgrid">`;
    for (const v of ticks(o.x.lo, o.x.hi, o.x.step)) s += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}"/>`;
    for (const v of ticks(o.y.lo, o.y.hi, o.y.step)) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    s += `</g><g class="dsaxis"><line class="base" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
    for (const v of ticks(o.x.lo, o.x.hi, o.x.step)) s += `<text x="${X(v)}" y="${H - m.b + 17}" text-anchor="middle">${o.x.fmt(v)}</text>`;
    for (const v of ticks(o.y.lo, o.y.hi, o.y.step)) s += `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${o.y.fmt(v)}</text>`;
    s += `<text class="title" x="${(m.l + W - m.r) / 2}" y="${H - 10}" text-anchor="middle">${o.x.label}</text>`;
    s += `<text class="title" transform="translate(15 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${o.y.label}</text></g>`;
    if (o.ref) s += `<line class="dsref" x1="${m.l}" x2="${W - m.r}" y1="${Y(o.ref.v)}" y2="${Y(o.ref.v)}"/><text class="dsreft" x="${W - m.r - 4}" y="${Y(o.ref.v) - 6}" text-anchor="end">${o.ref.label}</text>`;
    const live = o.pts.filter((d) => !o.dim(d));
    if (o.front && live.length > 1) {
      const f = front(live, o.x.key, o.y.key);
      s += `<polyline class="dsfront" points="${f.map((p) => `${X(p[o.x.key])},${Y(p[o.y.key])}`).join(' ')}"/>`;
    }
    const order = o.pts.map((d, i) => i).sort((a, b) => o.pts[b][o.y.key] - o.pts[a][o.y.key]);
    for (const i of order) {
      const d = o.pts[i];
      s += `<path class="dsmark${o.dim(d) ? ' dim' : ''}" data-i="${i}" d="${shape(d.hits, X(d[o.x.key]), Y(d[o.y.key]), 5.5)}" fill="${col(d[o.color.key])}"/>`;
    }
    for (const c of o.callouts || []) s += `<text class="dscall" x="${X(c.d[o.x.key]) + 10}" y="${Y(c.d[o.y.key]) + (c.dy || -8)}">${c.text}</text>`;
    return s + '</svg>';
  }

  function tipHtml(d) {
    return `<b>${d.die} mm² · ${d.power} W</b><div>${org(d)}</div><div class="dsr">
      <span>Die</span><span>${d.w} × ${d.h} mm (${d.aspect.toFixed(2)} : 1)</span>
      <span>Cell efficiency</span><span>${d.cell.toFixed(1)}%</span>
      <span>Row-miss latency</span><span>${d.lat} ns</span>
      <span>Driver fault</span><span>${ok(d) ? 'corrected' : 'not corrected'} (${d.hits} of ${d.t} symbols)</span>
      <span>tCCD_L</span><span>${d.tccdl.toFixed(2)} of 1.00 ns${d.bank ? '' : ', mid-bank decoder'}</span>
      <span>TSVs / PC</span><span>${d.tsvs}</span></div>`;
  }
  function bindTips(box, pts) {
    const tip = box.querySelector('.dstip');
    box.querySelectorAll('.dsmark').forEach((el) => {
      const d = pts[+el.dataset.i];
      el.addEventListener('mousemove', (ev) => {
        tip.innerHTML = tipHtml(d);
        tip.hidden = false;
        const r = box.getBoundingClientRect();
        let x = ev.clientX - r.left + 14;
        if (x + 300 > r.width) x = ev.clientX - r.left - 314;
        tip.style.left = Math.max(4, x) + 'px';
        tip.style.top = (ev.clientY - r.top + 14) + 'px';
      });
      el.addEventListener('mouseleave', () => (tip.hidden = true));
    });
  }
  const legendRamp = (label, lo, hi) => `<span class="dsgrp"><span>${label}</span><span>${lo}</span><span class="dsramp"></span><span>${hi}</span></span>`;
  const legendShapes = (pts) => `<span class="dsgrp">${SHAPES.map((s) => `<span><svg width="16" height="16" aria-hidden="true"><path d="${shape(s.hits, 8, 8, 5)}" class="dslshape"/></svg> ${s.label} · ${pts.filter((d) => d.hits === s.hits).length}</span>`).join('')}</span>`;
  const seg = (name, opts, cur) => `<div class="dsseg" role="group" aria-label="${name}">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;

  function motivation(A) {
    const [now, next] = A;
    const share = (a, n) => Math.round(100 * (a.e_act + a.e_pre) / (a.e_act + a.e_pre + n * a.e_rd));
    const per64 = Math.floor(next.bytes_per_act / 64);
    return `<h2>Why 64 B accesses</h2>
      <p><b>To keep the pins busy, every row we open already has to be read about ${Math.round(next.reads32)} times at 32 B.</b> A pseudo-channel can open at most four rows per tFAW. In DreamRAM's model that is ${now.tfaw} ns for HBM4, with one activation per tRRD = ${now.trrd} ns.</p>
      <ul>
        <li><b>At 8 Gb/s</b> a pseudo-channel moves 32 B/ns, so each opened row has to supply ${now.bytes_per_act} B, about ${now.reads32} reads of 32 B, before the next activation slot comes up.</li>
        <li><b>At 32 Gb/s</b> it moves 128 B/ns. Each row then has to supply ${next.bytes_per_act} B: about ${Math.round(next.reads32)} reads of 32 B, or ${per64} of 64 B. Below that, activation rate, not the column path, caps the bandwidth.</li>
        <li><b>A 64 B access merges two reads that a streaming workload already sends to the same open row.</b> Only accesses that need a single 32 B piece of a row lose, by moving 32 B they don't use.</li>
        <li><b>Energy points the same way.</b> In DreamRAM, opening and closing a row costs ${next.e_act + next.e_pre} pJ, and a 64 B read ${next.e_rd} pJ. With one read per row, activation is ${share(next, 1)}% of the energy; with the ${per64} reads the activation rate needs anyway, it's ${share(next, per64)}%.</li>
      </ul>
      <p class="rnote">tFAW and tRRD are DreamRAM's (tFAW = 4 × tRRD); JEDEC leaves both to the vendor. Energies are for the HBM4 coupled reference at 8 Gb/s and the bundled 64 B preset at 32 Gb/s.</p>`;
  }

  function render(container) {
    const DS = window.DR_DESIGNSPACE;
    if (!DS) { container.innerHTML = '<div class="tnote">No design-space data (js/designspace_data.js).</div>'; return; }
    const pts = DS.designs, fp = DS.footprint;
    const cell = [Math.min(...pts.map((d) => d.cell)), Math.max(...pts.map((d) => d.cell))];
    const visible = (d) => (!state.onlyBank || d.bank) && (!state.onlyOk || ok(d));
    const inFp = pts.filter((d) => fits(d, fp, state.tol));
    const strict = pts.filter((d) => fits(d, fp, 0)).length;
    const lat = [Math.min(...pts.map((d) => d.lat)), Math.max(...pts.map((d) => d.lat))];
    const vis = pts.filter(visible), f = front(vis, 'power', 'die');
    const best = (a, k) => (a.length ? a.reduce((p, q) => (q[k] < p[k] ? q : p)) : null);
    const okAll = pts.filter(ok), smOk = best(okAll, 'die'), sm = best(pts, 'die'), lowP = best(pts, 'power');
    // closest to the footprint: smallest overshoot on its worse side
    const over = (d) => Math.max(Math.max(d.w, d.h) / fp[0], Math.min(d.w, d.h) / fp[1]);
    const near = pts.reduce((p, q) => (over(q) < over(p) ? q : p));
    const nearTxt = `The closest is ${Math.max(near.w, near.h).toFixed(2)} × ${Math.min(near.w, near.h).toFixed(2)} mm, ${(100 * (over(near) - 1)).toFixed(1)}% over on its long side`;
    const p1 = scatter({
      pts, aria: `Worst-case power against die area for ${pts.length} designs`, front: true, dim: (d) => !visible(d),
      x: { key: 'power', label: 'Worst-case power per stack (W)', lo: 80, hi: 200, step: 20, fmt: (v) => v },
      y: { key: 'die', label: 'Die area (mm²)', lo: 140, hi: 222, step: 10, fmt: (v) => v },
      color: { key: 'cell', lo: cell[0], hi: cell[1] },
      ref: { v: fp[0] * fp[1], label: `JEDEC HBM4 footprint area, ${(fp[0] * fp[1]).toFixed(1)} mm²` },
      callouts: f.length ? [{ d: f[0], text: `Lowest power: ${f[0].power} W, ${f[0].die} mm²` }, { d: f[f.length - 1], dy: 16, text: `Smallest: ${f[f.length - 1].die} mm², ${f[f.length - 1].power} W` }] : [],
    });
    const xs2 = inFp.map((d) => d.power), ys2 = inFp.map((d) => d.aspect);
    const p2 = inFp.length ? scatter({
      pts: inFp, h: 360, aria: `Worst-case power against die aspect ratio for ${inFp.length} designs within the JEDEC footprint`, dim: () => false,
      x: { key: 'power', label: 'Worst-case power per stack (W)', lo: Math.floor((Math.min(...xs2) - 5) / 10) * 10, hi: Math.ceil((Math.max(...xs2) + 5) / 10) * 10, step: 10, fmt: (v) => v },
      y: { key: 'aspect', label: 'Die aspect ratio (long side / short side)', lo: Math.min(1.25, Math.floor((Math.min(...ys2) - 0.02) * 50) / 50), hi: Math.ceil((Math.max(...ys2) + 0.02) * 50) / 50, step: 0.02, fmt: (v) => v.toFixed(2) },
      color: { key: 'lat', lo: Math.min(...inFp.map((d) => d.lat)), hi: Math.max(...inFp.map((d) => d.lat)) },
      ref: { v: fp[0] / fp[1], label: `JEDEC footprint, ${(fp[0] / fp[1]).toFixed(2)} : 1` },
    }) : `<div class="dsempty">No design fits the JEDEC footprint ${state.tol ? `within ${Math.round(state.tol * 100)}%` : 'exactly'}. ${nearTxt}.</div>`;
    const latIn = inFp.length ? [Math.min(...inFp.map((d) => d.lat)), Math.max(...inFp.map((d) => d.lat))] : lat;

    container.innerHTML = `<article class="rdoc dsdoc">
      <div class="reyebrow">HBM4 · 32 Gb/s · 64 B access (BL16) · 16 GB stack</div>
      <h1>64 B design space</h1>
      <p class="rlede">Every die organisation in the sweep that reaches 32 Gb/s when the only interface change is a 64 B column access over 16 beats. Everything else stays HBM4: 2 pseudo-channels × 32 DQs, 2 bank groups × 8 banks, 1 KiB rows, 32 Gb per die.</p>
      ${motivation(DS.activation)}

      <h2>All ${pts.length} designs</h2>
      <p>Worst-case power against die area. Colour is cell efficiency; shape is whether OD-ECC corrects a sub-wordline driver fault. Hover a mark for its organisation.</p>
      <div class="dscontrols"><span>Show</span>
        ${seg('bank', [[0, `All ${pts.length}`], [1, 'Pass without a mid-bank decoder']], state.onlyBank ? 1 : 0)}
        ${seg('ok', [[0, 'Any fault coverage'], [1, 'Corrects a driver fault']], state.onlyOk ? 1 : 0)}</div>
      <div class="dschart" id="ds1">${p1}<div class="dstip" hidden></div></div>
      <div class="dslegend">${legendRamp('Cell efficiency', cell[0].toFixed(0) + '%', cell[1].toFixed(0) + '%')}${legendShapes(pts)}
        <span class="dsgrp"><svg width="26" height="10" aria-hidden="true"><line x1="1" y1="5" x2="25" y2="5" class="dsfront"/></svg> Power–area front</span></div>
      <ul>
        <li><b>Power and area trade off along a short front.</b> The lowest-power design draws ${lowP.power} W at ${lowP.die} mm²; the smallest is ${sm.die} mm² at ${sm.power} W.</li>
        <li><b>Correcting a driver fault needs 16 MDLs per MAT.</b> A 64 B access gives each of its two codewords 4 check symbols, so each corrects 2. A driver fault hits the two MATs beside it: 2 symbols per codeword with 16 MDLs, 4 with 32, 8 with 64. The smallest design that corrects it is ${smOk.die} mm² at ${smOk.power} W.</li>
        <li><b>${pts.filter((d) => d.bank).length} of ${pts.length} pass without a mid-bank decoder.</b> None pass with the I/O sense amp shared at the bank group's I/O control.</li>
      </ul>

      <h2>Within the JEDEC footprint</h2>
      <p>Designs that fit HBM4's 14.175 × 10.975 mm footprint (MO-362), in either orientation. Power against how skewed the die is; colour is row-miss latency.</p>
      <div class="dscontrols"><span>Tolerance per side</span>${seg('tol', [[0, 'Exact'], [0.01, '1%'], [0.05, '5%']], state.tol)}<span class="rnote">${inFp.length} designs · ${strict} fit exactly</span></div>
      <div class="dschart" id="ds2">${p2}<div class="dstip" hidden></div></div>
      ${inFp.length ? `<div class="dslegend">${legendRamp('Row-miss latency', latIn[0].toFixed(0) + ' ns', latIn[1].toFixed(0) + ' ns')}${legendShapes(inFp)}</div>` : ''}
      <ul>
        <li><b>No design fits exactly.</b> ${nearTxt}: eight channels × two pseudo-channels of banks side by side. DreamRAM's own model of today's HBM4 die is 15.10 mm wide, 6.5% over, so a 1% allowance is well inside the model's error.</li>
        <li><b>Within 1%, every design is 14.30 mm wide and 1.33–1.37 : 1</b>, slightly longer than the footprint's 1.29. None of them corrects a driver fault: they all use 64 MDLs per MAT. The 5% allowance adds dies 11.21 mm tall at 1.28 : 1.</li>
        <li><b>The lowest-power design within 5% is bundled:</b> 1 × 2 bank groups of 8 banks, 16 × 512-WL subarrays, 16 × 1024-BL MATs coupled ×2, 64 MDLs, two channel rows and a mid-bank column decoder. 14.30 × 11.21 mm (1.28 : 1), 107 W, 74 ns row-miss latency, tCCD_L 0.84 ns. It doesn't correct a driver fault. <button class="rload" data-load="ex:g32_64b_fp5_lowpower">Open</button></li>
      </ul>
      <p class="rnote">Model: DreamRAM with the viewer's staged tCCD_L (tools/sweep_interface.py, option a64; data from tools/build_designspace.py). A design passes when tCCD_L ≤ 1 ns (two bank groups × the 0.5 ns burst), every TSV runs at ≤ ${DS.tsv_rate} Gb/s, and both die sides stay under 20 mm. Worst-case power is DreamRAM's: closed-row energy per bit × 8.2 TB/s.</p>
    </article>`;

    bindTips(container.querySelector('#ds1'), pts);
    if (inFp.length) bindTips(container.querySelector('#ds2'), inFp);
    container.querySelectorAll('[data-bank]').forEach((b) => (b.onclick = () => { state.onlyBank = b.dataset.bank === '1'; keep(container); }));
    container.querySelectorAll('[data-ok]').forEach((b) => (b.onclick = () => { state.onlyOk = b.dataset.ok === '1'; keep(container); }));
    container.querySelectorAll('[data-tol]').forEach((b) => (b.onclick = () => { state.tol = +b.dataset.tol; keep(container); }));
  }
  // re-render without losing the scroll position
  function keep(container) { const y = container.scrollTop; render(container); container.scrollTop = y; }

  DR.renderDesignSpace = keep;
})();
