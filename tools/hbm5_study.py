#!/usr/bin/env python3
"""
HBM5 candidates at HBM4's capacity: twice the channels per die (16 instead of 8, so 4,096 data DQs per stack),
otherwise HBM4's organisation. Each pseudo-channel keeps 32 DQs, 32 B accesses (BL8), 2 bank groups x 8 banks and
1 KiB rows; the stack keeps 16 GB in four 32 Gb dies, so each bank holds half the rows. On-die ECC is HBM4-like:
one RS(19,17) over 16-bit symbols per 32 B (JESD270-4's example), decoded per bank group.

Every die organisation from tools/sweep_interface.py is evaluated with the staged tCCD_L model under three I/O
sense-amp placements, at each pin rate (tCCD_L <= 2 bank groups x the burst). For the smallest, the most
package-friendly and the lowest-latency passing designs, PRAC configurations are then compared on row-miss latency,
tRP / tRC, the row-miss penalty (tRP + tRCD, what a miss costs over a hit), the row-miss latency to first data
(tCL + tRCD + tRP) and die area; percentages are on the penalty, where PRAC acts. HBM4 itself (8 channels per die)
is run the same way as the reference.

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


def study(a, rate, ecc_sym=16, ecc_pipe=1):
    """Structured results at one pin rate: for each generation and IOSA placement, how many organisations pass, the
    distinct picks (smallest, package-friendly, lowest latency) and every PRAC configuration on each pick."""
    ECC.update(odecc_sym=ecc_sym, odecc_cw=1 if ecc_sym == 16 else 2, odecc_pipe=ecc_pipe)
    for k, (label, ext) in PLACEMENTS.items():
        SI.MODELS['h_' + k] = (label, dict(ext, tccd_staged=1, **ECC))
    keep = ('acu', 'tras', 'trp', 'trc', 'trcd', 'latency', 'die')
    gens = []
    for gen, (channels, per_die) in GENS.items():
        SI.CHANNELS = channels
        SI.FIXED.update(channels=channels, ch_per_die=per_die)
        cands = list(SI.internal_designs(2, 2, [16], 256))
        places = []
        for key, (label, _) in PLACEMENTS.items():
            res = [r for r in (SI.evaluate(a, 'hbm4', d, 'h_' + key, rate) for d in cands) if r]
            ok = [r for r in res if r['rmax'] >= rate - 1e-9]
            best = max(res, key=lambda r: r['rmax']) if res else None
            place = dict(key=key, label=label, passed=len(ok), fastest=best and float(best['rmax']), limiter=best and best['limiter'], picks=[])
            if ok:
                choice = [('smallest die', min(ok, key=lambda r: r['die']))]
                sq = [r for r in ok if r['aspect'] <= 1.3]
                if sq:
                    choice.append(('package-friendly', min(sq, key=lambda r: r['die'])))
                choice.append(('lowest latency', min(ok, key=lambda r: (r['latency'], r['die']))))
                seen = {}
                for tag, r in choice:
                    if org(r) in seen:
                        seen[org(r)]['tags'].append(tag)
                        continue
                    d = {k: r[k] for k in ('vert_bg', 'horiz_bg', 'banks', 'mats', 'mat_cols', 'mat_rows', 'ldls_mdls', 'mdlcsl',
                                           'csl_mdl_shared_layer', 'brvsa', 'coupled_rows', 'subarrays', 'pages_per_bgbus_mux',
                                           'atom_size', 'channel_rows')}
                    prac = []
                    for pl, extra in PRAC:
                        q = SI.evaluate(a, 'hbm4', d, 'h_' + key, rate, extra)
                        prac.append(dict(label=pl, **({k: float(q[k]) for k in keep} if q else {'discarded': True})))
                    seen[org(r)] = dict(tags=[tag], org=org(r), tccdl=float(r['tccdl']), need=float(r['tccdl_need']),
                                        die_w=float(r['die_w']), die_h=float(r['die_h']), die=float(r['die']), aspect=float(r['aspect']),
                                        trcd=float(r['trcd']), trp=float(r['trp']), latency=float(r['latency']),
                                        fault=bool(r['fault_hits'] <= r['fault_t']), prac=prac)
                place['picks'] = list(seen.values())
            places.append(place)
        gens.append(dict(gen=gen, channels_per_die=per_die, organisations=len(cands), placements=places))
    return dict(rate=rate, ecc_sym=ecc_sym, ecc_pipe=ecc_pipe, gens=gens)


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
    f = lambda v, n=1: f'{v:.{n}f}'  # noqa: E731
    pct = lambda v, b: f"{'+' if v >= b else ''}{f(100 * (v / b - 1), 0)}%"  # noqa: E731
    pen = lambda q: q['trp'] + q['trcd']  # noqa: E731
    out = []
    for rate in [float(x) for x in a.rates.split(',')]:
        st = study(a, rate, a.ecc_sym, a.ecc_pipe)
        out.append(f"\n## {f(rate, 0)} Gb/s, OD-ECC over {a.ecc_sym}-bit symbols{f', {a.ecc_pipe} pipeline stages' if a.ecc_pipe > 1 else ''}\n")
        for g in st['gens']:
            out.append(f"### {g['gen']}: {g['organisations']} organisations\n")
            out.append('| IOSA placement | Pass | Pick | Organisation | tCCD_L (≤) | Die | Aspect | Row-miss penalty / latency | Driver fault |')
            out.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
            picks = []
            for pl in g['placements']:
                if not pl['picks']:
                    out.append(f"| {pl['label']} | 0 | | none: fastest {f(pl['fastest'])} Gb/s ({pl['limiter']}) | | | | | |")
                for r in pl['picks']:
                    picks.append((pl, r))
                    out.append(f"| {pl['label']} | {pl['passed']} | {', '.join(r['tags'])} | {r['org']} | {f(r['tccdl'], 2)} ({f(r['need'], 2)}) | "
                               f"{f(r['die_w'], 2)} × {f(r['die_h'], 2)} = {f(r['die'])} mm² | {f(r['aspect'], 2)} | "
                               f"{f(pen(r))} / {f(r['latency'])} ns | {'corrected' if r['fault'] else 'not corrected'} |")
            if not picks:
                continue
            out.append(f"\n**{g['gen']}: row-miss penalty tRP + tRCD (ns) with PRAC**, one column per design above\n")
            out.append('| PRAC | ' + ' | '.join(f"{pl['label']}, {' / '.join(r['tags'])}" for pl, r in picks) + ' |')
            out.append('| --- |' + ' --- |' * len(picks))
            for i, (plabel, _) in enumerate(PRAC):
                cells = []
                for _, r in picks:
                    q, b = r['prac'][i], r['prac'][0]
                    cells.append('—' if q.get('discarded') else f"{f(pen(q))} ({pct(pen(q), pen(b))})")
                out.append(f'| {plabel} | ' + ' | '.join(cells) + ' |')
            # detail: the package-friendly pick, preferring HBM4-like I/O-control IOSAs
            pl, r = max(picks, key=lambda x: ('package-friendly' in x[1]['tags']) * 2 + (x[0]['key'] == 'ioctl'))
            out.append(f"\n**{g['gen']}, {pl['label']}, {' / '.join(r['tags'])}** ({r['org']}): PRAC in detail\n")
            out.append('| PRAC | Counter update | tRAS / tRP / tRC | Row-miss penalty | Row-miss latency | Die |')
            out.append('| --- | --- | --- | --- | --- | --- |')
            b = r['prac'][0]
            for q in r['prac']:
                if q.get('discarded'):
                    out.append(f"| {q['label']} | discarded | | | | |")
                    continue
                out.append(f"| {q['label']} | {f(q['acu']) + ' ns' if q['acu'] else '—'} | {f(q['tras'])} / {f(q['trp'])} / {f(q['trc'])} ns | "
                           f"{f(pen(q))} ns ({pct(pen(q), pen(b))}) | {f(q['latency'])} ns ({pct(q['latency'], b['latency'])}) | "
                           f"{f(q['die'])} mm² ({pct(q['die'], b['die'])}) |")
            out.append('')
    text = '\n'.join(out)
    print(text)
    if a.md:
        open(a.md, 'w').write(text + '\n')


if __name__ == '__main__':
    main()
