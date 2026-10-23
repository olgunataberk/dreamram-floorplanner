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
"""
import argparse
import csv
import functools
import json
import os
import sys

PARAMS = ['sids', 'channels', 'ch_per_die', 'pch', 'horiz_bg', 'vert_bg', 'banks', 'subarrays',
          'mat_rows', 'mats', 'mat_cols', 'brvsa', 'ldls_mdls', 'mdl_over_mat', 'csl_mdl_over_mat',
          'csl_mdl_shared_layer', 'ha_layout', 'ha_double_ldls', 'subchannels', 'salp_groups',
          'salp_all', 'pages_per_bgbus_mux', 'mdl_bgbus_sd', 'bgbuses_per_gbus', 'bgbus_gbus_sd',
          'gbus_tsv_sd', 'tsv_dq_sd', 'atom_size']
EXTENSIONS = {'coupled_rows': 1, 'coupled_lsb': 0, 'edge_pairing': 0, 'ioctl_h': 0, 'channel_rows': 1, 'tccd_bgbus': 0,
              'tck_fixed': 1, 'tck_fixed_scale': 0, 'tck_wire': 1, 'bw_bg_cap': 0, 'tsv_chain': 0}  # coupled_lsb only labels rows


METRICS = ['capacity_gbytes', 'bw_gbytes', 'worst_latency_ns', 'metric_e_per_bit_closed',
           'metric_e_per_bit_seq', 'worst_power_w', 'total_area_mmmm', 'die_x_mm', 'die_y_mm', 'cell_eff',
           'core_freq_ghz', 'dq_datarate_gbps', 'tcl', 'trcd', 'trp', 'tccdl', 'page_size_bytes']


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
                         **{k: overrides.get(k, EXTENSIONS[k]) for k in ('tck_fixed', 'tck_fixed_scale', 'tck_wire', 'bw_bg_cap', 'tsv_chain')})

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


def extended_hbm(Hbm, coupled, edge_pairing, ioctl_h=0, channel_rows=1, tccd_bgbus=0,
                 tck_fixed=1, tck_fixed_scale=0, tck_wire=1, bw_bg_cap=0, tsv_chain=0):
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

        def core_tck(self, tech):
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
            # each bank group's I/O control block (IOSA/WD, OD-ECC + DBI, BG-BUS drivers)
            return float(ioctl_h) if ioctl_h > 0 else super().od_ecc_height(tech)

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
