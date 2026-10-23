#!/usr/bin/env python3
"""
Which HBM4-class bank organisations reach a target pin rate with 32 data DQs per pseudo-channel?

Every design is evaluated by DreamRAM itself (through tools/export_floorplan.py and its extensions), so
this needs a DreamRAM checkout but nothing beyond Python and DreamRAM's own requirements.

Fixed: 34/36 nm array, 1 SID, 32 channels (8 per die, 4 dies), 2 pseudo-channels, 16 GB per stack,
1 KiB host row, one channel row. Extensions on: tccd_bgbus (tCCD_L is the slower of the bank path and
the BG-BUS window; one column-cycle model turns it off), bw_bg_cap and tsv_chain. The staged models
(tccd_staged) replace both stages with the staged column cycle, for three IOSA / column-decoder placements.

Swept: bank groups (vertical x side by side), banks per group, MAT size and count, MDLs per MAT,
MDL/CSL routing, BLSA/BRVSA, coupled rows and the column access size (atom); subarrays per bank follow
from the capacity. Each design keeps 32 data DQs per pseudo-channel: the GBUS->TSV x TSV->DQ serdes
product is gbus_width / 32, and all the pseudo-channel's bank groups alternate onto the GBUS
(bgbuses_per_gbus = bank groups). Its pin rate is then atom x bank groups / (32 x tCCD_L).
The GBUS->TSV split only moves serialisation between the TSVs and the base die, so it changes TSV count
and area, not the pin rate; it is reported separately for the smallest passing design.

Usage:
  python3 tools/sweep_pin_rate.py --dreamram /path/to/DreamRAM [--rate 32] [--max-die-mm 20] [--csv out.csv]
  # only 2 bank groups, larger column accesses, wider bank/MAT ranges:
  python3 tools/sweep_pin_rate.py --dreamram /path/to/DreamRAM --bank-groups 2x1,1x2 --banks 2,4,8,16 \\
      --mats 16,32,64 --ldls 8,16,32,64 --atoms 256,512,1024 --max-die-mm 40
"""
import argparse
import contextlib
import csv
import io
import itertools
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_floorplan as E  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = 'configs/mem/sweep/hbm_sweep_default.json'
TECH = os.path.join(ROOT, 'configs', 'tech', 'hbm4_34wl_36bl.json')

# Column-cycle models: DreamRAM's, and progressively less fixed time
MODELS = [
    ('dreamram', 'DreamRAM: 1 ns fixed + CxL wires', dict(tck_fixed=1, tck_fixed_scale=0, tck_wire=1)),
    ('half', '0.5 ns fixed, node-scaled + CxL wires', dict(tck_fixed=0.5, tck_fixed_scale=1, tck_wire=1)),
    ('half_sq', '0.5 ns fixed, node-scaled + L^2 wires', dict(tck_fixed=0.5, tck_fixed_scale=1, tck_wire=2)),
    ('wires', 'no fixed time + CxL wires', dict(tck_fixed=0, tck_fixed_scale=0, tck_wire=1)),
    # bracket for the BG-BUS window: tCCD_L from the bank column path only (DreamRAM's own assumption)
    ('half_bankonly', '0.5 ns fixed, node-scaled + CxL wires, bank path only (no BG-BUS window)',
     dict(tck_fixed=0.5, tck_fixed_scale=1, tck_wire=1, tccd_bgbus=0)),
    # staged model (tccd_staged): max(pumps x bank cycle, shared bank-group stage), by where the IOSA sits
    ('staged_ioctl', 'staged: IOSA shared at the I/O control (HBM3 calibration)', dict(tccd_staged=1, mdl_share=1)),
    ('staged_bank', 'staged: per-bank IOSA', dict(tccd_staged=1, mdl_share=0)),
    ('staged_bank_mid', 'staged: per-bank IOSA, mid-bank column decoder', dict(tccd_staged=1, mdl_share=0, col_mid=1)),
]
STAGE_NAMES = {'ecc': 'OD-ECC + DBI', 'bgbus': 'BG-BUS window', 'iosa_shared': 'shared IOSA', 'mdl_line': 'shared MDL line'}
FIXED = dict(sids=1, channels=32, ch_per_die=8, pch=2, channel_rows=1, salp_groups=1, tccd_bgbus=1, bw_bg_cap=1,
             tsv_chain=1, mdl_bgbus_sd=1, bgbus_gbus_sd=1, gbus_tsv_sd=1)
GB, PAGE_BITS, DQ_DATA = 16, 8192, 32
# HBM4 · 1 SID · coupled (the bundled example), the reference for die-size comparisons
REF = dict(vert_bg=2, horiz_bg=1, banks=8, mats=32, mat_cols=512, mat_rows=512, ldls_mdls=16, mdlcsl=3,
           csl_mdl_shared_layer=1, brvsa=0, coupled_rows=2, subarrays=16, pages_per_bgbus_mux=2, atom_size=256)
DESIGN_KEYS = list(REF)


def ints(s):
    return [int(x) for x in s.split(',')]


def designs(a):
    for (vert_bg, horiz_bg), banks, mats, mat_cols, mat_rows, ldls, mdlcsl, shared, brvsa, coupled, atom in itertools.product(
            a.bank_groups, a.banks, a.mats, [256, 512, 1024], [256, 512, 1024], a.ldls, [0, 1, 3], [0, 1], [0, 1],
            [1, 2, 4], a.atoms):
        if mats * mat_cols != PAGE_BITS * coupled:
            continue
        sub = GB * 2 ** 33 / (FIXED['channels'] * FIXED['pch'] * vert_bg * horiz_bg * banks * mat_rows * mats * mat_cols)
        if sub < 2 or sub != int(sub):
            continue
        yield dict(vert_bg=vert_bg, horiz_bg=horiz_bg, banks=banks, mats=mats, mat_cols=mat_cols, mat_rows=mat_rows,
                   ldls_mdls=ldls, mdlcsl=mdlcsl, csl_mdl_shared_layer=shared, brvsa=brvsa, coupled_rows=coupled,
                   subarrays=int(sub), pages_per_bgbus_mux=coupled, atom_size=atom)


def evaluate(a, d, ext, sd=1):
    """DreamRAM evaluation of design d under column-cycle model ext; None if discarded or not 32 data DQs."""
    gbus = d['mats'] * d['ldls_mdls'] / d['coupled_rows']  # GBUS bits per pseudo-channel (serdes 1 up to the GBUS)
    s = gbus / DQ_DATA  # serdes product GBUS -> DQ that leaves 32 data DQs per pseudo-channel
    if s / sd < 1:
        return None
    p = dict(FIXED, **{k: v for k, v in d.items() if k != 'mdlcsl'}, **ext,
             mdl_over_mat=d['mdlcsl'] & 1, csl_mdl_over_mat=d['mdlcsl'] >> 1,
             bgbuses_per_gbus=d['vert_bg'] * d['horiz_bg'], gbus_tsv_sd=sd, tsv_dq_sd=s / sd)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            dram, tech, _, m, status = E.build(a.dreamram, MEM, TECH, p, a.max_die_mm)
    except (AssertionError, ValueError, ZeroDivisionError):
        return None
    if status != 0:
        return None
    pcs = p['channels'] * p['pch']
    if dram.dq_count() / pcs != DQ_DATA * dram.md_ecc_factor():  # 32 data + 2 MD-ECC
        return None
    n = dram.wire_counts()
    tck = dram.core_tck(tech)
    r_bg = p['mdl_bgbus_sd'] / tck
    r_gbus = r_bg * p['bgbus_gbus_sd'] * p['bgbuses_per_gbus']
    dies, die_w, non_tsv, cmd_y, data_y, other_y = dram.calc_stack_dims(tech)
    die_h = non_tsv + cmd_y + data_y + other_y
    if p.get('tccd_staged'):
        # staged: bank cycle vs the shared stage, both per pump (tck_bank, tck_shared)
        bank, shared, _, sh = dram.staged(tech)
        t_bank, t_bus = bank, shared / dram.pumps_per_atom()
        limiter = 'bank cycle' if t_bank >= t_bus else STAGE_NAMES[max(sh, key=sh.get)]
    else:
        t_bank, t_bus = dram.bank_stage_tck(tech), dram.bgbus_stage_tck(tech)
        limiter = 'BG-BUS window' if p['tccd_bgbus'] and t_bus > t_bank else 'bank column path'
    return dict(d, sd=sd, tsv_dq_sd=s / sd, bgs=d['vert_bg'] * d['horiz_bg'], pumps=dram.pumps_per_atom(),
                tccdl=m["tccdl"], tck_bank=t_bank, tck_shared=t_bus,
                limiter=limiter,
                pin=m['dq_datarate_gbps'], bw=m['bw_gbytes'],
                bgbus_wires=int(n['bgbus']), bgbus_rate=r_bg, gbus_wires=int(n['gbus']), gbus_rate=r_gbus,
                tsv_wires=int(n['tsv']), tsv_rate=r_gbus * sd,
                die_w=die_w / 1000, die_h=die_h / 1000, die=die_w * die_h / 1e6, tsv_mm2=die_w * (cmd_y + data_y + other_y) / 1e6,
                data_tsv_die=dram.channels * (p['pch'] * dram.gbus_width() / sd * dram.md_ecc_factor()
                                              + (dram.dbi_factor - 1) * p['pch'] * dram.gbus_width() / sd + 24),
                latency=m['worst_latency_ns'], trcd=m['trcd'], power=m['worst_power_w'],
                e_closed=m['metric_e_per_bit_closed'], cap=m['capacity_gbytes'])


def org(r):
    return (f"{r['vert_bg']}x{r['horiz_bg']} BG x {r['banks']} banks, {r['subarrays']} SA x {r['mat_rows']} WL, "
            f"{r['mats']} x {r['mat_cols']}-BL MATs, {r['ldls_mdls']} MDL, rt {r['mdlcsl']}"
            f"{'' if r['csl_mdl_shared_layer'] else '/2L'}{', BRVSA' if r['brvsa'] else ''}"
            f"{', coupled x%d' % r['coupled_rows'] if r['coupled_rows'] > 1 else ''}, {r['atom_size']}-bit access")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dreamram', required=True, help='path to the DreamRAM checkout')
    ap.add_argument('--rate', type=float, default=32, help='target pin rate, Gb/s')
    ap.add_argument('--max-die-mm', type=float, default=20, help='die-size filter (DreamRAM default is 13)')
    ap.add_argument('--bank-groups', default='2x1,2x2,4x1,4x2,8x1,8x2',
                    help='bank groups per pseudo-channel as vertical x side-by-side pairs')
    ap.add_argument('--banks', default='2,4,8', help='banks per bank group')
    ap.add_argument('--mats', default='16,32', help='MATs per subarray row')
    ap.add_argument('--ldls', default='8,16,32', help='MDLs per MAT')
    ap.add_argument('--atoms', default='256', help='column access size(s) in bits (HBM4: 256 = 32 B)')
    ap.add_argument('--models', default=','.join(k for k, _, _ in MODELS), help='column-cycle models to run')
    ap.add_argument('--csv', help='write every valid design and model to this CSV')
    a = ap.parse_args()
    a.dreamram = os.path.abspath(a.dreamram)
    a.bank_groups = [tuple(int(x) for x in bg.split('x')) for bg in a.bank_groups.split(',')]
    a.banks, a.mats, a.ldls, a.atoms = ints(a.banks), ints(a.mats), ints(a.ldls), ints(a.atoms)
    models = [m for m in MODELS if m[0] in a.models.split(',')]
    out_csv = os.path.abspath(a.csv) if a.csv else None

    cands = list(designs(a))
    f = lambda v, n=2: f'{v:.{n}f}'  # noqa: E731
    print(f'Target {f(a.rate, 0)} Gb/s per pin, {DQ_DATA} data DQs per pseudo-channel, {GB} GB, die limit {f(a.max_die_mm, 0)} mm')
    print(f"Bank groups {', '.join('%dx%d' % bg for bg in a.bank_groups)}; banks {a.banks}; MATs {a.mats}; MDLs {a.ldls}; "
          f'access {a.atoms} bits; {len(cands)} candidate designs\n')
    rows = []
    for key, label, ext in models:
        allr = [r for r in (evaluate(a, d, ext) for d in cands) if r]
        ref = evaluate(a, dict(REF), ext)
        print(f'== {label}')
        for atom in a.atoms:
            sub = [r for r in allr if r['atom_size'] == atom]
            ok = sorted((r for r in sub if r['pin'] >= a.rate - 1e-9), key=lambda r: r['die'])
            tag = f'  [{atom}-bit access] ' if len(a.atoms) > 1 else '  '
            print(f'{tag}valid designs {len(sub)}; reach {f(a.rate, 0)} Gb/s: {len(ok)}')
            if not sub:
                continue
            fast = max(sub, key=lambda r: r['pin'])
            quick = min(sub, key=lambda r: r['tccdl'])
            print(f"    fastest pin: {f(fast['pin'], 1)} Gb/s, tCCD_L {f(fast['tccdl'])} ns ({fast['limiter']}): {org(fast)}")
            print(f"    fastest tCCD_L: {f(quick['tccdl'])} ns ({quick['limiter']}), {f(quick['pin'], 1)} Gb/s: {org(quick)}")
            by_bg = {}
            for r in sub:
                by_bg[r['bgs']] = max(by_bg.get(r['bgs'], 0), r['pin'])
            print('    fastest by bank groups per PC: ' + ' · '.join(f'{b} BGs {f(v, 1)} Gb/s' for b, v in sorted(by_bg.items())))
            for r in ok[:3]:
                print(f"    ✓ {org(r)}\n        tCCD_L {f(r['tccdl'])} ns ({r['limiter']}), pin {f(r['pin'], 1)} Gb/s, "
                      f"die {f(r['die_w'])} x {f(r['die_h'])} = {f(r['die'], 1)} mm²"
                      + (f" ({f(100 * (r['die'] / ref['die'] - 1), 0)}% vs HBM4 coupled)" if ref else '')
                      + f", latency {f(r['latency'], 1)} ns, power {f(r['power'], 0)} W"
                      + f"\n        per PC: BG-BUS {r['bgbus_wires']} x {f(r['bgbus_rate'])} · GBUS {r['gbus_wires']} x "
                      f"{f(r['gbus_rate'])} · TSV {r['tsv_wires']} x {f(r['tsv_rate'])} Gb/s · DQ 34 x {f(r['pin'], 1)}")
            if ok:
                print('    GBUS->TSV split for the smallest design (TSVs per PC x Gb/s, TSV region, die):')
                for sd in (0.25, 0.5, 1, 2, 4, 8):
                    r = evaluate(a, {k: ok[0][k] for k in DESIGN_KEYS}, ext, sd)
                    if r:
                        print(f"      sd {sd}: {r['tsv_wires']} x {f(r['tsv_rate'])} Gb/s, TSV->DQ {f(r['tsv_dq_sd'], 0)}:1, "
                              f"{f(r['data_tsv_die'], 0)} data TSVs/die, TSV region {f(r['tsv_mm2'], 1)} mm², die {f(r['die'], 1)} mm²")
        if ref:
            print(f"  HBM4 coupled reference: tCCD_L {f(ref['tccdl'])} ns, pin {f(ref['pin'])} Gb/s, die {f(ref['die'], 1)} mm²")
        print()
        rows += [dict(model=key, **r) for r in allr]
    if out_csv and rows:
        with open(out_csv, 'w', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print('wrote', out_csv, len(rows), 'rows')


if __name__ == '__main__':
    main()
