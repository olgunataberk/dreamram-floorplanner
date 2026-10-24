#!/usr/bin/env python3
"""
HBM5 candidates at HBM4's capacity: twice the channels per die (16 instead of 8, so 4,096 data DQs per stack),
otherwise HBM4's organisation. Each pseudo-channel keeps 32 DQs, 32 B accesses (BL8), 2 bank groups x 8 banks and
1 KiB rows; the stack keeps 16 GB in four 32 Gb dies, so each bank holds half the rows. On-die ECC is HBM4-like:
one RS(19,17) over 16-bit symbols per 32 B (JESD270-4's example), decoded per bank group.

Every die organisation from tools/sweep_interface.py is evaluated with the staged tCCD_L model under three I/O
sense-amp placements, at each pin rate (tCCD_L <= 2 bank groups x the burst). For the smallest, the most
package-friendly and the lowest-latency passing designs, PRAC configurations are then compared on row-miss latency,
tRP / tRC and die area. HBM4 itself (8 channels per die) is run the same way as the reference.

Usage:
  python3 tools/hbm5_study.py --dreamram /path/to/DreamRAM [--rates 8,16] [--md out.md]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sweep_interface as SI  # noqa: E402

ECC = dict(odecc_model=1, odecc_sym=16, odecc_t=1, odecc_cw=1, odecc_where=0)
PLACEMENTS = {
    'ioctl': ('IOSA at the I/O control', dict(mdl_share=1)),
    'bank': ('IOSA per bank', dict(mdl_share=0)),
    'mid': ('IOSA per bank, mid-bank decoder', dict(mdl_share=0, col_mid=1)),
}
PRAC = [
    ('No PRAC', dict(prac=0)),
    ('DDR5 ratio', dict(prac=1, prac_model=0)),
    ('After PRE, per-bank path', dict(prac=1, prac_model=1)),
    ('While row open (PRHT)', dict(prac=1, prac_model=1, prac_when=1)),
    ('Counter subarray (Chronus)', dict(prac=1, prac_model=1, prac_when=2)),
    ('After PRE, shared I/O-control path', dict(prac=1, prac_model=1, prac_path=1)),
    ('In OD-ECC codeword, bank-group decoder', dict(prac=1, prac_model=1, prac_prot=3)),
    ('In OD-ECC codeword, per-bank decoders', dict(prac=1, prac_model=1, prac_prot=3, odecc_where=1)),
]
GENS = {'HBM4 (8 channels / die)': (32, 8), 'HBM5 (16 channels / die)': (64, 16)}


def org(r):
    return (f"{r['vert_bg']}x{r['horiz_bg']} BG x {r['banks']}, {r['subarrays']} SA x {r['mat_rows']} WL, {r['mats']} x "
            f"{r['mat_cols']}-BL MATs, {r['ldls_mdls']} MDL{', BRVSA' if r['brvsa'] else ''}"
            f"{', coupled x%d' % r['coupled_rows'] if r['coupled_rows'] > 1 else ''}, {r['channel_rows']} ch row{'s' if r['channel_rows'] > 1 else ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dreamram', required=True)
    ap.add_argument('--rates', default='8,16')
    ap.add_argument('--tsv-rate', type=float, default=8)
    ap.add_argument('--max-die-mm', type=float, default=20)
    ap.add_argument('--ecc-sym', type=int, default=16, help='OD-ECC symbol bits (16: HBM4 example, 8: HBM3)')
    ap.add_argument('--ecc-pipe', type=int, default=1, help='OD-ECC pipeline stages')
    ap.add_argument('--md')
    a = ap.parse_args()
    a.dreamram = os.path.abspath(a.dreamram)
    ECC.update(odecc_sym=a.ecc_sym, odecc_cw=1 if a.ecc_sym == 16 else 2, odecc_pipe=a.ecc_pipe)
    for k, (label, ext) in PLACEMENTS.items():
        SI.MODELS['h_' + k] = (label, dict(ext, tccd_staged=1, **ECC))
    f = lambda v, n=1: f'{v:.{n}f}'  # noqa: E731
    out = []
    for rate in [float(x) for x in a.rates.split(',')]:
        out.append(f"\n## {f(rate, 0)} Gb/s, OD-ECC over {a.ecc_sym}-bit symbols{f', {a.ecc_pipe} pipeline stages' if a.ecc_pipe > 1 else ''}\n")
        for gen, (channels, per_die) in GENS.items():
            SI.CHANNELS = channels
            SI.FIXED.update(channels=channels, ch_per_die=per_die)
            cands = list(SI.internal_designs(2, 2, [16], 256))
            out.append(f'### {gen}: {len(cands)} organisations\n')
            out.append('| IOSA placement | Pass | Pick | Organisation | tCCD_L (≤) | Die | Aspect | Row-miss latency | Driver fault |')
            out.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
            picks = {}  # distinct designs: (placement key, organisation) -> (labels, result)
            for key, (label, _) in PLACEMENTS.items():
                res = [r for r in (SI.evaluate(a, 'hbm4', d, 'h_' + key, rate) for d in cands) if r]
                ok = [r for r in res if r['rmax'] >= rate - 1e-9]
                if not ok:
                    best = max(res, key=lambda r: r['rmax']) if res else None
                    out.append(f"| {label} | 0 | | none: fastest {f(best['rmax'])} Gb/s ({best['limiter']}) | | | | | |" if best else f'| {label} | 0 | | | | | | | |')
                    continue
                choice = [('smallest die', min(ok, key=lambda r: r['die']))]
                sq = [r for r in ok if r['aspect'] <= 1.3]
                if sq:
                    choice.append(('package-friendly', min(sq, key=lambda r: r['die'])))
                choice.append(('lowest latency', min(ok, key=lambda r: (r['latency'], r['die']))))
                for tag, r in choice:
                    k = (key, org(r))
                    if k in picks:
                        picks[k][0].append(tag)
                        continue
                    picks[k] = ([tag], r)
                for (pk, o), (tags, r) in picks.items():
                    if pk != key:
                        continue
                    out.append(f"| {label} | {len(ok)} | {', '.join(tags)} | {o} | {f(r['tccdl'], 2)} ({f(r['tccdl_need'], 2)}) | "
                               f"{f(r['die_w'], 2)} × {f(r['die_h'], 2)} = {f(r['die'])} mm² | {f(r['aspect'], 2)} | "
                               f"{f(r['latency'])} ns | {'corrected' if r['fault_hits'] <= r['fault_t'] else 'not corrected'} |")
            if not picks:
                continue
            # PRAC on every distinct pick: row-miss latency matrix
            cols, rows = [], {pl: [] for pl, _ in PRAC}
            detail = None
            for (key, o), (tags, r) in picks.items():
                d = {k: r[k] for k in ('vert_bg', 'horiz_bg', 'banks', 'mats', 'mat_cols', 'mat_rows', 'ldls_mdls', 'mdlcsl',
                                       'csl_mdl_shared_layer', 'brvsa', 'coupled_rows', 'subarrays', 'pages_per_bgbus_mux',
                                       'atom_size', 'channel_rows')}
                cols.append(f"{PLACEMENTS[key][0]}, {' / '.join(tags)}")
                res = [(pl, SI.evaluate(a, 'hbm4', d, 'h_' + key, rate, extra)) for pl, extra in PRAC]
                base = res[0][1]
                for pl, q in res:
                    rows[pl].append(f"{f(q['latency'])} ({'+' if q['latency'] >= base['latency'] else ''}{f(100 * (q['latency'] / base['latency'] - 1), 0)}%)" if q else '—')
                # detail: the package-friendly design, preferring HBM4-like I/O-control IOSAs; else the first design
                rank = ('package-friendly' in tags) * 2 + (key == 'ioctl')
                if detail is None or rank > detail[4]:
                    detail = (key, o, tags, res, rank)
            out.append(f'\n**{gen}: row-miss latency (ns) with PRAC**, one column per design above\n')
            out.append('| PRAC | ' + ' | '.join(cols) + ' |')
            out.append('| --- |' + ' --- |' * len(cols))
            for pl, _ in PRAC:
                out.append(f'| {pl} | ' + ' | '.join(rows[pl]) + ' |')
            key, o, tags, res, _ = detail
            out.append(f"\n**{gen}, {PLACEMENTS[key][0]}, {' / '.join(tags)}** ({o}): PRAC in detail\n")
            out.append('| PRAC | Counter update | tRAS / tRP / tRC | Row-miss latency | Die |')
            out.append('| --- | --- | --- | --- | --- |')
            base = res[0][1]
            for pl, q in res:
                if not q:
                    out.append(f'| {pl} | discarded | | | |')
                    continue
                out.append(f"| {pl} | {f(q['acu']) + ' ns' if q['acu'] else '—'} | {f(q['tras'])} / {f(q['trp'])} / {f(q['trc'])} ns | "
                           f"{f(q['latency'])} ns ({'+' if q['latency'] >= base['latency'] else ''}{f(100 * (q['latency'] / base['latency'] - 1), 0)}%) | "
                           f"{f(q['die'])} mm² ({'+' if q['die'] >= base['die'] else ''}{f(100 * (q['die'] / base['die'] - 1), 1)}%) |")
            out.append('')
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w').write(text + '\n')


if __name__ == '__main__':
    main()
