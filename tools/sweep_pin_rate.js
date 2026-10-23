#!/usr/bin/env node
// Which HBM4-class bank organisations reach a target pin rate with 32 data DQs per pseudo-channel?
//
// Fixed: 34/36 nm array, 1 SID, 32 channels (8 per die, 4 dies), 2 pseudo-channels, 16 GB per stack,
// 1 KiB host row, 256-bit atom, one channel row. Extensions on: tccd_bgbus (tCCD_L is the slower of the
// bank path and the BG-BUS window), bw_bg_cap and tsv_chain.
//
// Swept: bank groups (vertical × side by side), banks per group, MAT size and count, MDLs per MAT, MDL/CSL
// routing, BLSA/BRVSA and coupled rows; subarrays per bank follow from the capacity.
// Each design keeps 32 data DQs per pseudo-channel: the GBUS→TSV × TSV→DQ serdes product is
// gbus_width / 32, and all the pseudo-channel's bank groups alternate onto the GBUS
// (bgbuses_per_gbus = bank groups). Its pin rate is then 8 × bank groups / tCCD_L (Gb/s, per atom pump).
// The GBUS→TSV split only moves serialisation between the TSVs and the base die, so it changes TSV count
// and area, not the pin rate; it is reported separately for the chosen designs.
//
// Usage: node tools/sweep_pin_rate.js [--rate 32] [--max-die-mm 20] [--csv out.csv]
'use strict';
global.window = {};
require('../js/model.js');
const DR = window.DR;
const fs = require('fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RATE = +arg('--rate', 32), MAX_DIE = +arg('--max-die-mm', 20), CSV = arg('--csv', null);
const TECH = 'hbm4';
DR.TECH_PRESETS.sweep = Object.assign({}, DR.TECH_PRESETS[TECH], { max_die_um: MAX_DIE * 1000 });

// Column-cycle models: DreamRAM's, and progressively less fixed time.
const MODELS = [
  { key: 'dreamram', label: 'DreamRAM: 1 ns fixed + C×L wires', ext: { tck_fixed: 1, tck_fixed_scale: 0, tck_wire: 1 } },
  { key: 'half', label: '0.5 ns fixed, node-scaled + C×L wires', ext: { tck_fixed: 0.5, tck_fixed_scale: 1, tck_wire: 1 } },
  { key: 'half_sq', label: '0.5 ns fixed, node-scaled + L² wires', ext: { tck_fixed: 0.5, tck_fixed_scale: 1, tck_wire: 2 } },
  { key: 'wires', label: 'no fixed time + C×L wires', ext: { tck_fixed: 0, tck_fixed_scale: 0, tck_wire: 1 } },
  // Bracket for the BG-BUS window: tCCD_L from the bank column path only (DreamRAM's own assumption)
  { key: 'half_bankonly', label: '0.5 ns fixed, node-scaled + C×L wires, bank path only (no BG-BUS window)', ext: { tck_fixed: 0.5, tck_fixed_scale: 1, tck_wire: 1, tccd_bgbus: 0 } },
];
const FIXED = { sids: 1, channels: 32, ch_per_die: 8, pch: 2, atom_size: 256, channel_rows: 1, salp_groups: 1,
  tccd_bgbus: 1, bw_bg_cap: 1, tsv_chain: 1, mdl_bgbus_sd: 1, bgbus_gbus_sd: 1, gbus_tsv_sd: 1 };
const GB = 16, PAGE_BITS = 8192;

function* designs() {
  for (const vert_bg of [2, 4, 8]) for (const horiz_bg of [1, 2]) for (const banks of [2, 4, 8])
  for (const mats of [16, 32]) for (const mat_cols of [256, 512, 1024]) for (const mat_rows of [256, 512, 1024])
  for (const ldls_mdls of [8, 16, 32]) for (const mdlcsl of [0, 1, 3]) for (const csl_mdl_shared_layer of [0, 1])
  for (const brvsa of [0, 1]) for (const coupled_rows of [1, 2, 4]) {
    if (mats * mat_cols !== PAGE_BITS * coupled_rows) continue;
    const bits_per_subarray = FIXED.channels * FIXED.pch * vert_bg * horiz_bg * banks * mat_rows * mats * mat_cols;
    const subarrays = GB * 2 ** 33 / bits_per_subarray;
    if (subarrays < 2 || subarrays !== Math.floor(subarrays)) continue;
    yield { vert_bg, horiz_bg, banks, mats, mat_cols, mat_rows, ldls_mdls, mdlcsl, csl_mdl_shared_layer, brvsa, coupled_rows,
      subarrays, pages_per_bgbus_mux: coupled_rows };
  }
}

function evaluate(d, ext, sd = 1) {
  let p = Object.assign({}, FIXED, d, ext);
  const m0 = DR.compute(p, 'sweep');
  if (!m0.timing) return null;
  const S = m0.pages.gbus_width / 32; // serdes product that gives 32 data DQs per pseudo-channel
  p = Object.assign(p, { bgbuses_per_gbus: d.vert_bg * d.horiz_bg, gbus_tsv_sd: sd, tsv_dq_sd: S / sd });
  if (p.tsv_dq_sd < 1) return null;
  const m = DR.compute(p, 'sweep');
  if (!m.timing || m.problems.length) return null;
  const tm = m.timing, s = m.stack, lv = Object.fromEntries(tm.levels.map((l) => [l.key, l]));
  if (lv.dq.wires !== 34) return null; // 32 data + 2 MD-ECC
  return {
    ...d, sd, tsv_dq_sd: p.tsv_dq_sd, bgs: d.vert_bg * d.horiz_bg, pumps: m.pumps,
    tccdl: tm.tccdl, tck_bank: tm.tck_bank, tck_bgbus: tm.tck_bgbus, limiter: tm.limiter, pin: tm.dq_rate,
    bgbus_rate: lv.bgbus.rate, gbus_rate: lv.gbus.rate, tsv_wires: lv.tsv.wires, tsv_rate: lv.tsv.rate,
    die_w: s.die_w / 1000, die_h: s.die_h / 1000, die: s.die_w * s.die_h / 1e6, tsv_mm2: s.die_w * s.tsv_h / 1e6,
    data_tsv_stack: s.data_tsv_count, latency: tm.latency, trcd: tm.trcd, cap: m.capacity,
  };
}

const ref = { vert_bg: 2, horiz_bg: 1, banks: 8, mats: 32, mat_cols: 512, mat_rows: 512, ldls_mdls: 16, mdlcsl: 3,
  csl_mdl_shared_layer: 1, brvsa: 0, coupled_rows: 2, subarrays: 16, pages_per_bgbus_mux: 2 }; // HBM4 · 1 SID · coupled
const f = (v, n = 2) => (+v).toFixed(n);
const org = (r) => `${r.vert_bg}×${r.horiz_bg} BG × ${r.banks} banks, ${r.subarrays} SA × ${r.mat_rows} WL, ${r.mats} × ${r.mat_cols}-BL MATs, ${r.ldls_mdls} MDL, rt ${r.mdlcsl}${r.csl_mdl_shared_layer ? '' : '/2L'}${r.brvsa ? ', BRVSA' : ''}${r.coupled_rows > 1 ? `, coupled ×${r.coupled_rows}` : ''}`;
const rows = [];
console.log(`Target ${RATE} Gb/s per pin, 32 data DQs per pseudo-channel, ${GB} GB, die limit ${MAX_DIE} mm\n`);
for (const M of MODELS) {
  const all = [];
  for (const d of designs()) { const r = evaluate(d, M.ext); if (r) all.push(r); }
  const R = evaluate(ref, M.ext);
  const ok = all.filter((r) => r.pin >= RATE - 1e-9).sort((a, b) => a.die - b.die);
  const fastest = all.reduce((a, b) => (b.tccdl < a.tccdl ? b : a));
  const minBG = {};
  for (const r of all) minBG[r.bgs] = Math.min(minBG[r.bgs] ?? 99, r.tccdl);
  console.log(`== ${M.label}`);
  console.log(`  valid designs ${all.length}; reach ${RATE} Gb/s: ${ok.length}`);
  console.log(`  HBM4 reference: tCCD_L ${f(R.tccdl)} ns (fixed share ${f(DR.compute(Object.assign({}, FIXED, ref, M.ext), 'sweep').timing.tck_fixed)}), pin ${f(R.pin)} Gb/s, die ${f(R.die, 1)} mm²`);
  console.log(`  fastest tCCD_L ${f(fastest.tccdl)} ns: ${org(fastest)}, die ${f(fastest.die, 1)} mm²`);
  console.log(`  fastest tCCD_L by bank groups per PC: ${Object.entries(minBG).map(([b, t]) => `${b} BGs ${f(t)} ns → ${f(8 * b / t, 1)} Gb/s`).join(' · ')}`);
  for (const r of ok.slice(0, 3)) {
    console.log(`  ✓ ${org(r)}\n      tCCD_L ${f(r.tccdl)} ns (${r.limiter}), pin ${f(r.pin, 1)} Gb/s, die ${f(r.die_w)} × ${f(r.die_h)} = ${f(r.die, 1)} mm² (${f(100 * (r.die / R.die - 1), 0)}% vs HBM4), latency ${f(r.latency, 1)} ns`
      + `\n      per PC: BG-BUS ${r.tsv_wires} × ${f(r.bgbus_rate)} · GBUS ${r.tsv_wires} × ${f(r.gbus_rate)} · TSV ${r.tsv_wires} × ${f(r.tsv_rate)} Gb/s · DQ 34 × ${f(r.pin, 1)}`);
  }
  if (ok.length) {
    const best = ok[0];
    console.log('    GBUS→TSV split for the smallest design (TSVs per PC × Gb/s, TSV region, die):');
    for (const sd of [0.25, 0.5, 1, 2, 4, 8]) {
      const r = evaluate(best, M.ext, sd);
      if (r) console.log(`      sd ${sd}: ${r.tsv_wires} × ${f(r.tsv_rate)} Gb/s, TSV→DQ ${r.tsv_dq_sd}:1, ${f(r.data_tsv_stack, 0)} data TSVs/die, TSV region ${f(r.tsv_mm2, 1)} mm², die ${f(r.die, 1)} mm²`);
    }
  }
  console.log('');
  for (const r of all) rows.push({ model: M.key, ...r });
}
if (CSV) {
  const keys = Object.keys(rows[0]);
  fs.writeFileSync(CSV, [keys.join(','), ...rows.map((r) => keys.map((k) => r[k]).join(','))].join('\n') + '\n');
  console.log('wrote', CSV, rows.length, 'rows');
}
