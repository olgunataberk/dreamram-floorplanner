// PRAC tab: per-row activation counting study (window.DR_PRAC, built by tools/build_prac_data.py from
// tools/prac_study.py and tools/hbm5_study.py). Costs are reported on the row-miss penalty, tRP + tRCD (what a row
// miss costs over a hit, where PRAC acts), with the row-miss latency to first data (tCL + tRCD + tRP) alongside.
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});
  const state = { design: 1, rate: 0 };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f = (v, n = 1) => (v === undefined || v === null || Number.isNaN(v) ? '—' : Number(v).toFixed(n));
  const pct = (v, b, n = 0) => `${v >= b ? '+' : ''}${(100 * (v / b - 1)).toFixed(n)}%`;
  const pen = (r) => r.trp + r.trcd;
  const NAMES = {
    hbm3_baseline: 'HBM3 baseline', hbm4_1sid_coupled: 'HBM4 1 SID, coupled rows',
    hbm5_2bg_min_area: 'HBM5 2 groups × 8 banks (1024-WL MATs)', g32_64b_fp5_lowpower: '32 Gb/s, 64 B access',
  };
  const seg = (name, opts, cur) => `<div class="dsseg" role="group" aria-label="${name}">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${String(v) === String(cur)}">${esc(l)}</button>`).join('')}</div>`;

  // Row-miss penalty as a stacked bar: tRCD, tRP without PRAC, then what PRAC adds to tRP
  function penaltyBars(d, colors) {
    const off = d.off, rows = d.prac.filter((r) => !r.discarded);
    const max = Math.max(...rows.map(pen)) * 1.04;
    const W = 900, labelW = 300, barH = 18, gap = 9, top = 8;
    const X = (v) => labelW + v / max * (W - labelW - 140);
    const H = top + rows.length * (barH + gap) + 28;
    const keys = [['trcd', 'tRCD', colors[4]], ['trp0', 'tRP without PRAC', colors[5]], ['path', 'Counter path (read, logic, write)', colors[0]], ['queue', 'Waiting for a shared path', colors[2]], ['restore', 'Counter-cell restore', colors[1]], ['other', 'Added tRP (DDR5 ratio)', colors[3]]];
    let s = `<svg viewBox="0 0 ${W} ${H}" class="dssvg" role="img" aria-label="Row-miss penalty by PRAC configuration">`;
    for (let t = 0; t <= max; t += 20) s += `<line x1="${X(t)}" x2="${X(t)}" y1="${top - 4}" y2="${H - 22}" class="dsgridl"/><text x="${X(t)}" y="${H - 8}" class="dsaxt" text-anchor="middle">${t}</text>`;
    rows.forEach((r, i) => {
      const y = top + i * (barH + gap);
      const add = r.trp - off.trp, pp = r.parts;
      const after = add > 1e-6;
      const parts = [['trcd', r.trcd], ['trp0', Math.min(r.trp, off.trp)]];
      if (after && pp) parts.push(['path', r.acu - pp.restore - pp.queue], ['queue', pp.queue], ['restore', pp.restore]);
      else if (after) parts.push(['other', add]);
      let x = 0;
      s += `<text x="${labelW - 10}" y="${y + barH / 2 + 4}" class="dslab" text-anchor="end">${esc(r.label)}</text>`;
      for (const [k, v] of parts) {
        if (v <= 0) continue;
        const c = keys.find((q) => q[0] === k);
        s += `<rect x="${X(x)}" y="${y}" width="${Math.max(0.5, X(x + v) - X(x) - 1)}" height="${barH}" rx="2" fill="${c[2]}"><title>${esc(c[1])}: ${f(v)} ns</title></rect>`;
        x += v;
      }
      s += `<text x="${X(x) + 6}" y="${y + barH / 2 + 4}" class="dsval">${f(pen(r))} ns${i ? ` (${pct(pen(r), pen(off))})` : ''}</text>`;
    });
    s += `</svg>`;
    const legend = keys.filter(([k]) => k !== 'other' || rows.some((r) => r.trp > off.trp && !r.parts))
      .map(([, l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join('');
    return `${s}<div class="prlegend">${legend}<span class="rnote">time (ns)</span></div>`;
  }

  // ---- Where the PRAC circuits sit: one schematic bank group per configuration ----
  // cells: counter storage ('none' | 'row' in-row columns | 'sub' counter subarray | 'ecc' inside the ECC columns);
  // unit: PRAC unit (counter IOSA / write driver, incrementer, compare, latches) 'bank' or 'bg' (in the I/O control);
  // dec: OD-ECC decoder 'bg' or 'bank'; when: when the update runs; prot: counter protection tag
  const LAYOUTS = [
    { match: 'Off', title: 'No PRAC', cells: 'none', unit: null, dec: 'bg', when: null, note: 'Reference: banks, their column decoders facing the bank group\'s I/O control, and the OD-ECC decoder in the I/O control.' },
    { match: 'Base', title: 'After PRE, per-bank path (DDR5 PRAC)', cells: 'row', unit: 'bank', dec: 'bg', when: 'after PRE', note: 'Counter columns in every row; each bank reads, increments and writes its counter through its own small counter path after PRECHARGE.' },
    { match: 'While the row is open', title: 'While the row is open (PRHT)', cells: 'row', unit: 'bank', dec: 'bg', when: 'row open', note: 'Same circuits; the internal read and write run between ACT and PRE, so tRAS grows instead of tRP.' },
    { match: 'Counter subarray', title: 'Counter subarray (Chronus)', cells: 'sub', unit: 'bank', dec: 'bg', when: 'concurrent', note: 'Counters move to a short subarray with its own sense amps at the column decoder, updated alongside the data row.' },
    { match: 'Shared I/O-control path', title: 'Shared I/O-control path', cells: 'row', unit: 'bg', dec: 'bg', when: 'after PRE', shared: true, note: 'One PRAC unit per bank group in the I/O control; every bank\'s counter travels over its MDLs to it, so an all-bank PRECHARGE queues the other banks.' },
    { match: 'Own SEC-DED', title: 'Counter with its own SEC-DED (or parity)', cells: 'row', unit: 'bank', dec: 'bg', when: 'after PRE', prot: 'SEC-DED', note: 'As the per-bank base, with check bits beside the counter and a small encoder / decoder in each bank\'s PRAC unit.' },
    { match: 'Inside OD-ECC codeword, bank-group', title: 'Inside the OD-ECC codeword, bank-group decoder', cells: 'ecc', unit: 'bg', dec: 'bg', when: 'after PRE', shared: true, note: 'The counter is a symbol of an OD-ECC codeword; the only decoder is the bank group\'s, so the whole codeword goes to the I/O control and back, queueing behind the other banks.' },
    { match: 'Inside OD-ECC codeword, per-bank', title: 'Inside the OD-ECC codeword, per-bank decoders', cells: 'ecc', unit: 'bank', dec: 'bank', when: 'after PRE', note: 'Every bank gets its own OD-ECC decoder and PRAC unit, so the codeword read-modify-write stays in the bank.' },
  ];

  function placementSvg(L, P) {
    const W = 300, H = 254, x0 = 40, bw = 200, bh = 34, cd = 6, gap = 4, ioH = 30;
    const yTop = 22, yIo = yTop + 2 * (bh + gap) + 6, yBot = yIo + ioH + 6;
    const ecc = 14, rh = 4, sub = 6, unitW = 26;
    const out = [];
    const rect = (x, y, w, h, fill, title, extra = '') => out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}><title>${esc(title)}</title></rect>`);
    const text = (x, y, t, cls = 'plabel', anchor = 'start') => out.push(`<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(t)}</text>`);
    const arrow = (xa, ya, xb, yb) => out.push(`<line x1="${xa}" y1="${ya}" x2="${xb}" y2="${yb}" class="parrow" marker-end="url(#pah)"/>`);
    out.push(`<defs><marker id="pah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${P.path}"/></marker></defs>`);
    // I/O control with the bank group's OD-ECC decoder (and a shared PRAC unit) and the BG-BUS leaving it
    rect(x0, yIo, bw, ioH, P.ioctl, 'Bank group I/O control (IOSA / WD, OD-ECC + DBI, BG-BUS drivers)', 'rx="3"');
    text(x0 + 6, yIo + ioH / 2 + 4, 'I/O control', 'plabel pdark');
    if (L.dec === 'bg') { rect(x0 + 88, yIo + 5, 46, ioH - 10, P.eccOd, 'OD-ECC decoder + DBI, shared by the bank group', 'rx="2"'); text(x0 + 111, yIo + ioH / 2 + 4, 'OD-ECC', 'plabel plight', 'middle'); }
    if (L.unit === 'bg') { rect(x0 + 140, yIo + 5, 54, ioH - 10, P.accent, 'PRAC unit for the whole bank group: counter IOSA / write driver, incrementer, compare, latches', 'rx="2"'); text(x0 + 167, yIo + ioH / 2 + 4, 'PRAC', 'plabel pdark', 'middle'); }
    out.push(`<line x1="${x0 + bw}" y1="${yIo + ioH / 2}" x2="${W - 8}" y2="${yIo + ioH / 2}" stroke="${P.bgbus}" stroke-width="3"/>`);
    text(W - 10, yIo + ioH / 2 - 6, 'BG-BUS', 'plabel', 'end');
    // banks: two drawn on each side of the I/O control, column decoders facing it
    const banks = [[yTop, 'down'], [yTop + bh + gap, 'down'], [yBot, 'up'], [yBot + bh + gap, 'up']];
    banks.forEach(([y, face], i) => {
      const near = face === 'down' ? y + bh - cd : y; // column decoder edge, toward the I/O control
      const arrY = face === 'down' ? y : y + cd, arrH = bh - cd - (L.cells === 'sub' ? sub : 0);
      const arrY2 = face === 'down' ? arrY : arrY + (L.cells === 'sub' ? sub : 0);
      rect(x0, arrY2, bw - ecc - (L.cells === 'row' ? rh : 0), arrH, P.mat, 'Data cells');
      rect(x0 + bw - ecc - (L.cells === 'row' ? rh : 0), arrY2, ecc, arrH, P.eccmat, 'MD-ECC + OD-ECC check-bit columns');
      if (L.cells === 'row') rect(x0 + bw - rh, arrY2, rh, arrH, P.rhcells, `Counter cells: ${L.prot ? 'counter + ' + L.prot + ' bits' : 'one counter'} per row, in extra columns`);
      if (L.cells === 'ecc') rect(x0 + bw - ecc + 3, arrY2 + 2, ecc - 6, arrH - 4, P.rhcells, 'Counter stored as a symbol inside an OD-ECC codeword (in the ECC columns)');
      if (L.cells === 'sub') rect(x0, face === 'down' ? near - sub : near + cd, bw, sub, P.rhcells, 'Counter subarray: short rows holding every row\'s counter, with their own sense amps');
      rect(x0, near, bw, cd, P.coldec, 'Column decoder');
      let unitX = x0 + bw - unitW - 2;
      if (L.unit === 'bank') {
        const uy = face === 'down' ? near - 1 : near - 1;
        rect(unitX, uy, unitW, cd + 2, P.accent, `PRAC unit for this bank: counter IOSA / write driver, incrementer, compare, latches${L.prot ? ', ' + L.prot + ' encode / decode' : ''}`, 'rx="1.5"');
      }
      if (L.dec === 'bank') rect(x0 + bw - 2 * unitW - 6, near - 1, unitW, cd + 2, P.eccOd, 'OD-ECC decoder for this bank', 'rx="1.5"');
      // the counter update's path
      if (L.cells !== 'none') {
        const cx = L.cells === 'sub' ? x0 + bw - unitW / 2 - 2 : L.cells === 'ecc' ? x0 + bw - ecc / 2 : x0 + bw - rh / 2;
        const cy = face === 'down' ? (L.cells === 'sub' ? near - sub / 2 : arrY2 + arrH / 2) : (L.cells === 'sub' ? near + cd + sub / 2 : arrY2 + arrH / 2);
        if (L.unit === 'bank') arrow(cx, cy, unitX + unitW / 2, face === 'down' ? near : near + cd);
        else if (i === 1 || i === 2) arrow(cx, cy, x0 + 167, face === 'down' ? yIo + 5 : yIo + ioH - 5);
        else arrow(cx, cy, x0 + bw + 6, face === 'down' ? yIo - 2 : yIo + ioH + 2);
      }
      text(x0 - 6, y + bh / 2 + 4, `B${i < 2 ? i : i + 2}`, 'plabel', 'end');
    });
    text(x0 - 6, yIo + ioH / 2 + 4, '⋮', 'plabel', 'end');
    text(x0, H - 22, '8 banks per group; 2 drawn on each side', 'psmall');
    if (L.when) text(x0, H - 8, `Update: ${L.when}${L.shared ? ' · all-bank PRE queues banks' : ''}`, 'psmall pwhen');
    return `<svg viewBox="0 0 ${W} ${H}" class="pfig" role="img" aria-label="${esc(L.title)}">${out.join('')}</svg>`;
  }

  function placementSection(D, P) {
    const d = D.designs[state.design], off = d.off;
    const cards = LAYOUTS.map((L) => {
      const r = d.prac.find((x) => x.label.startsWith(L.match) || x.label.includes(L.match));
      const cost = r && !r.discarded && L.match !== 'Off'
        ? `<div class="pcost">penalty <b>${pct(pen(r), pen(off))}</b> · tRC ${f(off.trc)} → ${f(r.trc)} ns · die ${pct(r.die, off.die, 1)}</div>`
        : `<div class="pcost">penalty ${f(pen(off))} ns · tRC ${f(off.trc)} ns</div>`;
      return `<figure class="pcard">${placementSvg(L, P)}<figcaption><b>${esc(L.title)}</b>${cost}<span>${esc(L.note)}</span></figcaption></figure>`;
    }).join('');
    const sw = (c, l) => `<span><i style="background:${c}"></i>${esc(l)}</span>`;
    return `<h2>Where the PRAC circuits sit</h2>
      <p>One bank group in DreamRAM's layout: banks on both sides of the group's I/O control, their column decoders facing it, the BG-BUS leaving it. Costs below each figure are for the design selected above (${esc(NAMES[d.name] || d.name)}).</p>
      <div class="prlegend">${sw(P.mat, 'Data cells')}${sw(P.eccmat, 'ECC check-bit columns')}${sw(P.rhcells, 'Counter cells')}${sw(P.coldec, 'Column decoder')}${sw(P.ioctl, 'I/O control')}${sw(P.eccOd, 'OD-ECC decoder')}${sw(P.accent, 'PRAC unit (counter IOSA / WD, incrementer, latches)')}<span><i class="parrowkey"></i>Counter update path</span></div>
      <div class="pgrid">${cards}</div>`;
  }

  function designSection(D, colors) {
    const d = D.designs[state.design], off = d.off;
    const rows = d.prac.map((r) => r.discarded ? `<tr><td>${esc(r.label)}</td><td colspan="6">discarded</td></tr>`
      : `<tr${r.label.startsWith('Base') ? ' class="pick"' : ''}><td>${esc(r.label)}</td><td class="n">${r.acu ? f(r.acu) : '—'}</td>
        <td class="n">${r.parts ? `${f(r.parts.restore)} / ${f(r.parts.queue)} / ${f(r.acu - r.parts.restore - r.parts.queue)}` : ''}</td>
        <td class="n">${f(r.tras)} / ${f(r.trp)} / ${f(r.trc)}</td><td class="n"><b>${f(pen(r))}</b> (${pct(pen(r), pen(off))})</td>
        <td class="n">${f(r.worst_latency_ns)} (${pct(r.worst_latency_ns, off.worst_latency_ns)})</td><td class="n">${pct(r.die, off.die, 2)}</td></tr>`).join('');
    const ref = d.ecc.find((r) => !r.discarded);
    const ecc = d.ecc.map((r) => r.discarded ? `<tr><td>${esc(r.label)}</td><td colspan="6">discarded</td></tr>`
      : `<tr><td>${esc(r.label)}</td><td class="n">${f(r.gates / 1000)}k</td><td class="n">${f(r.ecc_ns, 2)}</td><td class="n">${f(r.tccdl, 2)}</td>
        <td class="n">${f(r.dq_datarate_gbps)} Gb/s</td><td class="n">${pct(r.die, ref.die, 1)}</td><td>${r.fault === 'yes' ? 'yes' : r.fault === 'no' ? 'no' : '—'}</td></tr>`).join('');
    return `<h2>What sets the cost</h2>
      <p>One design decision changed at a time from a base: the update runs after PRE on a per-bank path, with an unprotected 12-bit counter.</p>
      <div class="dscontrols"><span>Design</span>${seg('prd', D.designs.map((x, i) => [i, NAMES[x.name] || x.name]), state.design)}</div>
      <div class="dschart">${penaltyBars(d, colors)}</div>
      <div class="rtbl"><table>
        <thead><tr><th>PRAC configuration</th><th>Counter update (ns)</th><th>Restore / queue / path</th><th>tRAS / tRP / tRC</th><th>Row-miss penalty</th><th>Row-miss latency</th><th>Die</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <p class="rnote">Row-miss penalty = tRP + tRCD; row-miss latency = tCL + tRCD + tRP, to first data. Percentages are against the same design without PRAC (${f(pen(off))} ns penalty, ${f(off.worst_latency_ns)} ns latency, tRC ${f(off.trc)} ns).</p>
      <h3>On-die ECC engine</h3>
      <p>The ECC engine sets the cost of counters kept inside an OD-ECC codeword, and its own stage limits tCCD_L. Staged column-cycle model with a per-bank IOSA:</p>
      <div class="rtbl"><table>
        <thead><tr><th>Engine</th><th>Gates</th><th>ECC stage (ns)</th><th>tCCD_L (ns)</th><th>Pin rate</th><th>Die</th><th>Corrects a driver fault</th></tr></thead>
        <tbody>${ecc}</tbody></table></div>`;
  }

  function hbm5Section(D) {
    const st = D.hbm5[state.rate];
    const gens = st.gens.map((g) => {
      const picks = [];
      const placeRows = g.placements.map((pl) => {
        if (!pl.picks.length) return `<tr><td>${esc(pl.label)}</td><td class="n">0</td><td colspan="6">none: fastest ${f(pl.fastest)} Gb/s, limited by the ${esc(pl.limiter)}</td></tr>`;
        return pl.picks.map((r) => {
          picks.push([pl, r]);
          return `<tr><td>${esc(pl.label)}</td><td class="n">${pl.passed}</td><td>${esc(r.tags.join(', '))}</td><td>${esc(r.org)}</td>
            <td class="n">${f(r.die_w, 2)} × ${f(r.die_h, 2)} = ${f(r.die)} mm²</td><td class="n">${f(r.aspect, 2)}</td>
            <td class="n">${f(pen(r))} / ${f(r.latency)}</td><td>${r.fault ? 'yes' : 'no'}</td></tr>`;
        }).join('');
      }).join('');
      let matrix = '';
      if (picks.length) {
        const head = picks.map(([pl, r]) => `<th>${esc(pl.label.replace('IOSA ', ''))}<br><small>${esc(r.tags.join(' / '))}</small></th>`).join('');
        const body = picks[0][1].prac.map((q0, i) => `<tr><td>${esc(q0.label)}</td>${picks.map(([, r]) => {
          const q = r.prac[i], b = r.prac[0];
          return q.discarded ? '<td class="n">—</td>' : `<td class="n">${f(pen(q))} <small>${i ? pct(pen(q), pen(b)) : ''}</small></td>`;
        }).join('')}</tr>`).join('');
        matrix = `<p>Row-miss penalty (ns) with each PRAC configuration, one column per design above:</p>
          <div class="rtbl"><table><thead><tr><th>PRAC</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
      }
      return `<h3>${esc(g.gen)} · ${g.organisations} organisations</h3>
        <div class="rtbl"><table>
          <thead><tr><th>IOSA placement</th><th>Pass</th><th>Pick</th><th>Organisation</th><th>Die</th><th>Aspect</th><th>Penalty / latency (ns)</th><th>Fault</th></tr></thead>
          <tbody>${placeRows}</tbody></table></div>${matrix}`;
    }).join('');
    return `<h2>HBM5 with 2× channels per die</h2>
      <p>HBM4's capacity (16 GB, four 32 Gb dies) and pseudo-channel organisation (32 DQs, 32 B accesses, 2 bank groups × 8 banks, 1 KiB rows) with 16 channels per die instead of 8: 4,096 data DQs and half the rows per bank. HBM4-like on-die ECC: one RS(19,17) over 16-bit symbols per 32 B. Every organisation is timed with the staged model under three IOSA placements, with TSVs at ≤ 8 Gb/s and die sides ≤ 20 mm. HBM4 itself is the reference.</p>
      <div class="dscontrols"><span>Pin rate</span>${seg('prr', D.hbm5.map((x, i) => [i, `${f(x.rate, 0)} Gb/s${x.ecc_pipe > 1 ? `, ECC in ${x.ecc_pipe} stages` : ''}`]), state.rate)}</div>
      ${state.rate === 1 ? '<p class="rnote">With HBM4\'s ECC in one stage (1.01 ns at this node) nothing passes at 16 Gb/s: every design stops at 15.8 Gb/s. These results split it into two pipeline stages; HBM3\'s 8-bit symbols (0.84 ns) give the same designs.</p>' : ''}
      ${gens}`;
  }

  function render(container, theme) {
    const D = window.DR_PRAC;
    if (!D) { container.innerHTML = '<div class="tnote">No PRAC study data (js/prac_data.js).</div>'; return; }
    const P = DR.PALETTES[theme || 'dark'];
    const colors = [P.cpl[0], P.cpl[1], P.cpl[2], P.cpl[3], P.pages[0], P.pages[1]];
    const h4 = D.designs.find((x) => x.name === 'hbm4_1sid_coupled') || D.designs[0];
    const base = h4.prac.find((r) => r.label.startsWith('Base')), sharedP = h4.prac.find((r) => r.label.startsWith('Shared'));
    const ecw = h4.prac.find((r) => r.label === 'Inside OD-ECC codeword, bank-group decoder');
    const pb = h4.prac.find((r) => r.label === 'Inside OD-ECC codeword, per-bank decoders');
    const prht = h4.prac.find((r) => r.label.startsWith('While')), chr = h4.prac.find((r) => r.label.startsWith('Counter subarray'));
    const d5 = D.ddr5;
    container.innerHTML = `<article class="rdoc dsdoc">
      <div class="reyebrow">Per-row activation counting · DreamRAM + structural circuit models</div>
      <h1>PRAC</h1>
      <p class="rlede">Per-row activation counting keeps a counter for every row and updates it after each activation: read it, add one, write it back. This tab models that update from circuits and shows what each design decision does to the row-miss penalty.</p>
      <div class="rverdict"><ul>
        <li><b>The counter cells' write recovery sets the floor.</b> On HBM4 the update takes ${f(base.acu)} ns, ${f(base.parts.restore)} ns of it restoring the counter cells, about DDR5's 21 ns. It does not shrink with HBM's faster column path, so even the simplest PRAC raises the row-miss penalty ${pct(pen(base), pen(h4.off))} (latency ${pct(base.worst_latency_ns, h4.off.worst_latency_ns)}).</li>
        <li><b>Sharing multiplies it.</b> Routing counters through the bank group's I/O control makes an all-bank precharge queue the other banks: ${pct(pen(sharedP), pen(h4.off))} on a shared path, ${pct(pen(ecw), pen(h4.off))} for counters inside an OD-ECC codeword decoded per bank group.</li>
        <li><b>Protection and logic are cheap; their location is not.</b> With a decoder in every bank, counters inside the codeword cost ${pct(pen(pb), pen(h4.off))}, close to the unprotected base, at ${pct(pb.die, h4.off.die, 1)} die.</li>
        <li><b>Hiding the update costs tRC or area.</b> Updating while the row is open (PRHT) leaves the penalty alone but raises tRC ${f(h4.off.trc)} → ${f(prht.trc)} ns; a counter subarray (Chronus) hides it at ${pct(chr.die, h4.off.die, 1)} die.</li>
      </ul></div>

      <h2>Why the penalty, not latency</h2>
      <p>A row miss costs tRP + tRCD over a row hit, which pays only tCL. PRAC changes tRP (or tRAS), never tCL, so the penalty is where its share shows; the latency to first data (tCL + tRCD + tRP) is given alongside. In DreamRAM tCL is large (${f(h4.off.tcl)} ns of HBM4's ${f(h4.off.worst_latency_ns)}) and grows with TSV serialisation, which would dilute and skew the comparison.</p>

      <h2>The model</h2>
      <ul>
        <li><b>Counter update.</b> Read the counter (CSL, LDL, MDL, IOSA on the staged model), check it, add one (incrementer sized from Chronus's 21-gate decrementer), re-encode it, equalise, write it back, then restore the counter cells (DreamRAM's tWR cell restore, 18.6 ns × the bitline capacitance ratio). On a shared path, an all-bank precharge queues the group's other banks.</li>
        <li><b>When.</b> After PRE (DDR5 PRAC: tRP grows), while the row is open (PRHT, Kim et al., ISSCC 2023: tRAS grows), or in a counter subarray (Chronus, Canpolat et al., HPCA 2025: a short subarray with its own sense amps, updated alongside the row).</li>
        <li><b>Protection.</b> None, parity, the counter's own SEC-DED code, or inside the OD-ECC codeword (full-codeword read, decode, re-encode and write).</li>
        <li><b>On-die ECC engine.</b> Reed-Solomon over 8- or 16-bit symbols, t = 1 or 2, counted in gates and logic levels; calibrated so HBM3's 2 × RS(19,17) is 24 FO4 and fills DreamRAM's I/O control.</li>
        <li><b>DDR5 reference.</b> DDR5-3200AN without / with PRAC: tRAS ${d5.default.tras} / ${d5.prac.tras}, tRP ${d5.default.trp} / ${d5.prac.trp}, tRC ${d5.default.trc} / ${d5.prac.trc} ns. The earlier "DDR5 ratio" model scales its 21 ns update with the column cycle (${f(D.prac_constants.acu_cycles)} cycles); the structural model builds it instead.</li>
      </ul>
      <p>The same options are in Parameters → Extensions, and the Timing tab's Row cycle view draws each part of the update for the current design.</p>

      ${designSection(D, colors)}
      ${placementSection(D, P)}
      ${hbm5Section(D)}

      <h2>Reproduce</h2>
      <pre>python3 tools/prac_study.py --dreamram /path/to/DreamRAM
python3 tools/hbm5_study.py --dreamram /path/to/DreamRAM --rates 8,16 [--ecc-pipe 2]
python3 tools/build_prac_data.py --dreamram /path/to/DreamRAM   # this tab's data</pre>
      <p class="rnote">Not modelled: energy of the update, RFM / back-off refresh traffic, the area of extra GBUS sets, and a boosted counter write that would shorten the restore.</p>
    </article>`;
    const keep = () => { const y = container.scrollTop; render(container, theme); container.scrollTop = y; };
    container.querySelectorAll('[data-prd]').forEach((b) => (b.onclick = () => { state.design = +b.dataset.prd; keep(); }));
    container.querySelectorAll('[data-prr]').forEach((b) => (b.onclick = () => { state.rate = +b.dataset.prr; keep(); }));
  }

  DR.renderPrac = render;
})();
