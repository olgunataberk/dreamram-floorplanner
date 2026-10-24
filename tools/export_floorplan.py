#!/usr/bin/env python3
"""
Export the floorplan geometry of one DreamRAM configuration as JSON for the visualizer.

All numbers come straight from DreamRAM's own Hbm/Tech classes (hbm.py, tech.py), so the
visualizer draws exactly what the simulator models. The design is built the same way
dreamram.py builds a sweep point: baseline memory + scaled tech + timing overrides, then the
requested parameter overrides on top.

Usage:
  python3 tools/export_floorplan.py --dreamram /path/to/DreamRAM [-o floorplan.json]
        [-m configs/mem/sweep/hbm_sweep_default.json] [-t configs/tech/scaled/16nm_scaled.json]
        [--set channels=32 --set subchannels=4 ...]
        [--csv data/<label>/hbm3_<label>.csv --row <row index>]

--set keys use the sweep-CSV column names (sids, channels, ch_per_die, pch, horiz_bg, vert_bg,
banks, subarrays, mat_rows, mats, mat_cols, brvsa, ldls_mdls, mdl_over_mat, csl_mdl_over_mat,
csl_mdl_shared_layer, ha_layout, ha_double_ldls, subchannels, salp_groups, salp_all,
pages_per_bgbus_mux, mdl_bgbus_sd, bgbuses_per_gbus, bgbus_gbus_sd, gbus_tsv_sd, tsv_dq_sd,
atom_size). Load the resulting JSON with the visualizer's "Load DreamRAM export" button.

Two extensions that are not part of DreamRAM can also be --set (both default to off):
  coupled_rows=C   C host-visible rows share one physical wordline ("coupled rows": one ACT/PRE
                   drives all C). The logical page, column datapath and atom split C ways while the
                   activation still spans the full physical row; the host sees log2(C) more row bits.
  edge_pairing=1   open-bitline edge subarrays store data in their non-dummy half of the bitlines and
                   the top/bottom edge pair forms one row, replacing DreamRAM's two dummy half-subarrays.
  ioctl_h=UM       height (um) of each bank group's I/O control block (DreamRAM's per-group OD-ECC
                   height, 1% of the baseline bank, when 0).
  tccd_bgbus=1     make the core column cycle (and so tCCD_L/S, pin rate and bandwidth) the slower of the
                   bank column path (DreamRAM's core_tck) and the bank group's shared BG-BUS window, both
                   calibrated to the baseline's tCK. The BG-BUS stage scales with DreamRAM's own bus length
                   (wire_lengths 'bgbus+gbus') and pitch-dependent capacitance, like its tCL.
  channel_rows=2   place the die's channels in two rows, half above and half below the TSV region,
                   each channel holding all of its bank groups on its side (Samsung ISSCC 2026 HBM4
                   core die). DreamRAM's own template (1) splits every channel across both sides.
  tck_fixed=NS     the length-independent share of the core column cycle (driver, sensing, precharge), as
                   at the 16 nm HBM3 node. DreamRAM fixes it at 1 ns; the wire share stays calibrated so the
                   baseline is still its tCK. Applies to both column stages.
  tck_fixed_scale=1  scale that fixed share with the logic node, (f / 16 nm)^logic_scale_conf, like
                   DreamRAM's peripheral tiles.
  tck_wire=2       treat the in-bank CSL/MDL/LDL lines as unrepeated RC wires, so their delay grows with
                   length squared (DreamRAM: linear in length times capacitance).
  bw_bg_cap=1      cap bandwidth at bank groups x one atom per tCCD_L per pseudo-channel (DreamRAM's peak
                   assumes bgbuses_per_gbus groups exist).
  tsv_chain=1      count data TSVs from the serdes chain: every pseudo-channel's GBUS bits / gbus_tsv_sd,
                   MD-ECC and DBI in proportion (DreamRAM counts one pseudo-channel's MDL bits per channel).
                   gbus_tsv_sd may then be below 1 (more TSVs than GBUS wires, each slower).
  tccd_staged=1    staged column-cycle model: tCCD_L = max(pumps x serial bank cycle, shared bank-group stage).
                   Bank cycle = CSL rise + LDL develop + MDL develop + IOSA resolve + equalize; shared stage =
                   OD-ECC/DBI, BG-BUS window and, per mdl_share, a shared IOSA or MDL line. Each stage is a device
                   delay (FO4 units, growing with the line capacitance it drives) plus distributed wire RC from
                   DreamRAM's geometry. One device constant is calibrated so the HBM3 baseline (16 nm, IOSAs
                   shared at the I/O control) is 2 ns; device delay scales with (f / 16 nm)^logic_scale_conf.
                   Overrides tccd_bgbus and the tck_* options.
  mdl_share=N      0: IOSAs per bank at the bank edge (MDL = bank height). 1 (default): IOSAs shared by the bank
                   group at its I/O control, MDLs run from the farthest bank. 2: one MDL line per side shared by
                   its banks, so the MDL phase is a shared stage.
  col_mid=1        column decoder (and per-bank IOSAs) in the middle of the bank instead of at its edge, so CSLs
                   and per-bank MDLs span half the bank height (staged model only; the drawn floorplan is unchanged).
  od_ecc_logic=0   leave the OD-ECC/DBI logic out of the shared stage (pre-HBM3 devices).
"""
import argparse
import contextlib
import csv
import functools
import io
import json
import os
import sys

PARAMS = ['sids', 'channels', 'ch_per_die', 'pch', 'horiz_bg', 'vert_bg', 'banks', 'subarrays',
          'mat_rows', 'mats', 'mat_cols', 'brvsa', 'ldls_mdls', 'mdl_over_mat', 'csl_mdl_over_mat',
          'csl_mdl_shared_layer', 'ha_layout', 'ha_double_ldls', 'subchannels', 'salp_groups',
          'salp_all', 'pages_per_bgbus_mux', 'mdl_bgbus_sd', 'bgbuses_per_gbus', 'bgbus_gbus_sd',
          'gbus_tsv_sd', 'tsv_dq_sd', 'atom_size']
EXTENSIONS = {'coupled_rows': 1, 'coupled_lsb': 0, 'edge_pairing': 0, 'ioctl_h': 0, 'channel_rows': 1, 'tccd_bgbus': 0,
              'tck_fixed': 1, 'tck_fixed_scale': 0, 'tck_wire': 1, 'bw_bg_cap': 0, 'tsv_chain': 0,
              'tccd_staged': 0, 'mdl_share': 1, 'col_mid': 0, 'od_ecc_logic': 1,
              'prac': 0, 'prac_bits': 12, 'prac_model': 0, 'prac_when': 0, 'prac_path': 0, 'prac_prot': 0,
              'odecc_model': 0, 'odecc_sym': 8, 'odecc_t': 1, 'odecc_cw': 2, 'odecc_where': 0, 'odecc_pipe': 1}  # coupled_lsb only labels rows


METRICS = ['capacity_gbytes', 'bw_gbytes', 'worst_latency_ns', 'metric_e_per_bit_closed',
           'metric_e_per_bit_seq', 'worst_power_w', 'total_area_mmmm', 'die_x_mm', 'die_y_mm', 'cell_eff',
           'core_freq_ghz', 'dq_datarate_gbps', 'tcl', 'trcd', 'trp', 'tccdl', 'page_size_bytes',
           'tras', 'trc', 'trtp', 'twr']


@functools.lru_cache(maxsize=None)
def _context(dreamram_dir, mem_json, tech_json, max_die_mm):
    """DreamRAM modules, scaled tech, baseline memory config and baseline references for one setup.
    Cached so sweeps (tools/sweep_pin_rate.py) only build each design's own model."""
    sys.path.insert(0, dreamram_dir)
    os.chdir(dreamram_dir)  # DreamRAM configs reference each other by repo-relative paths
    from tech import Tech
    from hbm import Hbm
    import parse
    import dreamram

    t = parse.tech(tech_json)
    data = json.load(open(mem_json))
    if 'baseline' in data['memconfig']:
        b, _ = parse.mem_baseline_and_sweep(mem_json)
    else:
        b = parse.mem_baseline(mem_json)
    tb = b.pop('_timing_baseline', None)
    if tb:
        t = parse.timing_baseline(tb, t)

    tech_fields = set(Tech.__dataclass_fields__)
    if max_die_mm:
        t['max_die_dims_mm'] = max_die_mm  # relaxes only dreamram.simulate()'s die-size filter (status 11)
    tech = Tech(**{k: v for k, v in t.items() if k in tech_fields})
    return Hbm, dreamram, tech, b


def build(dreamram_dir, mem_json, tech_json, overrides, max_die_mm=None):
    Hbm, dreamram, tech, b = _context(dreamram_dir, mem_json, tech_json, max_die_mm)
    os.chdir(dreamram_dir)

    Model = extended_hbm(Hbm, overrides.get('coupled_rows', 1), overrides.get('edge_pairing', 0), overrides.get('ioctl_h', 0),
                         overrides.get('channel_rows', 1), overrides.get('tccd_bgbus', 0),
                         **{k: overrides.get(k, EXTENSIONS[k]) for k in ('tck_fixed', 'tck_fixed_scale', 'tck_wire', 'bw_bg_cap', 'tsv_chain',
                                                                         'tccd_staged', 'mdl_share', 'col_mid', 'od_ecc_logic',
                                                                         'prac', 'prac_bits', 'prac_model', 'prac_when', 'prac_path',
                                                                         'prac_prot', 'odecc_model', 'odecc_sym', 'odecc_t', 'odecc_cw',
                                                                         'odecc_where', 'odecc_pipe')})

    def make(p, ref, cls=Hbm):
        kw = dict(sids=p['sids'], channels=p['channels'], ch_per_die=p['ch_per_die'], pch=p['pch'],
                  horiz_bg=p['horiz_bg'], vert_bg=p['vert_bg'], banks=p['banks'], subarrays=p['subarrays'],
                  mat_rows=p['mat_rows'], mats=p['mats'], mat_cols=p['mat_cols'], brv_sa=p['brvsa'],
                  ldls_mdls=p['ldls_mdls'], mdl_over_mat=p['mdl_over_mat'], mdl_csl_over_mat=p['csl_mdl_over_mat'],
                  csl_mdl_shared_layer=p['csl_mdl_shared_layer'], ha_layout=p['ha_layout'],
                  ha_double_ldls=p['ha_double_ldls'], salp_groups=p['salp_groups'], salp_all=p['salp_all'],
                  pages_per_bgbus_mux=p['pages_per_bgbus_mux'], mdl_bgbus_sd=p['mdl_bgbus_sd'],
                  bgbuses_per_gbus=p['bgbuses_per_gbus'], bgbus_gbus_sd=p['bgbus_gbus_sd'],
                  gbus_tsv_sd=p['gbus_tsv_sd'], tsv_dq_sd=p['tsv_dq_sd'], subchannels=p['subchannels'],
                  atom_size=p['atom_size'], isolation_rows_overhead=b['isolation_rows_overhead'],
                  isolation_cols_overhead=b['isolation_cols_overhead'])
        kw.update(ref)
        return cls(**kw)

    base = {k: b[k] for k in PARAMS if k in b}
    base['csl_mdl_over_mat'] = b['mdl_over_mat'] >> 1
    base['mdl_over_mat'] = b['mdl_over_mat'] & 1
    # baseline references, set up exactly as dreamram.main() does before the sweep
    # (e.g. od-ecc and mbus heights scale with the *baseline* bank height)
    ref = {k: b[k] for k in ['_mat_rows', '_mat_cols', '_subarrays', '_ldls_mdls', '_mats', '_subchannels',
                             '_tck', '_tcl', '_channels', '_ch_per_die', '_sids', '_vert_bg',
                             '_pages_per_bgbus_mux', '_mdl_bgbus_sd', '_bgbus_gbus_sd', '_gbus_tsv_sd']}
    key = (dreamram_dir, mem_json, tech_json, max_die_mm)
    if key not in _BASELINE_REFS:
        baseline = make(base, dict(ref, _n_bgbus=-1, _die_y=-1))
        _, bw, nt, ct, dt, ot = baseline.calc_stack_dims(tech)
        _BASELINE_REFS[key] = (dict(_n_bgbus=baseline.n_bgbus(), _die_y=nt + ct + dt + ot, _tcl=baseline._tcl,
                                    _bank_x=baseline._bank_x_calc(tech), _bank_y=baseline._bank_y_calc(tech)),
                               baseline.wire_lengths(tech)['bgbus+gbus'])
    ref_extra, bgbus_len_ref = _BASELINE_REFS[key]
    ref.update(ref_extra)

    p = dict(base)
    p.update({k: v for k, v in overrides.items() if k not in EXTENSIONS})
    dram = make(p, ref, Model)
    dram._bgbus_len_ref = bgbus_len_ref  # baseline BG-BUS length for tccd_bgbus
    if overrides.get('odecc_model'):  # structural OD-ECC sets its own check-bit share of the cells
        dram.od_ecc_prop = ecc_circuit(overrides.get('odecc_sym', 8), overrides.get('odecc_t', 1), overrides.get('odecc_cw', 2),
                                       dram.md_ecc_prop)['check_prop']
    if overrides.get('tccd_staged') or overrides.get('odecc_model') or (overrides.get('prac') and overrides.get('prac_model')):
        dram._staged_ref = staged_reference(dreamram_dir, mem_json)

    # run DreamRAM's own simulate() for the metrics and its discard filters
    d = dict(b, **p)
    d['mdl_over_mat'] = (p['csl_mdl_over_mat'] << 1) | p['mdl_over_mat']
    # simulate()'s atom filters read the page split from d, not from the model; coupled rows split the
    # column datapath exactly like extra independent column pages, so present them that way to the filters
    d['subchannels'] = p['subchannels'] * overrides.get('coupled_rows', 1)
    try:
        metrics, status = dreamram.simulate(dram, tech, d)
    except (AssertionError, ZeroDivisionError, ValueError) as e:
        metrics, status = {}, f'exception: {e!r}'
    for k, v in EXTENSIONS.items():
        p[k] = overrides.get(k, v)
    return dram, tech, p, (metrics if status == 0 else {}), status


_BASELINE_REFS = {}


# ---- staged column-cycle model (tccd_staged) ---------------------------------------------------------------
# Device delays in FO4-equivalents at the reference load: (fixed, load-dependent). The load-dependent part scales
# with the line's total capacitance relative to the calibration design. The shared stages are paid per pump (OD-ECC,
# IOSA) or per BG-BUS transfer (pumps x mdl_bgbus_sd), since each pump's MDL word crosses them separately.
# js/model.js mirrors this table.
STAGED = {
    'csl': (4, 4),     # column decoder + CSL driver charging the CSL
    'ldl': (1, 4),     # column switch on, BLSA develops the LDL pair
    'mdl': (2, 6),     # helper flip-flop at the LDL/MDL junction drives the MDL pair
    'iosa': (4, 0),    # I/O (global) sense amp resolves
    'eq': (1, 4),      # MDL / LDL equalise back to mid-rail before the next CSL
    'iosa_shared': 6,  # shared IOSA occupancy per pump (resolve + precharge), mdl_share >= 1
    'ecc': 24,         # OD-ECC syndrome / decode / correct + DBI per pump's MDL word (Ryu et al.: inside tCCD_L)
    'bus_launch': 4,   # BG-BUS launch + capture (setup / hold) per transfer
    'bus_skew': 0.15,  # BG-BUS window grows with this fraction of the repeated-wire flight time
    'bus_fo4_mm': 2.5,  # repeated-wire flight time per mm
    'rho': 3.0e-8,     # ohm m, effective resistivity of narrow M2/M3 lines
    'ref_tck': 2.0,    # ns, HBM3 tCCD_L (Ryu et al., JSSC 2023): calibration target
    'ref_share': 1,    # HBM3 shares IOSAs at the bank group's I/O control
}
STAGE_NAMES = {'csl': 'CSL rise', 'ldl': 'LDL develop', 'mdl': 'MDL develop', 'iosa': 'IOSA resolve', 'eq': 'Equalize'}


def staged_geometry(dram, tech, share, col_mid):
    """Line lengths (um), resistance (ohm/um) and capacitance (pF/um) of the column-path wires."""
    import math
    _, bank_y, _ = dram.bank_dims(tech)
    slot = bank_y + dram.dummy_subarray_height(tech)
    csl_r, mdl_r = dram.csl_mdl_pitch_ratios(tech)
    per_um = lambda c0, ratio: tech.scale_cap(c0) * tech.rc_ratio_fixed_width(ratio, tech._c_within_layer_sparse_csl_mdl)
    w3 = 2 * tech.pitch_bl  # M3 CSL / MDL: half the minimum 4 x BL pitch, aspect ratio 2 (fixed width, as DreamRAM)
    w2 = tech.pitch_ldl / 2  # M2 LDL
    r = lambda w: STAGED['rho'] * 1e6 / (w * 2 * w)
    half = 2 if col_mid else 1
    return dict(f=tech.f, L_csl=bank_y / half, L_ldl=dram.swd_width(tech) + dram.mat_cols * dram.isolation_cols_overhead * tech.pitch_bl,
                L_mdl=bank_y / half if share == 0 else math.ceil(dram.banks / 2) * slot,
                L_bus=dram.wire_lengths(tech)['bgbus+gbus'], r3=r(w3), r2=r(w2),
                c_csl=per_um(tech._c_csl, csl_r), c_mdl=per_um(tech._c_mdl, mdl_r), c_ldl=tech.scale_cap(tech._c_ldl))


def staged_times(g, ref, kappa, logic_conf, pumps, share, ecc, bus_sd=1):
    """(bank cycle per pump, shared stage per atom, bank parts, shared parts per atom) in ns. ecc is the OD-ECC + DBI
    stage in FO4 (0 when the stage is off or sits in each bank)."""
    fo4 = kappa * (g['f'] / 0.016) ** logic_conf
    rc = lambda r, c, L: 0.38 * r * c * L * L * 1e-3  # distributed RC (Elmore), ohm * pF = ps
    load = lambda k: g['c_' + k] * g['L_' + k] / (ref['c_' + k] * ref['L_' + k])
    dev = lambda k, ld=None: fo4 * (STAGED[k][0] + STAGED[k][1] * (load(ld or k) if STAGED[k][1] else 0))
    parts = {
        'csl': dev('csl') + rc(g['r3'], g['c_csl'], g['L_csl']),
        'ldl': dev('ldl') + rc(g['r2'], g['c_ldl'], g['L_ldl']),
        'mdl': dev('mdl') + rc(g['r3'], g['c_mdl'], g['L_mdl']),
        'iosa': dev('iosa'),
        'eq': dev('eq', 'mdl') + 0.5 * rc(g['r3'], g['c_mdl'], g['L_mdl']),
    }
    bank = sum(parts.values())
    flight = g['L_bus'] / 1000 * STAGED['bus_fo4_mm'] * fo4
    shared = {'ecc': pumps * ecc * fo4,
              'bgbus': pumps * bus_sd * (STAGED['bus_launch'] * fo4 + STAGED['bus_skew'] * flight)}
    if share >= 1:
        shared['iosa_shared'] = pumps * STAGED['iosa_shared'] * fo4
    if share == 2:
        shared['mdl_line'] = pumps * (parts['mdl'] + parts['iosa'] + parts['eq'])
    return bank, max(shared.values()), parts, shared


@functools.lru_cache(maxsize=None)
def staged_reference(dreamram_dir, mem_json):
    """Calibration: the HBM3 baseline at 16 nm with its I/O-control IOSAs -> (reference geometry, kappa in ns)."""
    with contextlib.redirect_stdout(io.StringIO()):
        dram, tech, _, _, _ = build(dreamram_dir, mem_json, 'configs/tech/scaled/16nm_scaled.json', {}, None)
    g = staged_geometry(dram, tech, STAGED['ref_share'], 0)
    a = staged_times(g, g, 0.0, tech.logic_scale_conf, 1, STAGED['ref_share'], STAGED['ecc'])
    b = staged_times(g, g, 1.0, tech.logic_scale_conf, 1, STAGED['ref_share'], STAGED['ecc'])
    # tCCD_L = max(bank, shared) is affine in kappa on each side: pick the kappa that makes the larger one 2 ns
    kappa = min((STAGED['ref_tck'] - a[0]) / (b[0] - a[0]), (STAGED['ref_tck'] - a[1]) / (b[1] - a[1]))
    return g, kappa


# ---- per-row activation counting (prac) ---------------------------------------------------------------------
# PRHT (Kim et al., SK hynix, ISSCC 2023, 28.8) / DDR5 PRAC: every activated row carries a counter in extra R/H cell
# columns, and each activation does a read-modify-write of it (activation counter update, ACU: internal read through
# an IOSA, +1, internal write). DDR5 runs the ACU after PRECHARGE, while the row finishes restoring, so tRP grows by
# the ACU time and tRAS can end right after sensing. Calibrated on DDR5-3200AN (JESD79-5 speed bin vs Table 343):
DDR5_PRAC = {'default': dict(trcd=15.0, trp=15.0, tras=32.0, trc=47.0, trtp=7.5, twr=30.0, tccdl=5.0),
             'prac': dict(tras=16.0, trp=36.0, trc=52.0, trtp=5.0, twr=10.0)}
PRAC = {
    'acu_cycles': (DDR5_PRAC['prac']['trp'] - DDR5_PRAC['default']['trp']) / DDR5_PRAC['default']['tccdl'],  # 4.2 column cycles
    'tras_floor': DDR5_PRAC['prac']['tras'] / DDR5_PRAC['default']['trcd'],  # tRAS >= tRCD x 16/15
    'trtp_scale': DDR5_PRAC['prac']['trtp'] / DDR5_PRAC['default']['trtp'],
    'twr_scale': DDR5_PRAC['prac']['twr'] / DDR5_PRAC['default']['twr'],
}


# ---- structural on-die ECC and PRAC circuits (odecc_model, prac_model) ------------------------------------------
# Logic is counted in 2-input-gate equivalents and logic levels. One level costs LEVEL_FO4 FO4, calibrated so the
# HBM3 OD-ECC (two RS(19,17) codewords over 8-bit symbols per 32 B, t = 1; Ryu et al.) decodes in the staged model's
# 24 FO4 prior. Gate counts set the I/O-control height relative to that same HBM3 engine, which DreamRAM sizes at 1%
# of the baseline bank height, so the node cancels out. js/model.js mirrors this section.
import math as _m

CIRC = {
    'dbi_gates_byte': 25,   # popcount of 8 bits + majority compare + 8 inverting XORs
    'dbi_levels': 7,        # in parallel with the ECC decode (Ryu et al.: shared logic)
    'reg_fo4': 2,           # pipeline register overhead when the ECC stage is split
    'inc_gates_bit': 21 / 8,  # Chronus (Canpolat et al., HPCA 2025): 8-bit decrementer in 21 gates
    'ff_gates': 6,          # flip-flop / latch bit, in gate equivalents
    'sa_gates': 20,         # counter IOSA + write driver per counter bit
    'row_addr_bits': 17,    # PRHT keeps three row-address latches (current, max, mitigation)
}


def _lg(x):
    return max(0, _m.ceil(_m.log2(x))) if x > 1 else 0


def ecc_circuit(sym, t, cw32, md_prop, atom=256):
    """Symbol-based OD-ECC engine for one access of `atom` data bits: cw32 Reed-Solomon codewords per 32 B over
    sym-bit symbols, correcting t symbols each. Returns check-bit share of the cells, gates, decode/encode levels."""
    ncw = cw32 * atom // 256
    kb = 256 * (1 + md_prop) / cw32           # data + metadata bits per codeword (HBM4: 272 b per 32 B)
    k = _m.ceil(kb / sym)
    n, rb = k + 2 * t, 2 * t * sym
    nb = k * sym + rb
    syn = rb * (nb / 2 - 1)                     # syndrome bits: XOR of half the codeword each
    enc = rb * (k * sym / 2 - 1)                # check-bit generator for writes
    const = sym * (sym / 2 - 1)                 # constant GF(2^m) multiply
    mul = 2 * sym * sym                         # variable GF(2^m) multiply
    lv_const, lv_mul, lv_cmp = _lg(sym / 2), 2 + _lg(sym), 1 + _lg(sym)
    lv_inv = (_lg(sym) + 1) * lv_mul            # inverse by exponentiation
    if t == 1:  # S0 is the error value; the position i with S1 == alpha^i S0 is the error
        loc, lv_loc = n * (const + 2 * sym), lv_const + lv_cmp
    else:       # Peterson (sigma from syndromes) + Chien search + Forney values
        loc = 6 * mul + (_lg(sym) + 1) * mul + n * (2 * const + 3 * sym) + n * mul
        lv_loc = (2 * lv_mul + lv_inv) + (lv_const + 1 + lv_cmp) + lv_mul
    corr = 2 * k * sym
    dec_levels = _lg(nb / 2) + lv_loc + 2
    gates = ncw * (syn + enc + loc + corr) + atom / 8 * CIRC['dbi_gates_byte']
    return dict(ncw=ncw, n=n, k=k, nb=nb, check_prop=cw32 * rb / 256, gates=gates, dec_levels=dec_levels,
                enc_levels=_lg(k * sym / 2), levels=max(dec_levels, CIRC['dbi_levels']))


ECC_REF = ecc_circuit(8, 1, 2, 1 / 16)          # HBM3 (Ryu et al.)
LEVEL_FO4 = STAGED['ecc'] / ECC_REF['levels']  # FO4 per logic level


def ecc_stage_fo4(e, pipe):
    """FO4 of the OD-ECC + DBI stage that bounds throughput, split into `pipe` register stages."""
    return e['levels'] * LEVEL_FO4 / pipe + (CIRC['reg_fo4'] if pipe > 1 else 0)


def prac_circuit(bits, prot, ecc):
    """Counter-update logic for one bank: counter IOSAs / write drivers, incrementer, threshold compare, PRHT latches
    and the counter's protection. prot: 0 none, 1 parity, 2 own SEC-DED code, 3 inside the OD-ECC codeword."""
    if prot == 1:
        extra, enc_l, dec_l, code = 1, _lg(bits + 1), _lg(bits + 1), bits
    elif prot == 2:
        r = 1
        while 2 ** r < bits + r + 1:
            r += 1
        r += 1                                       # + overall parity for double-error detection
        extra, enc_l, dec_l, code = r, _lg(bits / 2), _lg(bits / 2) + _lg(r) + 1, 2 * r * bits / 2 + bits * (r + 1)
    elif prot == 3:  # read, correct and re-encode the whole codeword holding the counter
        extra, enc_l, dec_l, code = 0, ecc['enc_levels'], ecc['dec_levels'], 0
    else:
        extra, enc_l, dec_l, code = 0, 0, 0, 0
    width = bits + extra if prot != 3 else ecc['nb']  # bits the counter path reads and writes
    gates = (CIRC['inc_gates_bit'] * bits + 2 * bits + CIRC['ff_gates'] * (bits + 3 * CIRC['row_addr_bits'])
             + CIRC['sa_gates'] * width + code)
    return dict(cells=bits + extra, width=width, gates=gates, inc_levels=_lg(bits) + 1, enc_levels=enc_l, dec_levels=dec_l)


def extended_hbm(Hbm, coupled, edge_pairing, ioctl_h=0, channel_rows=1, tccd_bgbus=0,
                 tck_fixed=1, tck_fixed_scale=0, tck_wire=1, bw_bg_cap=0, tsv_chain=0,
                 tccd_staged=0, mdl_share=1, col_mid=0, od_ecc_logic=1, prac=0, prac_bits=12, prac_model=0, prac_when=0,
                 prac_path=0, prac_prot=0, odecc_model=0, odecc_sym=8, odecc_t=1, odecc_cw=2, odecc_where=0, odecc_pipe=1):
    """Hbm subclass adding coupled rows, edge-subarray pairing and an I/O-control height override
    (identical to Hbm when all are off)."""
    import numpy as np
    assert coupled >= 1 and coupled & (coupled - 1) == 0, 'coupled_rows must be a power of two'
    tck_default = tck_fixed == 1 and not tck_fixed_scale and tck_wire == 1

    class ExtendedHbm(Hbm):
        # Column-side page split: a READ reaches only the addressed logical row's 1/C of the MATs.
        # Activation-side counts (ind_row_pages: LWLs, bitlines, ACT energy) stay at the full wordline.
        def ind_pages(self):
            return super().ind_pages() * coupled

        def page_act_size(self):
            p = super().page_act_size() / coupled
            assert p == int(p)
            return int(p)

        def min_atom(self):
            return super().min_atom() / coupled

        def mdl_width_per_page(self):
            return super().mdl_width_per_page() / coupled

        def ch_cmd_bits(self):
            # Hbm.ch_cmd_bits plus log2(coupled) host-visible row bits that pick one of the coupled rows
            sid_bits = max(2, int(np.ceil(np.log2(max(self.sids, 2)))))
            ba_bits = np.ceil(np.log2(self.vert_bg * self.horiz_bg * self.banks))
            pc_bits = np.ceil(np.log2(self.pch))
            ra_bits = (np.ceil(np.log2(self.subarrays)) + np.ceil(np.log2(self.mat_rows))
                       + np.log2(self.ind_row_pages()) + np.log2(coupled))
            ca_bits = np.ceil(np.log2(self.atoms_per_page()))
            row = int(max(3 + pc_bits + sid_bits + ba_bits, 2 + int(np.ceil(ra_bits / 2))))
            col = int(np.ceil((4 + pc_bits + sid_bits + ba_bits + ca_bits) / 2))
            return row, col

        # The coupled rows share one column datapath (MDLs muxed onto the BGBUS, then the channel's TSVs
        # and DQs), so per-access DQ counts and data TSVs follow the logical row, not C separate pages.
        def wire_counts(self):
            s = self.gbus_tsv_sd
            if s < 1:
                # Hbm.wire_counts asserts tsv <= one atom; fold the fan-out into tsv_dq_sd (dq_count only uses the
                # product), then recount the TSVs: each GBUS wire spreads over 1 / gbus_tsv_sd slower TSVs
                self.gbus_tsv_sd, self.tsv_dq_sd = 1, s * self.tsv_dq_sd
                try:
                    n = super().wire_counts()
                finally:
                    self.gbus_tsv_sd, self.tsv_dq_sd = s, self.tsv_dq_sd / s
                n['tsv'] = np.ceil(self.gbus_width() * self.md_ecc_factor() / s)
            else:
                n = super().wire_counts()
            if coupled > 1:
                n['dq'] = np.ceil(self.dq_count() / (self.pch * self.channels * Hbm.ind_pages(self)))
            return n

        def atom_time(self, tech):
            return self.atom_size * self.md_ecc_factor() * self.core_tck(tech) / (
                self.dq_speed_factor() * (self.dq_count() / (self.pch * self.channels * Hbm.ind_pages(self))))

        def calc_stack_dims(self, tech):
            if coupled == 1 and not tsv_chain:
                return super().calc_stack_dims(tech)
            # Hbm.calc_stack_dims with data TSVs counted per logical row (ldls_mdls * mats / coupled), or with
            # tsv_chain from the serdes chain (every pseudo-channel's GBUS / gbus_tsv_sd, ECC and DBI in proportion)
            dies_stacked = int(self.sids * self.channels / self.ch_per_die)
            die_width, non_tsv_y = self.bankdie_dims(tech)
            row, col = self.ch_cmd_bits()
            cmd_tsv_count = self.channels * (4 * row + 4 * col + 4 + 1)
            dbi_signals = (self.dbi_factor - 1) * self.bgbus_width()
            if tsv_chain:
                data = self.pch * self.subchannels * self.gbus_width() / self.gbus_tsv_sd
                data_tsv_count = self.channels * (data * self.md_ecc_factor() + (self.dbi_factor - 1) * data + 16 + 8)
            else:
                data_tsv_count = self.channels * (self.ldls_mdls * self.mats / coupled + 1 / (self.md_ecc_factor() - 1)
                                                  + dbi_signals + 16 + 8)
            height_per_tsv = 1 / ((die_width - 2 * tech.tsv_koz) * tech.tsv_density())
            cmd_tsv_y = cmd_tsv_count * height_per_tsv
            data_tsv_y = data_tsv_count * height_per_tsv
            other_tsv_y = 0.2 * (cmd_tsv_y + data_tsv_y) + 2 * tech.tsv_koz
            return dies_stacked, die_width, non_tsv_y, cmd_tsv_y, data_tsv_y, other_tsv_y

        def dummy_subarray_height(self, tech):
            return 0.0 if edge_pairing else super().dummy_subarray_height(tech)

        def bankdie_dims(self, tech):
            if channel_rows == 1:
                return super().bankdie_dims(tech)
            # Hbm.bankdie_dims with ch_per_die / channel_rows channels across, and each row of channels
            # stacking all vert_bg bank groups on its side of the TSV region
            assert self.ch_per_die % channel_rows == 0, 'ch_per_die must be a multiple of channel_rows'
            bank_x, bank_y, _ = self.bank_dims(tech)
            row_dec_width, _ = self.decoder_dims(tech)
            x = self.ch_per_die / channel_rows * self.pch * self.horiz_bg * (bank_x + 2.0 * row_dec_width)
            y = (channel_rows * self.vert_bg * (self.banks * (bank_y + self.dummy_subarray_height(tech)) + self.od_ecc_height(tech))
                 + self.mbus_peri_height(tech))
            return x, y

        def fixed_tck(self, tech):
            # length-independent share of the column cycle (DreamRAM's mdl_csl_driver_time = 1 ns)
            return tck_fixed * (np.pow(tech.f / 0.016, tech.logic_scale_conf) if tck_fixed_scale else 1)

        def bank_stage_tck(self, tech):
            if tck_default:
                return Hbm.core_tck(self, tech)  # DreamRAM: CSL + MDL over the bank height, LDL across a MAT
            # Hbm.core_tck with the fixed share and the wire-length law as configured
            mat_width = self.swd_width(tech) + self.mat_cols * self.isolation_cols_overhead * tech.pitch_bl
            _mat_width = tech.scaled_swd_width() + self._mat_cols * self.isolation_cols_overhead * tech.pitch_bl
            bank_x, bank_y, cell_area = self.bank_dims(tech)
            _bank_y = self._bank_y_calc(tech)
            csl_pitch_ratio, mdl_pitch_ratio = self.csl_mdl_pitch_ratios(tech)
            rc_ratio_csl = tech.rc_ratio_fixed_width(csl_pitch_ratio, tech._c_within_layer_sparse_csl_mdl)
            rc_ratio_mdl = tech.rc_ratio_fixed_width(mdl_pitch_ratio, tech._c_within_layer_sparse_csl_mdl)
            res_ratio = tech.pitch_bl / tech.pitch_wl
            c_csl, c_mdl, c_ldl = tech.scale_cap(tech._c_csl), tech.scale_cap(tech._c_mdl), tech.scale_cap(tech._c_ldl)
            denom = (c_csl + 2 * c_mdl) * _bank_y + (res_ratio * c_ldl) * _mat_width
            sq = tck_wire == 2  # unrepeated RC: delay ~ length squared
            numer = ((rc_ratio_csl * c_csl + 2 * rc_ratio_mdl * c_mdl) * bank_y * (bank_y / _bank_y if sq else 1)
                     + (res_ratio * c_ldl) * mat_width * (mat_width / _mat_width if sq else 1))
            return self.fixed_tck(tech) + (self._tck - tck_fixed) * numer / denom

        def bgbus_stage_tck(self, tech):
            # The bank group's shared BG-BUS window: a repeated wire, so delay is linear in length times its
            # pitch-dependent capacitance (the factors DreamRAM applies to tCL), calibrated so the baseline
            # bank group's window equals the baseline tCK.
            length = self.wire_lengths(tech)['bgbus+gbus']
            c = tech.c_ratio(self.bgbus_pitch_ratio(tech), tech._c_within_layer_sparse)
            return self.fixed_tck(tech) + (self._tck - tck_fixed) * length * c / self._bgbus_len_ref

        def ecc(self):
            return ecc_circuit(odecc_sym, odecc_t, odecc_cw, self.md_ecc_prop, self.atom_size) if odecc_model else None

        def ecc_fo4(self):
            # OD-ECC + DBI stage in FO4: the 24 FO4 prior, or the structural engine split into odecc_pipe stages
            if not od_ecc_logic:
                return 0
            return ecc_stage_fo4(self.ecc(), odecc_pipe) if odecc_model else STAGED['ecc']

        def staged(self, tech):
            ref, kappa = self._staged_ref
            g = staged_geometry(self, tech, mdl_share, col_mid)
            shared_ecc = 0 if (odecc_model and odecc_where == 1) else self.ecc_fo4()
            return staged_times(g, ref, kappa, tech.logic_scale_conf, self.pumps_per_atom(), mdl_share, shared_ecc,
                                self.mdl_bgbus_sd)

        def ecc_bank_stage(self, tech):
            # per-bank OD-ECC (odecc_where = 1): each bank decodes its own words, once per pump
            if not (odecc_model and odecc_where == 1):
                return 0.0
            _, kappa = self._staged_ref
            return self.ecc_fo4() * kappa * (tech.f / 0.016) ** tech.logic_scale_conf

        # PRAC: counter cells (prac_bits per independently activated row segment) widen every subarray row; they hold
        # no data, so cell_area (and cell efficiency) leaves them out
        def prac_circ(self):
            return prac_circuit(prac_bits, prac_prot, self.ecc() or ecc_circuit(8, 1, 2, self.md_ecc_prop, self.atom_size)) \
                if (prac and prac_model) else None

        def prac_cells(self):
            # counter bits (+ protection) per independently activated row segment
            return (self.prac_circ()['cells'] if prac_model else prac_bits) if prac else 0

        def prac_width(self, tech):
            # in-row counter columns; the Chronus counter subarray (prac_when = 2) keeps them out of the rows
            if not prac or (prac_model and prac_when == 2):
                return 0.0
            return self.prac_cells() * self.ind_row_pages() * self.isolation_cols_overhead * tech.pitch_bl

        def counter_rows(self):
            # Chronus: every row's counter lives in a small counter subarray at the bank edge
            rows = self.subarrays * self.mat_rows * self.ind_row_pages() * self.prac_cells()
            return _m.ceil(rows / (self.mats * self.mat_cols))

        def counter_height(self, tech):
            if not (prac and prac_model and prac_when == 2):
                return 0.0
            return self.counter_rows() * self.isolation_rows_overhead * tech.pitch_wl + self.blsa_height(tech)

        def bank_dims(self, tech):
            x, y, cells = super().bank_dims(tech)
            return x + self.prac_width(tech), y + self.counter_height(tech), cells

        def prac_shared_path(self):
            # the update runs over the bank group's I/O control when asked to, or when the counter sits inside an
            # OD-ECC codeword whose only decoder is the bank group's
            return prac_path == 1 or (prac_prot == 3 and not (odecc_model and odecc_where == 1))

        def prac_parts(self, tech):
            """Activation counter update, ns by component (prac_model = 1)."""
            ref, kappa = self._staged_ref
            fo4 = kappa * (tech.f / 0.016) ** tech.logic_scale_conf
            shared = self.prac_shared_path()
            g = staged_geometry(self, tech, 1 if shared else 0, col_mid)
            _, _, pt, _ = staged_times(g, ref, kappa, tech.logic_scale_conf, 1, 0, 0)
            c = self.prac_circ()
            lv = lambda n: n * LEVEL_FO4 * fo4
            col = pt['csl'] + pt['ldl'] + pt['mdl'] + pt['iosa']  # one column read (or write: IOSA -> write driver)
            # counter cells restore after the write; a counter subarray's short bitlines restore faster
            rows = self.counter_rows() if prac_when == 2 else self.mat_rows
            bl = lambda r: tech._c_bl_per_cell * r * self.isolation_rows_overhead
            restore = tech._twr_restore * (tech._c_cell + bl(rows)) / (tech._c_cell + bl(tech._mat_rows_ref))
            parts = dict(read=col, decode=lv(c['dec_levels']), increment=lv(c['inc_levels']), encode=lv(c['enc_levels']),
                         equalise=pt['eq'], write=col)
            busy = sum(parts.values())  # the counter path is occupied this long
            parts['restore'] = restore
            # worst case: an all-bank precharge queues every bank of the group on one shared counter path
            parts['queue'] = (self.banks - 1) * busy if shared else 0.0
            return parts

        def acu_time(self, tech):
            if prac_model:
                return sum(self.prac_parts(tech).values())
            # DDR5 ratio: acu_cycles x one column cycle of the bank's own path (one pump)
            return PRAC['acu_cycles'] * (self.staged(tech)[0] if tccd_staged else self.bank_stage_tck(tech))

        def prac_after_pre(self):
            return prac and (not prac_model or prac_when == 0)

        def trp(self, tech):
            return super().trp(tech) + (self.acu_time(tech) if self.prac_after_pre() else 0)

        def tras(self, tech):
            t = super().tras(tech)
            if self.prac_after_pre():
                return max(PRAC['tras_floor'] * self.trcd(tech), t - self.acu_time(tech))
            if prac:  # PRHT (row open) or Chronus (counter subarray): the update must finish before PRE
                return max(t, self.trcd(tech) + self.acu_time(tech))
            return t

        def trtp(self, tech):
            return super().trtp(tech) * (PRAC['trtp_scale'] if self.prac_after_pre() else 1)

        def twr(self, tech):
            t = super().twr(tech)
            return max(PRAC['twr_scale'] * t, t - self.acu_time(tech)) if self.prac_after_pre() else t

        def logic_gates_bg(self):
            """Gate equivalents in one bank group's I/O control: OD-ECC engine(s) and PRAC logic, per-bank units included."""
            e = self.ecc() or ECC_REF
            g = e['gates'] * (self.banks if (odecc_model and odecc_where == 1) else 1)
            c = self.prac_circ()
            if c:
                g += c['gates'] * (1 if self.prac_shared_path() else self.banks)
            return g

        def core_tck(self, tech):
            if tccd_staged:
                # tCCD_L = core_tck x pumps (Hbm.tccdl) = max(pumps x bank cycle, shared stage per atom); every shared
                # stage is paid per pump or per transfer, so pumping never amortises it
                bank, shared, _, _ = self.staged(tech)
                return max(bank, self.ecc_bank_stage(tech), shared / self.pumps_per_atom())
            t = self.bank_stage_tck(tech)
            return max(t, self.bgbus_stage_tck(tech)) if tccd_bgbus else t

        def bandwidth(self, tech):
            bw = super().bandwidth(tech)
            if bw_bg_cap:
                # a pseudo-channel cannot outrun its bank groups, each delivering one atom per tCCD_L
                per_bg = self.atom_size / 8 / self.tccdl(tech)
                need = bw / (self.channels * self.pch) / per_bg
                bgs = self.horiz_bg * self.vert_bg
                if bgs < need:
                    bw = bw * bgs / need
            return bw

        def od_ecc_height(self, tech):
            # each bank group's I/O control block (IOSA/WD, OD-ECC + DBI, BG-BUS drivers). With the structural ECC or
            # PRAC models it scales with the logic it holds, relative to DreamRAM's HBM3 engine (1% of the baseline bank)
            if ioctl_h > 0:
                return float(ioctl_h)
            h = super().od_ecc_height(tech)
            if odecc_model or (prac and prac_model):
                h *= self.logic_gates_bg() / ECC_REF['gates']
            return h

    if coupled == 1:  # keep DreamRAM's own datapath accounting untouched
        delattr(ExtendedHbm, 'atom_time')

    return ExtendedHbm


def export(dram, tech, p, metrics, status):
    rowdec_w, coldec_h = dram.decoder_dims(tech)
    bank_x, bank_y, cell_area = dram.bank_dims(tech)
    dies, die_w, non_tsv_y, cmd_tsv_y, data_tsv_y, other_tsv_y = dram.calc_stack_dims(tech)
    die_h = non_tsv_y + cmd_tsv_y + data_tsv_y + other_tsv_y
    row, col = dram.ch_cmd_bits()
    try:
        n = {k: float(v) for k, v in dram.wire_counts().items()}
    except AssertionError:  # DreamRAM asserts on wire widths wider than an atom; such designs are discarded anyway
        n = {}
    l = {k: float(v) for k, v in dram.wire_lengths(tech).items()}
    f = float
    return {
        'source': 'dreamram',
        'params': {k: (int(v) if float(v).is_integer() else float(v)) for k, v in p.items()},
        'tech': {
            'f': f(tech.f), '_f': f(tech._f), 'logic_scale_conf': f(tech.logic_scale_conf),
            'pitch_wl': f(tech.pitch_wl), 'pitch_bl': f(tech.pitch_bl), 'pitch_ldl': f(tech.pitch_ldl),
            'tsv_pitch': f(tech.tsv_pitch), 'ubump_pitch': f(tech.ubump_pitch), 'tsv_koz': f(tech.tsv_koz),
            'max_die_um': f(tech.max_die_dims_mm * 1000), 'max_stack_dies': f(tech.max_stack_dies),
            'md_ecc_prop': f(dram.md_ecc_prop), 'od_ecc_prop': f(dram.od_ecc_prop),
            'iso_rows': f(dram.isolation_rows_overhead), 'iso_cols': f(dram.isolation_cols_overhead),
            'open_bl': int(dram.open),
        },
        'geom': {
            'rowdec_w': f(rowdec_w), 'coldec_h': f(coldec_h), 'swd_w': f(dram.swd_width(tech)),
            'blsa_h': f(dram.blsa_height(tech)), 'bank_x': f(bank_x), 'bank_y': f(bank_y),
            'cell_area_bank': f(cell_area), 'dummy_y': f(dram.dummy_subarray_height(tech)),
            'od_ecc_h': f(dram.od_ecc_height(tech)), 'mbus_h': f(dram.mbus_peri_height(tech)),
            'center_w': f(2.0 * rowdec_w), 'dies': int(dies), 'die_w': f(die_w), 'die_h': f(die_h),
            'non_tsv_y': f(non_tsv_y), 'cmd_tsv_y': f(cmd_tsv_y), 'data_tsv_y': f(data_tsv_y),
            'other_tsv_y': f(other_tsv_y), 'cell_eff': f(dram.cell_efficiency(tech)),
        },
        'derived': {
            'capacity_gb': f(dram.capacity()), 'page_bits': int(dram.page_act_size()),
            'ind_pages': int(dram.ind_pages()), 'ind_row_pages': int(dram.ind_row_pages()),
            'pumps_per_atom': f(dram.pumps_per_atom()), 'dq_count': int(dram.dq_count()),
            'row_cmd_bits': int(row), 'col_cmd_bits': int(col),
            'total_area_mm2': f(dram.total_area(tech)),
            'tck_bank_stage': f(dram.bank_stage_tck(tech)) if hasattr(dram, 'bank_stage_tck') else None,
            'tck_bgbus_stage': f(dram.bgbus_stage_tck(tech)) if hasattr(dram, 'bgbus_stage_tck') else None,
            **({'prac_acu_ns': f(dram.acu_time(tech)), 'prac_width_um': f(dram.prac_width(tech)),
                'prac_counter_h_um': f(dram.counter_height(tech)),
                **({'prac_parts': {k: f(v) for k, v in dram.prac_parts(tech).items()}} if p.get('prac_model') else {})}
               if p.get('prac') else {}),
            **({'odecc': {k: f(v) for k, v in dram.ecc().items()}, 'odecc_fo4': f(dram.ecc_fo4()),
                'ecc_bank_ns': f(dram.ecc_bank_stage(tech))} if p.get('odecc_model') else {}),
            'ioctl_h_um': f(dram.od_ecc_height(tech)),
            **({'staged_bank_ns': f(st[0]), 'staged_shared_ns': f(st[1]), 'staged_parts': {k: f(v) for k, v in {**st[2], **st[3]}.items()}}
               if getattr(dram, '_staged_ref', None) and (st := dram.staged(tech)) else {}),
        },
        'wire_counts': n,
        'wire_lengths': l,
        'status': status,  # 0 = kept by dreamram.simulate(); otherwise its discard code
        'metrics': {k: float(metrics[k]) for k in METRICS if k in metrics},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dreamram', required=True, help='path to the DreamRAM checkout')
    ap.add_argument('-m', '--mem', default='configs/mem/sweep/hbm_sweep_default.json')
    ap.add_argument('-t', '--tech', default='configs/tech/scaled/16nm_scaled.json')
    ap.add_argument('--set', action='append', default=[], metavar='KEY=VALUE')
    ap.add_argument('--csv', help='DreamRAM sweep CSV to take a design point from')
    ap.add_argument('--row', type=int, help='row index in --csv (0 is the baseline)')
    ap.add_argument('--max-die-mm', type=float, help='override the 13 mm die-dimension filter (status 11)')
    ap.add_argument('-o', '--out', default='-')
    a = ap.parse_args()

    out = a.out if a.out == '-' else os.path.abspath(a.out)
    overrides = {}
    if a.csv is not None:
        with open(os.path.abspath(a.csv)) as fh:
            for i, r in enumerate(csv.DictReader(fh)):
                if i == a.row:
                    overrides = {k: float(r[k]) for k in PARAMS if k in r and r[k] != ''}
                    break
            else:
                sys.exit(f'row {a.row} not found in {a.csv}')
    for kv in a.set:
        k, v = kv.split('=', 1)
        if k not in PARAMS and k not in EXTENSIONS:
            sys.exit(f'unknown parameter {k}; expected one of {", ".join(PARAMS)}')
        overrides[k] = float(v)
    overrides = {k: int(v) if float(v).is_integer() else v for k, v in overrides.items()}

    dram, tech, p, metrics, status = build(os.path.abspath(a.dreamram), a.mem, os.path.abspath(a.tech) if os.path.exists(a.tech) else a.tech, overrides, a.max_die_mm)
    if status != 0:
        print(f'note: dreamram.simulate() discards this design (status {status}); exporting geometry anyway',
              file=sys.stderr)
    try:
        js = json.dumps(export(dram, tech, p, metrics, status), indent=1)
    except (AssertionError, ValueError, ZeroDivisionError) as e:
        sys.exit(f'DreamRAM cannot evaluate this design (simulate() status {status}): {e!r}')
    if out == '-':
        print(js)
    else:
        open(out, 'w').write(js + '\n')
        print('wrote', out, file=sys.stderr)


if __name__ == '__main__':
    main()
