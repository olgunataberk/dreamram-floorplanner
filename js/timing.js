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
        pumps.push({ csl, ldl, mdl, iosa, eq });
        t = eq[1]; // the next pump's CSL fires once the lines are equalised (the model's serial bank cycle)
      }
      const lastIosa = pumps[P - 1].iosa[1];
      const ecc = [lastIosa, lastIosa + sh('ecc')];
      const busStart = ecc[1];
      const bus = [busStart, busStart + tm.tccdl]; // BG-BUS holds each atom for one tCCD_L window (Ryu et al.)
      const busMin = [busStart, busStart + sh('bgbus')];
      const flight = sv.flight * scale;
      const gbus = [busStart + flight, busStart + flight + 2 * tm.tccds]; // ADL: two GBUS sets, 2 × tCCD_S each
      const dq = [t0 + tm.tcl, t0 + tm.tcl + tburst];
      reads.push({ k, t0, bg: SCENARIOS[scen].bgOf(k), bank: SCENARIOS[scen].bankOf(k), pumps, ecc, bus, busMin, gbus, dq });
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
    const S = schedule(m, scen);
    const sv = tm.stagedView, pumps = tm.pumps, share = m.p.mdl_share;
    const bgs = scen === 'other_bg' ? [0, 1] : [0];
    const colors = P.cpl.concat(P.pages);

    // Time axis: the core part, then a break, then the DQ bursts one tCL later
    const coreEnd = Math.max(...S.reads.map((r) => Math.max(r.gbus[1], r.bus[1]))) + 0.3;
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
      if (m.p.od_ecc_logic) box('ecc' + g, r.ecc[0], r.ecc[1], c, 'ECC', `${name}: OD-ECC + DBI ${f2(r.ecc[1] - r.ecc[0])} ns (shared by the bank group)`);
      box('bus' + g, r.bus[0], r.bus[1], c, 'data', `${name}: BG-BUS holds the atom for one tCCD_L (${f2(tm.tccdl)} ns); it needs at least ${f2(r.busMin[1] - r.busMin[0])} ns`, { op: 0.35 });
      box('bus' + g, r.busMin[0], r.busMin[1], c, '', `${name}: minimum BG-BUS window ${f2(r.busMin[1] - r.busMin[0])} ns (launch + skew)`);
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
        ${Object.entries(sv.sharedParts).map(([k, v]) => `<span class="sh"><b>${DR.STAGE_LABELS[k]}</b> ${f2(v * S.scale)} ns</span>`).join('')}</div>`;
    container.querySelectorAll('[data-scen]').forEach((btn) => (btn.onclick = () => { state.scenario = btn.dataset.scen; render(container, m, state); }));
  }

  DR.renderTiming = render;
})();
