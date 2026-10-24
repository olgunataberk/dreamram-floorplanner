#!/usr/bin/env python3
"""
What sets the cost of per-row activation counting, and of the on-die ECC it may have to go through?

Takes bundled designs (examples/*.json), turns on the structural PRAC model (prac_model = 1) and changes one design
decision at a time from a base: update after PRE on a per-bank path with an unprotected 12-bit counter. Reports the
activation counter update (ACU) by component and what it does to tRP / tRAS / tRC, row-miss latency and die area.
A second table varies the structural OD-ECC engine (symbol size, correction strength, codewords, decoder location,
pipelining) on the staged column-cycle model and reports the ECC stage, tCCD_L, pin rate and area.

Usage:
  python3 tools/prac_study.py --dreamram /path/to/DreamRAM [--designs hbm3_baseline,hbm4_1sid_coupled,...] [--md out.md]
"""
import argparse
import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_floorplan as E  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = 'configs/mem/sweep/hbm_sweep_default.json'
BASE = dict(prac=1, prac_model=1, prac_when=0, prac_path=0, prac_prot=0, prac_bits=12)
PRAC_CASES = [
    ('Off', dict(prac=0)),
    ('DDR5 ratio (4.2 column cycles)', dict(prac_model=0)),
    ('Base: after PRE, per-bank path, no protection', {}),
    ('While the row is open (PRHT)', dict(prac_when=1)),
    ('Counter subarray (Chronus)', dict(prac_when=2)),
    ('Shared I/O-control path', dict(prac_path=1)),
    ('Parity on the counter', dict(prac_prot=1)),
    ('Own SEC-DED on the counter', dict(prac_prot=2)),
    ('Inside OD-ECC codeword, bank-group decoder', dict(prac_prot=3)),
    ('Inside OD-ECC codeword, per-bank decoders', dict(prac_prot=3, odecc_model=1, odecc_where=1)),
    ('Inside HBM4-style codeword (16-bit symbols)', dict(prac_prot=3, odecc_model=1, odecc_sym=16, odecc_cw=1)),
    ('16-bit counter', dict(prac_bits=16)),
]
ECC_CASES = [
    ('DreamRAM prior (24 FO4)', dict(odecc_model=0)),
    ('HBM3: 2 x RS(19,17), 8-bit symbols', dict(odecc_model=1, odecc_sym=8, odecc_t=1, odecc_cw=2)),
    ('HBM4 example: RS(19,17), 16-bit symbols', dict(odecc_model=1, odecc_sym=16, odecc_t=1, odecc_cw=1)),
    ('8-bit symbols, t = 2', dict(odecc_model=1, odecc_sym=8, odecc_t=2, odecc_cw=2)),
    ('16-bit symbols, t = 2', dict(odecc_model=1, odecc_sym=16, odecc_t=2, odecc_cw=1)),
    ('16-bit symbols, t = 2, 3 pipeline stages', dict(odecc_model=1, odecc_sym=16, odecc_t=2, odecc_cw=1, odecc_pipe=3)),
    ('16-bit symbols, per-bank decoders', dict(odecc_model=1, odecc_sym=16, odecc_t=1, odecc_cw=1, odecc_where=1)),
]


def evaluate(a, name, over):
    ex = json.load(open(os.path.join(ROOT, 'examples', name + '.json')))
    tech = 'configs/tech/scaled/16nm_scaled.json' if abs(ex['tech']['pitch_wl'] - 0.041) < 1e-6 else \
        os.path.join(ROOT, 'configs', 'tech', 'hbm4_34wl_36bl.json')
    p = dict(ex['params'], **over)
    with contextlib.redirect_stdout(io.StringIO()):
        dram, t, _, m, status = E.build(a.dreamram, MEM, tech, p, ex['tech']['max_die_um'] / 1000 + 1)
    if status != 0:
        return None
    dims = dram.calc_stack_dims(t)
    r = dict(m, die=dims[1] * sum(dims[2:]) / 1e6, ioctl=dram.od_ecc_height(t))
    if p.get('prac'):
        r['acu'] = dram.acu_time(t)
        r['parts'] = dram.prac_parts(t) if p.get('prac_model') else {}
    if p.get('odecc_model') or p.get('tccd_staged'):
        e = dram.ecc() or E.ECC_REF
        r['ecc_ns'] = dram.ecc_fo4() * dram._staged_ref[1] * (t.f / 0.016) ** t.logic_scale_conf
        hits = -(-2 * p['ldls_mdls'] // (p.get('odecc_sym', 8) * e['ncw'])) if p.get('odecc_model') else None
        r['fault'] = '-' if hits is None else ('yes' if hits <= p.get('odecc_t', 1) else 'no')
        r['gates'] = e['gates']
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dreamram', required=True)
    ap.add_argument('--designs', default='hbm3_baseline,hbm4_1sid_coupled,hbm5_2bg_min_area,g32_64b_fp5_lowpower')
    ap.add_argument('--md', help='also write the tables as Markdown to this file')
    a = ap.parse_args()
    a.dreamram = os.path.abspath(a.dreamram)
    f = lambda v, n=1: f'{v:.{n}f}'  # noqa: E731
    out = []
    for name in a.designs.split(','):
        off = evaluate(a, name, dict(prac=0))
        out.append(f'\n### {name}: PRAC design decisions\n')
        out.append('| Case | ACU (ns) | of which: restore / queue / path | tRAS | tRP | tRC | Row-miss latency | Die |')
        out.append('| --- | --- | --- | --- | --- | --- | --- | --- |')
        for label, over in PRAC_CASES:
            r = evaluate(a, name, dict(BASE, **over))
            if not r:
                out.append(f'| {label} | discarded | | | | | | |')
                continue
            pp = r.get('parts') or {}
            split = f"{f(pp['restore'])} / {f(pp['queue'])} / {f(r['acu'] - pp['restore'] - pp['queue'])}" if pp else ''
            out.append(f"| {label} | {f(r['acu']) if 'acu' in r else '-'} | {split} | {f(r['tras'])} | {f(r['trp'])} | {f(r['trc'])} | "
                       f"{f(r['worst_latency_ns'])} ({'+' if r['worst_latency_ns'] >= off['worst_latency_ns'] else ''}"
                       f"{f(100 * (r['worst_latency_ns'] / off['worst_latency_ns'] - 1), 0)}%) | "
                       f"{f(r['die'], 2)} mm² ({'+' if r['die'] >= off['die'] else ''}{f(100 * (r['die'] / off['die'] - 1), 2)}%) |")
        out.append(f'\n### {name}: OD-ECC engine (staged tCCD_L, per-bank IOSA)\n')
        out.append('| Engine | Gates per engine | ECC stage | tCCD_L | Pin rate | I/O control | Die | Corrects a driver fault |')
        out.append('| --- | --- | --- | --- | --- | --- | --- | --- |')
        ref = None
        for label, over in ECC_CASES:
            r = evaluate(a, name, dict(prac=0, tccd_staged=1, mdl_share=0, **over))
            if not r:
                out.append(f'| {label} | discarded | | | | | | |')
                continue
            ref = ref or r
            out.append(f"| {label} | {f(r['gates'] / 1000)}k | {f(r['ecc_ns'], 2)} ns | {f(r['tccdl'], 2)} ns | "
                       f"{f(r['dq_datarate_gbps'])} Gb/s | {f(r['ioctl'])} µm | {f(r['die'], 2)} mm² "
                       f"({'+' if r['die'] >= ref['die'] else ''}{f(100 * (r['die'] / ref['die'] - 1), 1)}%) | {r['fault']} |")
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w').write(text + '\n')


if __name__ == '__main__':
    main()
