#!/usr/bin/env python3
"""
What does scaling HBM4's pin rate from 8 to 32 Gb/s imply, and which interface changes buy the most at 32 Gb/s?

Same stack as tools/sweep_pin_rate.py: 34/36 nm array, 1 SID, 32 channels on 4 dies, 16 GB (32 Gb per die), 1 KiB
host row, 2,048 data DQs per stack. Every design is evaluated by DreamRAM through tools/export_floorplan.py with the
staged column-cycle model (tccd_staged), so tCCD_L = pumps x max(bank cycle, shared bank-group stage per pump).

Interface options ("breaks" relative to HBM4) fix what the host sees: pseudo-channels per channel (and so data DQs
per pseudo-channel), column access size, bank groups and banks per pseudo-channel. Everything else is swept: MAT
size and count, MDLs per MAT, CSL/MDL routing, BLSA/BRVSA, coupled rows and the bank-group layout. The GBUS->TSV
serdes is chosen per design as the fewest TSVs that keep every TSV at or below --tsv-rate.

Rate model (DreamRAM leaves the interleaving between bank groups open; tCCD_S is tCCD_L / 2 there):
  burst  tB = access bits / (data DQs per PC x pin rate)       one access per tB per pseudo-channel, tCCD_S = tB
  groups G alternate round robin, so each bank group gets one access per G x tB:   tCCD_L <= G x tB
  -> max pin rate = access bits x G / (data DQs per PC x tCCD_L)
Reported alongside, not used as filters:
  CK = pin rate / 4 (HBM4), column-command bus use = PCs per channel / (tB in CK cycles), one CK per command
  GBUS sets: each set holds one access for k x tB; Ryu et al. (HBM3, 16 nm) found a 1 ns GBUS window too short and
  used two sets for 2 ns, so the minimum window is taken as 1-2 ns at 16 nm, scaled by FO4 (f / 16 nm)^0.9.

Usage:
  python3 tools/sweep_interface.py --dreamram /path/to/DreamRAM [--rates 8,16,24,32] [--options hbm4,a64,...]
"""
import argparse
import contextlib
import csv
import io
import itertools
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_floorplan as E  # noqa: E402
import sweep_pin_rate as SW  # noqa: E402

GB, PAGE_BITS, CHANNELS, DQ_CH = 16, 8192, 32, 64  # DQ_CH: data DQs per channel (HBM4: 2 PCs x 32)
FIXED = dict(sids=1, channels=CHANNELS, ch_per_die=8, channel_rows=1, salp_groups=1, tccd_bgbus=1, bw_bg_cap=1,
             tsv_chain=1, mdl_bgbus_sd=1, bgbus_gbus_sd=1, tccd_staged=1)
MODELS = {
    'staged_bank': ('per-bank IOSA', dict(mdl_share=0)),
    'staged_bank_mid': ('per-bank IOSA, mid-bank column decoder', dict(mdl_share=0, col_mid=1)),
    'staged_ioctl': ('IOSA shared at the I/O control (HBM3 calibration)', dict(mdl_share=1)),
}
LAYOUTS = {2: [(2, 1), (1, 2)], 4: [(4, 1), (2, 2)], 8: [(8, 1), (4, 2)]}
# Interface options: pseudo-channels per channel, access bits, bank groups per PC, banks per PC, and what changes vs HBM4
OPTIONS = {
    'hbm4': (2, 256, 2, [16], 'HBM4 interface: 2 PCs x 32 DQ, 32 B access, 2 bank groups x 8 banks'),
    'bg4': (2, 256, 4, [16, 32], '4 bank groups per PC (JEDEC groups 32-bank devices this way), 32 B access'),
    'bg8': (2, 256, 8, [16, 32], '8 bank groups per PC, 32 B access'),
    'a64': (2, 512, 2, [16], '64 B access (BL16), 2 bank groups'),
    'a64_bg4': (2, 512, 4, [16, 32], '64 B access and 4 bank groups'),
    'pc4': (4, 256, 2, [8, 16], '4 PCs x 16 DQ per channel, 32 B access (BL16), 2 bank groups'),
    'pc4_bg4': (4, 256, 4, [8, 16], '4 PCs x 16 DQ per channel, 32 B access, 4 bank groups'),
}


def internal_designs(pch, bgs, banks_pc, access):
    for (v, h), bpc, mats, mat_cols, mat_rows, ldls, mdlcsl, shared, brvsa, coupled in itertools.product(
            LAYOUTS[bgs], banks_pc, [16, 32, 64], [256, 512, 1024], [256, 512, 1024], [8, 16, 32, 64], [0, 1, 3],
            [0, 1], [0, 1], [1, 2, 4]):
        if mats * mat_cols != PAGE_BITS * coupled or bpc % bgs:
            continue
        if mats * ldls / coupled > access:  # one column cycle may not deliver more than the access (DreamRAM status 6)
            continue
        banks = bpc // bgs
        sub = GB * 2 ** 33 / (CHANNELS * pch * bgs * banks * mat_rows * mats * mat_cols)
        if sub < 2 or sub != int(sub):
            continue
        yield dict(vert_bg=v, horiz_bg=h, banks=banks, mats=mats, mat_cols=mat_cols, mat_rows=mat_rows, ldls_mdls=ldls,
                   mdlcsl=mdlcsl, csl_mdl_shared_layer=shared, brvsa=brvsa, coupled_rows=coupled, subarrays=int(sub),
                   pages_per_bgbus_mux=coupled, atom_size=access)


def tsv_split(gbus_bits, dq_pc, rate, tsv_max):
    """Largest GBUS->TSV serdes (fewest TSVs) keeping each TSV at or below tsv_max Gb/s; None if 1:1 is too fast."""
    best = None
    for sd in (0.25, 0.5, 1, 2, 4, 8, 16, 32):
        tsvs = gbus_bits / sd
        if tsvs != int(tsvs) or tsvs < dq_pc or tsvs / dq_pc != int(tsvs / dq_pc):  # integer TSV->DQ serdes
            continue
        if dq_pc * rate / tsvs <= tsv_max + 1e-9:
            best = sd
    return best


def evaluate(a, opt, d, model, rate):
    pch, access, bgs, _, _ = OPTIONS[opt]
    dq_pc = DQ_CH // pch
    gbus_bits = d['mats'] * d['ldls_mdls'] / d['coupled_rows']
    sd = tsv_split(gbus_bits, dq_pc, rate, a.tsv_rate)
    if sd is None:
        return None
    p = dict(FIXED, **{k: v for k, v in d.items() if k != 'mdlcsl'}, **MODELS[model][1], pch=pch,
             mdl_over_mat=d['mdlcsl'] & 1, csl_mdl_over_mat=d['mdlcsl'] >> 1, bgbuses_per_gbus=bgs,
             gbus_tsv_sd=sd, tsv_dq_sd=gbus_bits / (dq_pc * sd))
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            dram, tech, _, m, status = E.build(a.dreamram, SW.MEM, SW.TECH, p, a.max_die_mm)
    except (AssertionError, ValueError, ZeroDivisionError):
        return None
    if status != 0 or dram.dq_count() / (CHANNELS * pch) != dq_pc * dram.md_ecc_factor():
        return None
    bank, shared, _, sh = dram.staged(tech)
    pumps = dram.pumps_per_atom()
    tccdl = m['tccdl']
    rmax = access * bgs / (dq_pc * tccdl)
    tb = access / (dq_pc * rate)
    fo4 = (tech.f / 0.016) ** tech.logic_scale_conf
    dies, die_w, non_tsv, cmd_y, data_y, other_y = dram.calc_stack_dims(tech)
    die_h = non_tsv + cmd_y + data_y + other_y
    e_closed = m['metric_e_per_bit_closed']
    return dict(option=opt, model=model, rate=rate, **{k: d[k] for k in d}, bgs=bgs, banks_pc=bgs * d['banks'], pch=pch,
                dq_pc=dq_pc, access=access, pumps=pumps, tccdl=tccdl, tccdl_need=bgs * tb, rmax=rmax,
                limiter='bank cycle' if pumps * bank >= shared else SW.STAGE_NAMES[max(sh, key=sh.get)],
                gbus_sd=sd, tsvs_pc=int(gbus_bits / sd), tsv_rate=dq_pc * rate / (gbus_bits / sd),
                gbus_sets=f'{math.ceil(1.0 * fo4 / tb - 1e-9)}-{math.ceil(2.0 * fo4 / tb - 1e-9)}',
                ck_ghz=rate / 4, ca_use=pch / (tb * rate / 4),
                die_w=die_w / 1000, die_h=die_h / 1000, die=die_w * die_h / 1e6, tsv_mm2=die_w * (cmd_y + data_y + other_y) / 1e6,
                latency=m['worst_latency_ns'], e_closed=e_closed, power=e_closed * 1e-12 * DQ_CH * CHANNELS * rate * 1e9)


def org(r):
    return (f"{r['vert_bg']}x{r['horiz_bg']} BG x {r['banks']} banks, {r['subarrays']} SA x {r['mat_rows']} WL, "
            f"{r['mats']} x {r['mat_cols']}-BL MATs, {r['ldls_mdls']} MDL, rt {r['mdlcsl']}"
            f"{'' if r['csl_mdl_shared_layer'] else '/2L'}{', BRVSA' if r['brvsa'] else ''}"
            f"{', coupled x%d' % r['coupled_rows'] if r['coupled_rows'] > 1 else ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dreamram', required=True)
    ap.add_argument('--rates', default='8,16,24,32', help='target pin rates, Gb/s')
    ap.add_argument('--options', default=','.join(OPTIONS), help='interface options: ' + ', '.join(OPTIONS))
    ap.add_argument('--models', default=','.join(MODELS))
    ap.add_argument('--tsv-rate', type=float, default=8, help='max Gb/s per data TSV')
    ap.add_argument('--max-die-mm', type=float, default=20, help='DreamRAM die-size filter')
    ap.add_argument('--csv', help='write every passing design to this CSV')
    a = ap.parse_args()
    a.dreamram = os.path.abspath(a.dreamram)
    rates = [float(x) for x in a.rates.split(',')]
    f = lambda v, n=2: f'{v:.{n}f}'  # noqa: E731
    rows = []
    print(f'16 GB, 2048 data DQs, 1 KiB host row, TSVs <= {f(a.tsv_rate, 0)} Gb/s each, die limit {f(a.max_die_mm, 0)} mm\n')
    for opt in a.options.split(','):
        pch, access, bgs, banks_pc, label = OPTIONS[opt]
        cands = list(internal_designs(pch, bgs, banks_pc, access))
        print(f'== {opt}: {label} ({len(cands)} internal designs)')
        for model in a.models.split(','):
            for rate in rates:
                res = [r for r in (evaluate(a, opt, d, model, rate) for d in cands) if r]
                ok = sorted((r for r in res if r['rmax'] >= rate - 1e-9), key=lambda r: r['die'])
                best = max(res, key=lambda r: r['rmax']) if res else None
                line = f"  {MODELS[model][0]:48s} {f(rate, 0):>3} Gb/s: {len(ok):4d} pass"
                if best:
                    line += f" (fastest {f(best['rmax'], 1)} Gb/s, {best['limiter']})"
                if ok:
                    r = ok[0]
                    line += (f"\n      smallest: {org(r)}\n      tCCD_L {f(r['tccdl'])} ns (needs <= {f(r['tccdl_need'])}), "
                             f"die {f(r['die_w'])} x {f(r['die_h'])} = {f(r['die'], 1)} mm², TSVs/PC {r['tsvs_pc']} x "
                             f"{f(r['tsv_rate'], 1)} Gb/s (TSV {f(r['tsv_mm2'], 1)} mm²), latency {f(r['latency'], 1)} ns, "
                             f"{f(r['e_closed'])} pJ/b -> {f(r['power'], 0)} W, CK {f(r['ck_ghz'], 0)} GHz, "
                             f"CA {f(100 * r['ca_use'], 0)}%, GBUS sets {r['gbus_sets']}")
                print(line)
                rows += ok
        print()
    if a.csv and rows:
        with open(a.csv, 'w', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        print('wrote', a.csv, len(rows), 'rows')


if __name__ == '__main__':
    main()
