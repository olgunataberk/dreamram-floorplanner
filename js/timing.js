// Timing tab: back-to-back column reads drawn as a wave diagram. Each read walks the column path stage by stage
// (CSL → LDL → MDL → IOSA → equalise, then OD-ECC/DBI, BG-BUS, GBUS, DQ), using the staged column-cycle model's
// stage times (tm.stagedView). Three scenarios show what sets the command spacing: the same bank, another bank
// in the same bank group (both tCCD_L) and another bank group (tCCD_S).
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});

  const SCENARIOS = {
    same_bank: { label: 'Same bank', gap: 'tccdl', bgOf: () => 0, bankOf: () => 0 },
    same_bg: { label: 'Other bank, same bank group', gap: 'tccdl', bgOf: () => 0, bankOf: (k) => k },
    other_bg: { label: 'Other bank group', gap: 'tccds', bgOf: (k) => k % 2, bankOf: (k) => Math.floor(k / 2) },
    row: { label: 'Row cycle (PRAC)' },
  };
  const N_READS = 4;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

  // Per-read event times (ns) from the stage breakdown
  function schedule(m, scen) {
    const tm = m.timing, sv = tm.stagedView, P = tm.pumps;
    // When the staged model does not set tCCD_L, keep its stage split but scale the bank cycle to DreamRAM's tCK
    const scale = tm.staged ? 1 : tm.core_tck / Math.max(sv.bank, sv.shared / P);
    const part = (k) => sv.parts[k] * scale;
    const sh = (k) => (sv.sharedParts[k] || 0) * scale;
    const gap = tm[SCENARIOS[scen].gap];
    // burst on the pins: one atom over the pseudo-channel's data DQs at the pin rate
    const dqData = tm.levels.find((l) => l.key === 'dq').wires / (1 + m.t.md_ecc);
    const tburst = m.p.atom_size / (dqData * tm.dq_rate);
    const reads = [];
    for (let k = 0; k < N_READS; k++) {
      const t0 = k * gap, pumps = [];
      let t = t0;
      for (let j = 0; j < P; j++) {
        const csl = [t, t + part('csl')];
        const ldl = [csl[1], csl[1] + part('ldl')];
        const mdl = [ldl[1], ldl[1] + part('mdl')];
        const iosa = [mdl[1], mdl[1] + part('iosa')];
        const eq = [iosa[1], iosa[1] + part('eq')];
        // each pump's MDL word is corrected (OD-ECC + DBI) and then held on the BG-BUS for one core cycle
        // (tCCD_L per pump, Ryu et al.); the shared stages are paid per pump
        const ecc = [iosa[1], iosa[1] + sh('ecc') / P];
        const bus = [ecc[1], ecc[1] + tm.tccdl / P];
        const busMin = [ecc[1], ecc[1] + sh('bgbus') / P];
        pumps.push({ csl, ldl, mdl, iosa, eq, ecc, bus, busMin });
        t = eq[1]; // the next pump's CSL fires once the lines are equalised (the model's serial bank cycle)
      }
      const busStart = pumps[0].bus[0], busEnd = pumps[P - 1].bus[1];
      const flight = sv.flight * scale;
      const gbus = [busStart + flight, busStart + flight + 2 * tm.tccds]; // ADL: two GBUS sets, 2 × tCCD_S each
      const dq = [t0 + tm.tcl, t0 + tm.tcl + tburst];
      reads.push({ k, t0, bg: SCENARIOS[scen].bgOf(k), bank: SCENARIOS[scen].bankOf(k), pumps, busEnd, gbus, dq });
    }
    return { reads, gap, scale };
  }

  function render(container, m, state) {
    const tm = m && m.timing;
    if (!tm || !tm.stagedView) {
      container.innerHTML = '<div class="tnote">No timing for this design (DreamRAM rejects it before timing is computed).</div>';
      return;
    }
    const P = DR.PALETTES[state.theme];
    const scen = state.scenario || 'same_bg';
    if (scen === 'row') return renderRow(container, m, state, P);
    const S = schedule(m, scen);
    const sv = tm.stagedView, pumps = tm.pumps, share = m.p.mdl_share;
    const bgs = scen === 'other_bg' ? [0, 1] : [0];
    const colors = P.cpl.concat(P.pages);

    // Time axis: the core part, then a break, then the DQ bursts one tCL later
    const coreEnd = Math.max(...S.reads.map((r) => Math.max(r.gbus[1], r.busEnd))) + 0.3;
    const dqStart = S.reads[0].dq[0] - 0.3, dqEnd = S.reads[N_READS - 1].dq[1] + 0.3;
    const W = Math.max(640, container.clientWidth - 24), labelW = 150, breakW = 28;
    const span = coreEnd + (dqEnd - dqStart);
    const sc = (W - labelW - breakW - 16) / span;
    const X = (t) => (t <= coreEnd + 1e-9 ? labelW + t * sc : labelW + coreEnd * sc + breakW + (t - dqStart) * sc);

    const lanes = [];
    lanes.push({ key: 'ck', label: 'CK' });
    lanes.push({ key: 'cmd', label: 'Column command' });
    lanes.push({ key: 'gap', label: '' });
    for (const g of bgs) {
      const tag = bgs.length > 1 ? `BG${g} · ` : '';
      lanes.push({ key: 'csl' + g, label: tag + 'CSL', bg: g });
      lanes.push({ key: 'ldl' + g, label: tag + 'LDL ΔV', bg: g, analog: true });
      lanes.push({ key: 'mdl' + g, label: tag + (share === 2 ? 'MDL ΔV (shared line)' : 'MDL ΔV'), bg: g, analog: true });
      lanes.push({ key: 'iosa' + g, label: tag + (share >= 1 ? 'IOSA (I/O control)' : 'IOSA (bank)'), bg: g });
      if (m.p.od_ecc_logic) lanes.push({ key: 'ecc' + g, label: tag + 'OD-ECC + DBI', bg: g });
      lanes.push({ key: 'bus' + g, label: tag + 'BG-BUS', bg: g });
    }
    lanes.push({ key: 'gbus0', label: 'GBUS-1' });
    lanes.push({ key: 'gbus1', label: 'GBUS-2' });
    lanes.push({ key: 'dq', label: `DQ (${tm.levels.find((l) => l.key === 'dq').wires} per PC)` });
    const LH = 30, top = 44, H = top + lanes.length * LH + 56;
    const laneY = Object.fromEntries(lanes.map((l, i) => [l.key, top + i * LH]));

    const out = [];
    const txt = (x, y, s, cls, anchor) => out.push(`<text x="${x}" y="${y}" class="${cls || ''}" text-anchor="${anchor || 'start'}">${esc(s)}</text>`);
    const box = (key, a, b, color, label, title, opts = {}) => {
      const y = laneY[key] + 6, h = LH - 12, x1 = X(a), x2 = X(b);
      if (x2 - x1 < 0.5) return;
      out.push(`<g><title>${esc(title)}</title><rect x="${x1}" y="${y}" width="${x2 - x1}" height="${h}" rx="3" fill="${color}" fill-opacity="${opts.op || 0.85}"${opts.hatch ? ' class="hatch"' : ''} stroke="${color}"/>`
        + (label && x2 - x1 > label.length * 6 + 6 ? `<text x="${(x1 + x2) / 2}" y="${y + h / 2 + 4}" text-anchor="middle" class="tbox">${esc(label)}</text>` : '') + '</g>');
    };
    // analog ΔV ramp: rise over [r0, r1], hold to f0, fall over [f0, f1]
    const ramp = (key, r0, r1, f0, f1, color, title) => {
      const y0 = laneY[key] + LH - 6, y1 = laneY[key] + 7;
      out.push(`<g><title>${esc(title)}</title><path d="M${X(r0)},${y0} L${X(r1)},${y1} L${X(f0)},${y1} L${X(f1)},${y0}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2"/></g>`);
    };

    // grid, lanes, labels
    for (const l of lanes) {
      const y = laneY[l.key];
      out.push(`<line x1="${labelW}" x2="${W}" y1="${y + LH}" y2="${y + LH}" class="tlane"/>`);
      txt(labelW - 8, y + LH / 2 + 4, l.label, 'tlabel', 'end');
    }
    // CK: one nCK = tCCD_S / 2 (DreamRAM: tCCD_S = 2 nCK, tCCD_L = 4 nCK per pump)
    const nck = tm.tccds / 2 / pumps;
    let ck = `M${X(0)},${laneY.ck + LH - 8}`;
    for (let t = 0, hi = false; t < coreEnd; t += nck / 2, hi = !hi) {
      const y = hi ? laneY.ck + LH - 8 : laneY.ck + 8;
      ck += ` L${X(t)},${y} L${X(Math.min(t + nck / 2, coreEnd))},${y}`;
    }
    out.push(`<path d="${ck}" class="tck"/>`);
    for (let t = 0; t < coreEnd; t += nck) out.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${laneY.dq}" class="tgrid"/>`);
    // axis break
    const xb = labelW + coreEnd * sc;
    out.push(`<rect x="${xb + 2}" y="${top - 6}" width="${breakW - 4}" height="${lanes.length * LH + 12}" class="tbreak"/>`);
    txt(xb + breakW / 2, top - 10, `… tCL ${f2(tm.tcl)} ns …`, 'tsmall', 'middle');

    S.reads.forEach((r, i) => {
      const c = colors[(scen === 'same_bank' ? 0 : i) % colors.length];
      const name = scen === 'same_bank' ? `RD ${i + 1}` : scen === 'same_bg' ? `RD bank ${r.bank}` : `RD BG${r.bg} bank ${r.bank}`;
      // command
      box('cmd', r.t0, r.t0 + nck, c, `RD${i + 1}`, `${name} issued at ${f2(r.t0)} ns`);
      const g = r.bg;
      r.pumps.forEach((pp, j) => {
        const pj = pumps > 1 ? ` pump ${j + 1}/${pumps}` : '';
        box('csl' + g, pp.csl[0], pp.iosa[1], c, `CSL${pumps > 1 ? j + 1 : ''}`, `${name}${pj}: CSL rises in ${f2(pp.csl[1] - pp.csl[0])} ns, held until the IOSA has latched`);
        ramp('ldl' + g, pp.ldl[0], pp.ldl[1], pp.iosa[1], pp.eq[1], c, `${name}${pj}: LDL develops ${f2(pp.ldl[1] - pp.ldl[0])} ns, equalises ${f2(pp.eq[1] - pp.eq[0])} ns`);
        ramp('mdl' + g, pp.mdl[0], pp.mdl[1], pp.iosa[1], pp.eq[1], c, `${name}${pj}: MDL develops ${f2(pp.mdl[1] - pp.mdl[0])} ns (helper flip-flop drives the line), equalises with the LDL`);
        box('iosa' + g, pp.iosa[0], pp.iosa[1], c, '', `${name}${pj}: IOSA resolves in ${f2(pp.iosa[1] - pp.iosa[0])} ns`);
      });
      r.pumps.forEach((pp, j) => {
        const pj = pumps > 1 ? ` pump ${j + 1}/${pumps}` : '', n = pumps > 1 ? j + 1 : '';
        if (m.p.od_ecc_logic) box('ecc' + g, pp.ecc[0], pp.ecc[1], c, `ECC${n}`, `${name}${pj}: OD-ECC + DBI ${f2(pp.ecc[1] - pp.ecc[0])} ns (shared by the bank group)`);
        box('bus' + g, pp.bus[0], pp.bus[1], c, `data${n}`, `${name}${pj}: BG-BUS holds the word for one core cycle (${f2(pp.bus[1] - pp.bus[0])} ns); it needs at least ${f2(pp.busMin[1] - pp.busMin[0])} ns`, { op: 0.35 });
        box('bus' + g, pp.busMin[0], pp.busMin[1], c, '', `${name}${pj}: minimum BG-BUS window ${f2(pp.busMin[1] - pp.busMin[0])} ns (launch + skew)`);
      });
      box('gbus' + (i % 2), r.gbus[0], r.gbus[1], c, `RD${i + 1}`, `${name}: GBUS-${(i % 2) + 1} window 2 × tCCD_S = ${f2(r.gbus[1] - r.gbus[0])} ns (ADL)`);
      box('dq', r.dq[0], r.dq[1], c, `RD${i + 1}`, `${name}: ${m.p.atom_size}-bit burst at ${f2(tm.dq_rate)} Gb/s per pin = ${f2(r.dq[1] - r.dq[0])} ns`);
    });

    // spacing bracket between the first two reads, and what sets it
    const a = S.reads[0].t0, b = S.reads[1].t0, yb = laneY.gap + 8;
    out.push(`<path d="M${X(a)},${yb + 6} L${X(a)},${yb} L${X(b)},${yb} L${X(b)},${yb + 6}" class="tbracket"/>`);
    txt(X(b) + 6, yb + 9, `${SCENARIOS[scen].gap === 'tccdl' ? 'tCCD_L' : 'tCCD_S'} = ${f2(S.gap)} ns`, 'tbrlabel', 'start');

    // legend / explanation
    const bankCyc = pumps * sv.bank * S.scale, sharedT = sv.shared * S.scale;
    const lim = bankCyc >= sharedT ? 'bank cycle' : DR.STAGE_LABELS[Object.entries(sv.sharedParts).sort((x, y) => y[1] - x[1])[0][0]];
    const why = scen === 'same_bank'
      ? `The bank's own CSL/LDL/MDL lines must equalise before its next CSL fires: ${pumps > 1 ? pumps + ' pumps × ' : ''}${f2(sv.bank * S.scale)} ns bank cycle.`
      : scen === 'same_bg'
        ? `Banks in a group overlap their own lines but share ${share >= 1 ? 'the I/O-control IOSAs, ' : ''}${share === 2 ? 'the MDL line, ' : ''}${m.p.od_ecc_logic ? 'OD-ECC/DBI and ' : ''}the BG-BUS (${f2(sharedT)} ns); JEDEC uses one tCCD_L for both cases, so tCCD_L = max(bank cycle ${f2(bankCyc)}, shared ${f2(sharedT)}) — here the ${lim}.`
        : `Different bank groups share only the GBUS/TSV/DQ path, so reads alternate every tCCD_S and each group still sees tCCD_L between its own reads.`;
    const note = tm.staged ? '' : ` Stage split from the staged model, scaled to DreamRAM's ${f2(tm.core_tck)} ns cycle (turn on Parameters → Extensions → "Column-cycle model: Staged" to use it).`;
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="tsvg">
      <defs><pattern id="thatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2" opacity="0.4"/></pattern></defs>
      ${out.join('\n')}
      <text x="${labelW}" y="${H - 30}" class="tsmall">time (ns) · grid = 1 nCK = ${f2(nck)} ns · hover a segment for its duration</text>
    </svg>`;
    container.innerHTML = `<div class="thead">
        <div class="tseg">${Object.entries(SCENARIOS).map(([k, v]) => `<button data-scen="${k}" class="${k === scen ? 'on' : ''}">${v.label}</button>`).join('')}</div>
        <div class="tsum">tCCD_L <b>${f2(tm.tccdl)} ns</b> · tCCD_S <b>${f2(tm.tccds)} ns</b> · bank cycle ${f2(bankCyc)} ns · shared stage ${f2(sharedT)} ns · ${tm.staged ? 'staged model' : 'DreamRAM tCK'}</div>
      </div>
      <div class="twhy">${esc(why)}${esc(note)}</div>
      <div class="twrap">${svg}</div>
      <div class="tstages">${Object.entries(sv.parts).map(([k, v]) => `<span><b>${DR.STAGE_LABELS[k]}</b> ${f2(v * S.scale)} ns</span>`).join('')}
        ${Object.entries(sv.sharedParts).map(([k, v]) => `<span class="sh"><b>${DR.STAGE_LABELS[k]}</b> ${f2(v * S.scale)} ns${pumps > 1 ? ` (${pumps} pumps)` : ''}</span>`).join('')}</div>`;
    container.querySelectorAll('[data-scen]').forEach((btn) => (btn.onclick = () => { state.scenario = btn.dataset.scen; render(container, m, state); }));
  }

  // One activation, ACT -> RD -> PRE -> next ACT, without and with per-row activation counting. With PRAC the
  // activation counter update (internal read, +1, internal write; Kim et al., ISSCC 2023) runs after PRE while the
  // row finishes restoring; the bitlines precharge only after it (DDR5 PRAC timing, DR.PRAC).
  function renderRow(container, m, state, P) {
    const rowTiming = (prac) => DR.compute(Object.assign({}, m.p, { prac }), m.techKey).timing;
    const off = rowTiming(0), on = rowTiming(1);
    if (!off || !on) { container.innerHTML = '<div class="tnote">No timing for this design.</div>'; return; }
    const W = Math.max(640, container.clientWidth - 24), labelW = 150;
    const span = Math.max(off.trc, on.trc) * 1.06;
    const X = (t) => labelW + t * (W - labelW - 16) / span;
    const LH = 28, out = [];
    const c = { cmd: P.cpl[0], wl: P.cpl[1], sense: P.cpl[2], restore: P.cpl[3], acu: P.pages[0], pre: P.pages[1] };
    const txt = (x, y, str, cls, anchor) => out.push(`<text x="${x}" y="${y}" class="${cls || ''}" text-anchor="${anchor || 'start'}">${esc(str)}</text>`);
    const box = (y, a, b, color, label, title) => {
      const x1 = X(a), x2 = X(b), h = LH - 12;
      if (x2 - x1 < 0.5) return;
      out.push(`<g><title>${esc(title)}</title><rect x="${x1}" y="${y + 6}" width="${x2 - x1}" height="${h}" rx="3" fill="${color}" fill-opacity="0.85" stroke="${color}"/>`
        + (label && x2 - x1 > label.length * 6 + 6 ? `<text x="${(x1 + x2) / 2}" y="${y + 6 + h / 2 + 4}" text-anchor="middle" class="tbox">${esc(label)}</text>` : '') + '</g>');
    };
    const bracket = (y, a, b, label) => {
      out.push(`<path d="M${X(a)},${y + 6} L${X(a)},${y} L${X(b)},${y} L${X(b)},${y + 6}" class="tbracket"/>`);
      txt((X(a) + X(b)) / 2, y - 4, label, 'tbrlabel', 'middle');
    };
    let y = 30;
    // vertical grid every 5 ns
    for (let t = 0; t <= span; t += 5) {
      out.push(`<line x1="${X(t)}" x2="${X(t)}" y1="20" y2="${20 + 2 * (6 * LH + 50)}" class="tgrid"/>`);
      txt(X(t), 14, `${t}`, 'tsmall', 'middle');
    }
    const restoreEnd = off.tras; // the cells need the same restore time either way
    for (const [name, tm, prac] of [['Without PRAC', off, false], ['With PRAC', on, true]]) {
      txt(8, y + 4, name, 'tlabel');
      y += 22;
      bracket(y + 4, 0, tm.trcd, `tRCD ${f2(tm.trcd)}`);
      bracket(y + 4, tm.trcd, tm.tras, `→ tRAS ${f2(tm.tras)}`);
      y += 14;
      const lanes = ['Command', 'Wordline', 'Bitlines', ...(prac ? ['Counter (R/H cells)'] : []), 'Precharge'];
      lanes.forEach((l, i) => { txt(8, y + i * LH + LH / 2 + 4, l, 'tlabel'); out.push(`<line x1="${labelW}" x2="${W - 16}" y1="${y + i * LH + LH}" y2="${y + i * LH + LH}" class="tlane"/>`); });
      const L = (k) => y + lanes.indexOf(k) * LH;
      const acu = prac ? tm.acu : 0, preEnd = tm.tras + acu + (tm.trp - acu);
      box(L('Command'), 0, Math.min(1, tm.trcd), c.cmd, 'ACT', 'ACTIVATE');
      box(L('Command'), tm.trcd, tm.trcd + 1, c.cmd, 'RD', 'READ (earliest, tRCD after ACT)');
      box(L('Command'), tm.tras, tm.tras + 1, c.cmd, 'PRE', `PRECHARGE (earliest, tRAS = ${f2(tm.tras)} ns after ACT)`);
      box(L('Command'), tm.trc, tm.trc + 1, c.cmd, 'ACT', `next ACTIVATE to this bank: tRC = tRAS + tRP = ${f2(tm.trc)} ns`);
      box(L('Wordline'), 0, tm.tras + acu, c.wl, 'wordline high', `wordline open for ${f2(tm.tras + acu)} ns${prac ? ' (through the counter update)' : ''}`);
      box(L('Bitlines'), 0, tm.trcd, c.sense, 'sense', `charge sharing + sensing: ${f2(tm.trcd)} ns`);
      box(L('Bitlines'), tm.trcd, restoreEnd, c.restore, 'restore', `restore into the cells until ${f2(restoreEnd)} ns${prac ? ', overlapping the counter update' : ''}`);
      if (prac) {
        const a = tm.tras;
        box(L('Counter (R/H cells)'), a, a + 0.4 * acu, c.acu, 'IRD', 'internal read of the row\'s activation counter through the PRHT IOSA');
        box(L('Counter (R/H cells)'), a + 0.4 * acu, a + 0.6 * acu, c.acu, '+1', 'adder: count + 1, compare with the running maximum');
        box(L('Counter (R/H cells)'), a + 0.6 * acu, a + acu, c.acu, 'IWR', `internal write back; activation counter update = ${f2(acu)} ns`);
      }
      box(L('Precharge'), tm.tras + acu, preEnd, c.pre, 'precharge', `bitline equalise: ${f2(tm.trp - acu)} ns`);
      y += lanes.length * LH + 18;
      bracket(y, tm.tras, tm.trc, `tRP ${f2(tm.trp)}${prac ? ` (incl. counter update ${f2(acu)})` : ''}`);
      y += 12;
      bracket(y + 10, 0, tm.trc, `tRC ${f2(tm.trc)}`);
      y += 40;
    }
    const H = y + 10;
    const d5 = DR.DDR5_PRAC, row = (k, lab) => `<tr><td>${lab}</td><td>${f2(d5.default[k])}</td><td>${f2(d5.prac[k])}</td><td>${f2(off[k])}</td><td>${f2(on[k])}</td></tr>`;
    container.innerHTML = `<div class="thead">
        <div class="tseg">${Object.entries(SCENARIOS).map(([k, v]) => `<button data-scen="${k}" class="${k === 'row' ? 'on' : ''}">${v.label}</button>`).join('')}</div>
        <div class="tsum">counter update <b>${f2(on.acu)} ns</b> · tRC <b>${f2(off.trc)} → ${f2(on.trc)} ns</b> · row-miss latency <b>${f2(off.latency)} → ${f2(on.latency)} ns</b>${m.p.prac ? '' : ' · PRAC is off for this design (shown for comparison)'}</div>
      </div>
      <div class="twhy">Per-row activation counting keeps a ${m.p.prac_bits}-bit counter for every row. After each activation the bank reads it through a small IOSA, adds one and writes it back (PRHT, Kim et al., ISSCC 2023). DDR5 PRAC runs this counter update after PRECHARGE while the row finishes restoring, so tRP grows by the update time, tRAS can end right after sensing, and tRC grows only by what the restore cannot hide. Here the update takes ${f2(DR.PRAC.acu_cycles)} column cycles, the ratio DDR5-3200 shows (21 ns over a 5 ns tCCD_L).</div>
      <div class="twrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="tsvg">${out.join('\n')}</svg></div>
      <div class="twrap"><table class="tref"><thead><tr><th>ns</th><th>DDR5-3200AN</th><th>DDR5 PRAC</th><th>This design</th><th>This design, PRAC</th></tr></thead><tbody>
        <tr><td>tRCD</td><td>${f2(d5.default.trcd)}</td><td>${f2(d5.default.trcd)}</td><td>${f2(off.trcd)}</td><td>${f2(on.trcd)}</td></tr>
        ${row('tras', 'tRAS')}${row('trp', 'tRP')}${row('trc', 'tRC')}${row('trtp', 'tRTP')}${row('twr', 'tWR')}
      </tbody></table></div>`;
    container.querySelectorAll('[data-scen]').forEach((btn) => (btn.onclick = () => { state.scenario = btn.dataset.scen; render(container, m, state); }));
  }

  DR.renderTiming = render;
})();
