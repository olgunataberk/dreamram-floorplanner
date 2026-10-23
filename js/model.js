// In-browser port of DreamRAM's physical model (hbm.py / tech.py / dreamram.py filters).
// Every formula here mirrors a function in DreamRAM; the function name is noted next to it.
// tools/export_floorplan.py exports the same quantities from DreamRAM itself, and loading such an
// export into the visualizer cross-checks this port against the simulator.
(function () {
  'use strict';

  const DR = (window.DR = window.DR || {});

  // Tech nodes shipped with DreamRAM (configs/tech/scaled/*.json + baseline + hbm3_timing_baseline.json).
  const TECH_COMMON = {
    _f: 0.026, logic_conf: 0.9, c_conf: 0.7,
    _coldec_h: 150, _rowdec_w: 82.5, _blsa_h: 11, _swd_w: 5,
    brvsa_h_ratio: 1.33, mdl_over_mat_h_ratio: 1.26,
    // Tech.pitch_ldl is a dataclass default evaluated from the *class* defaults (0.041 * 2) and is
    // never overridden by dreamram.py, so it stays 0.082 um regardless of the scaled node.
    pitch_ldl: 0.082, mdl_to_bl_min: 4,
    // TSV values come from hbm3_timing_baseline.json (overrides the 2ynm process baseline)
    tsv_pitch: 25, ubump_pitch: 40, tsv_koz: 4, tsv_height: 30,
    _tsv_pitch: 55, _tsv_height: 50, _c_tsv: 1.1, _c_load: 0.12, _r_load: 100,
    max_die_um: 13000, max_stack_dies: 16,
    md_ecc: 1 / 16, od_ecc: 1 / 8, iso_rows: 1.015, iso_cols: 1.015, dbi: 1.125, dbi_bgbus: 1, open_bl: 1,
    _c_csl: 0.00098, _c_mdl: 0.00049, _c_ldl: 0.00049, c_within_sparse: 0.66, c_within_csl_mdl: 0.33,
    _c_bl_per_cell: 0.0000417, _c_cell: 0.008, _c_blsa: 0.0033,
    _trcd: 18, _trcd_brvsa: 10.8, _trcd_signal: 2.9, brvsa_cs_prop: 0.89, mat_rows_ref: 512,
  };
  DR.TECH_PRESETS = {
    '16nm': Object.assign({ label: '16 nm scaled (HBM3, default)', f: 0.016, pitch_wl: 0.041, pitch_bl: 0.047 }, TECH_COMMON),
    '17nm': Object.assign({ label: '17 nm (HBM2E node)', f: 0.017, pitch_wl: 0.043, pitch_bl: 0.050 }, TECH_COMMON),
    // HBM4-class array: 34 nm WL / 36 nm BL pitch. f keeps DreamRAM's f-to-cell-area ratio
    // (16 nm ↔ 41×47 nm cell): f = 16 nm × sqrt(34·36 / (41·47)) = 12.75 nm. configs/tech/hbm4_34wl_36bl.json
    'hbm4': Object.assign({ label: 'HBM4 array: 34 nm WL / 36 nm BL', f: 0.01275, pitch_wl: 0.034, pitch_bl: 0.036 }, TECH_COMMON),
  };
  // Design presets (sweep-CSV parameter names); the tech key is applied alongside.
  DR.DESIGN_PRESETS = {
    hbm4_1sid: {
      label: 'HBM4 · 1 SID (4-high, 32 Gb/die)', tech: 'hbm4',
      // JESD270-4: 32 channels, 2 PCs, 4 dies (8 ch/die), 16 banks per PC in 2 bank groups of 8,
      // 1 KiB row per PC (16 data MATs × 512 BL), 16 K rows per bank (RA[13:0] = 32 × 512 WL),
      // 256-bit prefetch per pump (16 MATs × 16 MDLs)
      params: { sids: 1, channels: 32, ch_per_die: 8, pch: 2, horiz_bg: 1, vert_bg: 2, banks: 8, mats: 16, mat_cols: 512, ldls_mdls: 16, subarrays: 32, mat_rows: 512 },
    },
    samsung_hbm4_12h: {
      label: 'Samsung HBM4 org (ISSCC 2026) · 12-high, 2 channel rows', tech: 'hbm4',
      // ISSCC 2026 15.6: 36 GB, 12-high, 8 channels per slice (die), 4 slices per rank → 3 SIDs. JESD270-4
      // 24Gb 12H: 16 banks per PC per die (2 groups of 8), 12 K host rows of 1 KiB = 6 K coupled 2 KiB wordlines.
      // The core die puts 4 channels above and 4 below the TSV band (channel_rows extension).
      params: { sids: 3, channels: 32, ch_per_die: 8, pch: 2, horiz_bg: 1, vert_bg: 2, banks: 8, mats: 32, mat_cols: 512, ldls_mdls: 16, subarrays: 12, mat_rows: 512, coupled_rows: 2, coupled_lsb: 0, pages_per_bgbus_mux: 2, channel_rows: 2 },
    },
    hbm4_1sid_coupled: {
      label: 'HBM4 · 1 SID · coupled rows (2 KiB wordline = 2 × 1 KiB)', tech: 'hbm4',
      // JESD270-4 Table 4 note 3: "MSB of RA is used to select half of open 2 KB page" — read as MSB
      // coupled rows: 8 K wordlines of 2 KiB per bank expose 16 K host rows of 1 KiB (RA[13:0]).
      // 32 MATs × 16 MDLs / 2 halves = 256 b per pump; the two halves share a muxed BGBUS.
      params: { sids: 1, channels: 32, ch_per_die: 8, pch: 2, horiz_bg: 1, vert_bg: 2, banks: 8, mats: 32, mat_cols: 512, ldls_mdls: 16, subarrays: 16, mat_rows: 512, coupled_rows: 2, coupled_lsb: 0, pages_per_bgbus_mux: 2 },
    },
  };

  // configs/mem/baseline/hbm3_baseline.json, using the sweep-CSV column names
  DR.BASELINE = {
    sids: 2, channels: 16, ch_per_die: 4, pch: 2, horiz_bg: 1, vert_bg: 4, banks: 4,
    subarrays: 16, mats: 32, repair: 0, mat_rows: 512, mat_cols: 512, brvsa: 0,
    ldls_mdls: 8, mdl_over_mat: 1, csl_mdl_over_mat: 1, csl_mdl_shared_layer: 1,
    ha_layout: 0, ha_double_ldls: 0, subchannels: 1, salp_groups: 1, salp_all: 0, atom_size: 256,
    pages_per_bgbus_mux: 1, mdl_bgbus_sd: 1, bgbuses_per_gbus: 2, bgbus_gbus_sd: 1, gbus_tsv_sd: 1, tsv_dq_sd: 8,
    _tck: 2, _tcl: 28,
    // extensions beyond DreamRAM (tools/export_floorplan.py implements the same in an Hbm subclass)
    coupled_rows: 1, coupled_lsb: 0, edge_pairing: 0, ioctl_h: 0, channel_rows: 1, tccd_bgbus: 0,
  };

  // Parameter UI: groups follow DreamRAM's input levels; `values` are the hbm_sweep_default.json ranges.
  DR.PARAMS = [
    { group: 'Stack / inter-bank', items: [
      ['sids', 'SIDs (ranks)', [1, 2]],
      ['channels', 'Channels', [8, 12, 16, 24, 32, 48, 64]],
      ['ch_per_die', 'Channels / die', [2, 3, 4, 6, 8]],
      ['pch', 'Pseudo-channels', [2]],
      ['horiz_bg', 'Horizontal bank groups', [1, 2]],
      ['vert_bg', 'Vertical bank groups', [2, 4]],
      ['banks', 'Banks / bank group', [2, 4, 8]],
    ] },
    { group: 'Bank / subarray', items: [
      ['subarrays', 'Subarrays / bank', [8, 12, 16, 24]],
      ['mats', 'MATs / subarray', [16, 32]],
      ['salp_groups', 'SALP groups', [1, 2, 4]],
      ['salp_all', 'SALP-all', [0, 1]],
      ['ha_layout', 'Half-page layout', [0, 1]],
      ['ha_double_ldls', 'Half-page full (2× LDLs)', [0, 1]],
      ['subchannels', 'Subchannels', [1, 2, 4, 8]],
    ] },
    { group: 'MAT', items: [
      ['mat_rows', 'Wordlines / MAT', [256, 512, 1024]],
      ['mat_cols', 'Bitlines / MAT', [256, 512, 1024]],
      ['brvsa', 'Sense amp', [[0, 'BLSA'], [1, 'BRVSA / OCSA']]],
      ['ldls_mdls', 'MDLs (LDLs) / MAT', [8, 16, 32, 64]],
      ['mdlcsl', 'MDL / CSL routing', [[0, '0 · MDL over SWD, CSL over MAT'], [1, '1 · DLOMAT (MDL over MAT, CSL over SWD)'], [3, '3 · MDL + CSL both over MAT']]],
      ['csl_mdl_shared_layer', 'CSL/MDL metal layer', [[1, 'Shared layer'], [0, 'Separate layers']]],
    ] },
    { group: 'Extensions (not in DreamRAM)', items: [
      ['coupled_rows', 'Host rows per wordline', [[1, '1 · off'], [2, '2 · coupled rows'], [4, '4']]],
      ['coupled_lsb', 'Coupled-row address bit', [[0, 'MSB (Row[i] ↔ Row[i+N/2], DDR4)'], [1, 'LSB (adjacent rows, LPDDR4)']]],
      ['edge_pairing', 'Open-BL edge subarrays', [[0, 'Dummy half-subarrays (DreamRAM)'], [1, 'Paired edge subarrays (store data)']]],
      ['channel_rows', 'Channel rows per die', [[1, '1 · each channel spans both halves (DreamRAM)'], [2, '2 · half the channels above, half below the TSVs']]],
      ['tccd_bgbus', 'tCCD_L from', [[0, 'Bank column path only (DreamRAM)'], [1, 'Slower of bank path and BG-BUS window']]],
      ['ioctl_h', 'I/O-control height / BG', [[0, 'DreamRAM OD-ECC (1% of baseline bank)'], [25, '25 µm'], [50, '50 µm'], [100, '100 µm'], [150, '150 µm']]],
    ] },
    { group: 'Data bus', items: [
      ['atom_size', 'Atom size (bits)', [256]],
      ['pages_per_bgbus_mux', 'Pages / BGBUS mux', [1, 2]],
      ['bgbuses_per_gbus', 'BGBUSes / GBUS', [2]],
      ['tsv_dq_sd', 'TSV→DQ SerDes', [8]],
    ] },
  ];

  const ceil = Math.ceil, log2 = Math.log2, pow = Math.pow;

  function techScaled(t) {
    const s = pow(t.f / t._f, t.logic_conf); // Tech.scaled_* use logic_scale_conf
    const sc = pow(t.f / t._f, t.c_conf); // Tech.scale_cap
    return { rowdec_w: t._rowdec_w * s, coldec_h: t._coldec_h * s, blsa_ref: t._blsa_h * s, swd_w: t._swd_w * s, capScale: sc };
  }

  // Hbm.bank_dims (+ blsa_height, swd_width, decoder_dims)
  function bankGeom(p, t) {
    const ts = techScaled(t);
    let blsa_h = ts.blsa_ref;
    if (p.brvsa) blsa_h *= t.brvsa_h_ratio;
    if (p.mdl_over_mat) blsa_h = Math.max(ts.blsa_ref * t.mdl_over_mat_h_ratio, blsa_h + (p.ldls_mdls - 8) * t.pitch_ldl);
    else blsa_h = Math.max(ts.blsa_ref, blsa_h + (p.ldls_mdls - 8) * t.pitch_ldl);

    const ecc_prop = t.md_ecc + t.od_ecc;
    const ecc_mats = ceil(ecc_prop * p.mats);
    const swd_count = p.mats + ecc_mats + 1 + (p.subchannels - 1);
    const rows = p.subarrays + (p.salp_groups - 1) + p.repair + 1;
    const mat_w = p.mat_cols * t.iso_cols * t.pitch_bl;
    const mat_h = p.mat_rows * t.iso_rows * t.pitch_wl;
    const data_w = p.mats * mat_w;
    const ecc_w = p.mats * p.mat_cols * ecc_prop * t.iso_cols * t.pitch_bl;
    const cells_w = data_w + ecc_w;
    const cells_h = rows * mat_h;
    const swd_total = ts.swd_w * swd_count;
    const blsa_total = blsa_h * rows;
    return {
      rowdec_w: ts.rowdec_w, coldec_h: ts.coldec_h, swd_w: ts.swd_w, blsa_h, ecc_mats, swd_count, rows,
      mat_w, mat_h, data_w, ecc_w, cells_w, cells_h, swd_total, blsa_total,
      bank_x: ts.rowdec_w + cells_w + swd_total,
      bank_y: ts.coldec_h + cells_h + blsa_total,
      cell_area_bank: cells_w * cells_h,
      // Hbm.dummy_subarray_height; paired edge subarrays hold data instead (extension)
      dummy_y: p.edge_pairing ? 0 : (t.open_bl ? 2 : 0) * 0.5 * mat_h,
    };
  }

  function pages(p) {
    const ind_row_pages = pow(2, p.ha_layout) * p.subchannels; // Hbm.ind_row_pages
    // Hbm.ind_pages. Coupled rows split the column side C ways (a READ reaches only the addressed
    // logical row's MATs) while the ACT still opens the whole wordline (ind_row_pages unchanged).
    const ind_pages = pow(2, p.ha_layout - p.ha_double_ldls) * p.subchannels * p.coupled_rows;
    const page_bits = p.mats * p.mat_cols / ind_pages; // Hbm.page_act_size (host-visible page)
    const mdl_width_per_page = p.mats * p.ldls_mdls / ind_pages;
    const bgbus_width = mdl_width_per_page / p.mdl_bgbus_sd;
    const gbus_width = bgbus_width / p.bgbus_gbus_sd;
    return { ind_row_pages, ind_pages, page_bits, phys_row_bits: p.mats * p.mat_cols, atoms_per_page: page_bits / p.atom_size, min_atom: mdl_width_per_page, mdl_width_per_page, bgbus_width, gbus_width };
  }

  // Hbm.ch_cmd_bits
  function cmdBits(p, pg) {
    const sid_bits = Math.max(2, ceil(log2(Math.max(p.sids, 2))));
    const ba_bits = ceil(log2(p.vert_bg * p.horiz_bg * p.banks));
    const pc_bits = ceil(log2(p.pch));
    const ra_bits = ceil(log2(p.subarrays)) + ceil(log2(p.mat_rows)) + log2(pg.ind_row_pages) + log2(p.coupled_rows);
    const ca_bits = ceil(log2(pg.atoms_per_page));
    const row = Math.max(3 + pc_bits + sid_bits + ba_bits, 2 + ceil(ra_bits / 2));
    const col = ceil((4 + pc_bits + sid_bits + ba_bits + ca_bits) / 2);
    return { row, col };
  }

  // Hbm.csl_mdl_pitch_ratios
  function pitchRatios(p, t, bg) {
    const B = DR.BASELINE;
    const _shared = B.mat_cols / (B.ldls_mdls * 2 + B.mat_cols / B.ldls_mdls);
    let mdl, csl, mdl_r, csl_r, csl_count = p.mat_cols / p.ldls_mdls;
    if (!p.csl_mdl_over_mat) {
      if (p.mdl_over_mat) {
        mdl = p.mat_cols / (p.ldls_mdls * 2);
        csl_count = 2 * mdl;
        csl = (bg.swd_w / t.pitch_bl) / csl_count;
      } else {
        mdl = (bg.swd_w / t.pitch_bl) / (p.ldls_mdls * 2);
        csl = p.ldls_mdls;
      }
    } else if (p.csl_mdl_shared_layer) {
      mdl = csl = p.mat_cols / (p.ldls_mdls * 2 + p.mat_cols / p.ldls_mdls);
    } else {
      mdl = p.mat_cols / (p.ldls_mdls * 2);
      csl = p.ldls_mdls;
    }
    mdl_r = mdl / _shared;
    csl_r = csl / _shared;
    if (p.mdl_over_mat && (mdl < t.mdl_to_bl_min || mdl_r < 1)) mdl_r = 0.01;
    return { csl_ratio: csl_r, mdl_ratio: mdl_r, mdl_to_bl: mdl, csl_to_bl: csl, csl_count };
  }

  function stackGeom(p, t, bg, ref) {
    const pg = pages(p);
    const center_w = 2 * bg.rowdec_w; // Hbm.bankdie_dims: "center_height = 2.0*row_dec_width"
    // Hbm.od_ecc_height (scales with the *baseline* bank_y). The viewer draws it as each bank group's
    // I/O control block; the ioctl_h extension overrides its height.
    const od_ecc_h = p.ioctl_h > 0 ? p.ioctl_h : 0.01 * ref.bank_y;
    const mbus_h = 0.55 * ref.bank_y; // Hbm.mbus_peri_height
    // Hbm.bankdie_dims. channel_rows = 2 (extension) puts half the channels on each side of the TSVs,
    // each with all of its bank groups, so the die is half as wide and its bank area twice as tall.
    const rows = p.channel_rows;
    const cols = p.ch_per_die * p.pch * p.horiz_bg / rows; // bank columns across the die
    const die_w = cols * (bg.bank_x + center_w);
    const non_tsv_y = rows * p.vert_bg * (p.banks * (bg.bank_y + bg.dummy_y) + od_ecc_h) + mbus_h;

    // Hbm.calc_stack_dims
    const cb = cmdBits(p, pg);
    // TSVs per channel by purpose, term by term as in Hbm.calc_stack_dims. Every channel of the stack
    // passes through every die, so each die's TSV array holds channels × these counts.
    const tsv_cmd = [
      { key: 'ra', label: 'Row command / address', note: `4 × ${cb.row} row bits (RA_E/O_F/S)`, perCh: 4 * cb.row },
      { key: 'ca', label: 'Column command / address', note: `4 × ${cb.col} column bits (CA_E/O_F/S)`, perCh: 4 * cb.col },
      { key: 'ck', label: 'Address clocks', note: '0/90/180/270° phases', perCh: 4 },
      { key: 'cke', label: 'Clock enable', note: 'CKE', perCh: 1 },
    ];
    const tsv_data = [
      // coupled rows share one muxed column datapath, so data TSVs follow the logical row
      { key: 'dq', label: 'Data (MDL bits)', note: `${p.ldls_mdls} MDLs × ${p.mats} MATs${p.coupled_rows > 1 ? ` / ${p.coupled_rows} coupled` : ''}`, perCh: p.ldls_mdls * p.mats / p.coupled_rows },
      { key: 'ecc', label: 'MD-ECC', note: 'DreamRAM counts 1 / md_ecc = 16', perCh: 1 / t.md_ecc },
      { key: 'dbi', label: 'DBI', note: `(${t.dbi} − 1) × ${pg.bgbus_width} BGBUS bits`, perCh: (t.dbi - 1) * pg.bgbus_width },
      { key: 'sev', label: 'SEV + DQ flags', note: 'fixed 16', perCh: 16 },
      { key: 'wck', label: 'WCK phases', note: 'fixed 8', perCh: 8 },
    ];
    const sum = (l) => l.reduce((a, q) => a + q.perCh, 0);
    const cmd_tsv_count = p.channels * sum(tsv_cmd);
    const data_per_ch = sum(tsv_data);
    const data_tsv_count = p.channels * data_per_ch;
    const pitch = Math.max(t.ubump_pitch, t.tsv_pitch);
    const h_per_tsv = (pitch * pitch) / (die_w - 2 * t.tsv_koz);
    const cmd_tsv_y = cmd_tsv_count * h_per_tsv;
    const data_tsv_y = data_tsv_count * h_per_tsv;
    const other_tsv_y = 0.2 * (cmd_tsv_y + data_tsv_y) + 2 * t.tsv_koz;
    const dies = p.sids * p.channels / p.ch_per_die;
    const die_h = non_tsv_y + cmd_tsv_y + data_tsv_y + other_tsv_y;
    return {
      center_w, od_ecc_h, mbus_h, cols, rows, die_w, die_h, non_tsv_y, cmd_tsv_y, data_tsv_y, other_tsv_y,
      tsv_h: cmd_tsv_y + data_tsv_y + other_tsv_y, cmd_tsv_count, data_tsv_count, data_per_ch,
      cmd_per_ch: cmd_tsv_count / p.channels, tsv_grid_pitch: pitch, dies, cmd: cb, pg, tsv_cmd, tsv_data,
      // power TSVs: Hbm.calc_stack_dims adds 20% of the signal-TSV area; the rest of other_tsv_y is keep-out
      power_tsv_count: 0.2 * (cmd_tsv_count + data_tsv_count),
    };
  }

  function wireCounts(p, t, pg) {
    const ecc = 1 + t.md_ecc + t.od_ecc, md = 1 + t.md_ecc;
    const dq_count = ceil(md * pg.gbus_width * p.subchannels / (p.gbus_tsv_sd * p.tsv_dq_sd)) * p.pch * p.channels;
    return {
      lwl: p.mats * ecc / pg.ind_row_pages,
      csl: ceil(p.mats * ecc / pg.ind_pages),
      mdl: ceil(pg.mdl_width_per_page * ecc),
      bgbus: ceil(pg.bgbus_width * md),
      gbus: ceil(pg.gbus_width * md),
      tsv: ceil(pg.gbus_width * md / p.gbus_tsv_sd),
      dq_count,
    };
  }

  // Hbm.core_tck / bandwidth / trcd / trp / tcl
  function timing(p, t, bg, sg, wc, pr, ref) {
    const B = DR.BASELINE, ts = techScaled(t);
    const mat_width = bg.swd_w + p.mat_cols * t.iso_cols * t.pitch_bl;
    const _mat_width = ts.swd_w + B.mat_cols * t.iso_cols * t.pitch_bl;
    const rc = (r, q) => (1 - q) + q / r;
    const res = t.pitch_bl / t.pitch_wl;
    const c_csl = t._c_csl * ts.capScale, c_mdl = t._c_mdl * ts.capScale, c_ldl = t._c_ldl * ts.capScale;
    const denom = (c_csl + 2 * c_mdl) * ref.bank_y + res * c_ldl * _mat_width;
    const numer = (rc(pr.csl_ratio, t.c_within_csl_mdl) * c_csl + 2 * rc(pr.mdl_ratio, t.c_within_csl_mdl) * c_mdl) * bg.bank_y + res * c_ldl * mat_width;
    // Shared BG-BUS window (tccd_bgbus extension): a repeated wire, delay linear in DreamRAM's bus length
    // (Hbm.wire_lengths 'bgbus+gbus' = non_tsv_y / 2) times its pitch-dependent capacitance (as in tCL),
    // calibrated so the baseline bank group's window equals the baseline tCK
    const crat = (r, q) => (1 - q) * r + q / r;
    const pitch = bg.bank_x / (wc.bgbus * sg.pg.ind_pages / (p.pages_per_bgbus_mux * p.mdl_bgbus_sd) * p.vert_bg / 2 * pow(t.dbi, t.dbi_bgbus));
    const _pitch = ref.bank_x / (ref.n_bgbus / (B.pages_per_bgbus_mux * B.mdl_bgbus_sd) * B.vert_bg / 2 * pow(t.dbi, t.dbi_bgbus));
    const bgr = pitch / _pitch;
    const tck_bank = 1 + (B._tck - 1) * numer / denom; // Hbm.core_tck: CSL + MDL over the bank, LDL over a MAT
    const tck_bgbus = 1 + (B._tck - 1) * (sg.non_tsv_y / 2) * crat(bgr, t.c_within_sparse) / (ref.non_tsv_y / 2);
    const core_tck = p.tccd_bgbus ? Math.max(tck_bank, tck_bgbus) : tck_bank;
    const dq_speed = p.mdl_bgbus_sd * p.bgbus_gbus_sd * p.gbus_tsv_sd * p.tsv_dq_sd * p.bgbuses_per_gbus;
    const bw = wc.dq_count * dq_speed / (core_tck * (1 + t.md_ecc) * 8);

    const bl = t._c_bl_per_cell * p.mat_rows * t.iso_rows, _bl = t._c_bl_per_cell * t.mat_rows_ref * t.iso_rows;
    const full = (t._c_cell + bl + t._c_blsa) / (t._c_cell + _bl + t._c_blsa);
    const tsig = t._trcd_signal * bg.bank_x / ref.bank_x;
    let trcd = tsig + (t._trcd - t._trcd_signal) * full;
    if (p.brvsa) {
      const q = t.brvsa_cs_prop;
      trcd = tsig + (t._trcd_brvsa - t._trcd_signal) * (q * (t._c_cell + bl) / (t._c_cell + _bl) + (1 - q) * full);
    }
    const trp = tsig + (t._trcd - t._trcd_signal) * full;

    const tsv_c = t._c_tsv * (t.tsv_pitch / t._tsv_pitch) * (t.tsv_height / t._tsv_height) + t._c_load;
    const rise = -Math.log(1 - 0.8);
    const _dies = B.sids * B.channels / B.ch_per_die;
    const _t_die_y = (B._tcl - 2 * _dies * rise * t._r_load * tsv_c / 1000) / 2;
    const tcl = (crat(bgr * (B.bgbus_gbus_sd * B.gbus_tsv_sd) / (p.bgbus_gbus_sd * p.gbus_tsv_sd), t.c_within_sparse) + crat(bgr, t.c_within_sparse))
      * _t_die_y * (sg.die_h - bg.bank_y) / (ref.die_h - ref.bank_y) + 2 * sg.dies * rise * t._r_load * tsv_c / 1000;
    // Hbm.tccdl / tccds: 4 and 2 peripheral clocks (core_tck / 4) per pump. Same-bank-group column
    // commands wait tCCD_L for the group's shared I/O control / BG-BUS path, so one bank group delivers
    // one atom per tCCD_L; the pseudo-channel's peak (which includes bgbuses_per_gbus) needs groups
    // alternating every tCCD_S.
    const pumps = p.atom_size / sg.pg.min_atom;
    const tccdl = core_tck * pumps, tccds = core_tck / 2 * pumps;
    const bg_rate = p.atom_size / 8 / tccdl; // GB/s of data per bank group
    const pc_rate = bw / (p.channels * p.pch); // GB/s per pseudo-channel at peak
    return {
      core_tck, tck_bank, tck_bgbus, limiter: tck_bgbus > tck_bank ? 'BG-BUS window' : 'bank column path',
      bw, trcd, trp, tcl, latency: tcl + trcd + trp, dq_rate: dq_speed / core_tck,
      tccdl, tccds, bg_rate, pc_rate, bgs_needed: pc_rate / bg_rate, bgs_per_pc: p.horiz_bg * p.vert_bg,
    };
  }

  // dreamram.simulate() pre-filters and die-size filters, in the same order and with the same codes
  function filters(p, t, sg, pg, pr) {
    const out = [];
    const add = (code, msg) => out.push({ code, msg });
    if (p.channels % p.ch_per_die !== 0) add(1, 'channels must be a multiple of channels/die');
    if (p.ch_per_die % p.channel_rows !== 0) add(1, 'channels/die must be a multiple of the channel rows (extension)');
    if (p.ha_double_ldls > p.ha_layout) add(2, 'half-page full (2× LDLs) requires the half-page layout');
    if (p.salp_all === 1 && p.salp_groups !== 1) add(3, 'SALP-all and SALP groups cannot be combined');
    if (p.csl_mdl_over_mat && !p.mdl_over_mat) add(4, 'CSL over MAT without MDL over MAT is not a valid routing config');
    if (!p.csl_mdl_shared_layer && !p.csl_mdl_over_mat) add(5, 'separate CSL/MDL layers require both over the MAT (config 3)');
    const min_atom = p.mats * p.ldls_mdls / (pow(2, p.ha_layout - p.ha_double_ldls) * p.subchannels * p.coupled_rows);
    if (min_atom > p.atom_size) add(6, `minimum atom (${min_atom} b per pump) exceeds the atom size`);
    else if (min_atom !== Math.floor(min_atom)) add(7, 'pages split MATs (non-integer bits per pump)');
    else if (p.atom_size / min_atom !== Math.floor(p.atom_size / min_atom)) add(8, 'atom size is not a whole number of pumps');
    if (p.mats < pow(2, p.ha_layout - p.ha_double_ldls) * p.subchannels * p.coupled_rows) add(9, 'more independent pages than MATs');
    if (p.atom_size / min_atom > 8) add(10, `${p.atom_size / min_atom} pumps per atom (limit 8)`);
    if (sg.die_w >= t.max_die_um || sg.die_h >= t.max_die_um) add(11, `die is ${(sg.die_w / 1000).toFixed(2)} × ${(sg.die_h / 1000).toFixed(2)} mm (limit 13 mm)`);
    if (sg.dies > t.max_stack_dies) add(12, `${sg.dies} core dies (limit 16)`);
    if (pg.atoms_per_page < 1 || pg.atoms_per_page !== Math.floor(pg.atoms_per_page)) add(13, 'page is not a whole number of atoms');
    if (pg.ind_pages < p.pages_per_bgbus_mux) add(14, 'fewer independent pages than pages per BGBUS mux');
    if (pr.csl_ratio < 0.5 || pr.mdl_ratio < 0.5) add(15, `CSL/MDL pitch too tight (CSL ${pr.csl_ratio.toFixed(2)}×, MDL ${pr.mdl_ratio.toFixed(2)}× baseline)`);
    return out;
  }

  DR.normalize = function (p) {
    const q = Object.assign({}, DR.BASELINE, p);
    if (q.mdlcsl !== undefined) {
      q.mdl_over_mat = q.mdlcsl & 1;
      q.csl_mdl_over_mat = q.mdlcsl >> 1;
    }
    q.mdlcsl = (q.csl_mdl_over_mat << 1) | q.mdl_over_mat;
    return q;
  };

  DR.compute = function (params, techKey) {
    const t = DR.TECH_PRESETS[techKey] || DR.TECH_PRESETS['16nm'];
    const p = DR.normalize(params);
    const B = DR.normalize({});
    // Baseline references (dreamram.main computes these from the baseline design before the sweep)
    const bb = bankGeom(B, t);
    const ref0 = { bank_x: bb.bank_x, bank_y: bb.bank_y };
    const bs = stackGeom(B, t, bb, ref0);
    const ref = Object.assign(ref0, { die_h: bs.die_h, non_tsv_y: bs.non_tsv_y, n_bgbus: wireCounts(B, t, bs.pg).bgbus });

    const bg = bankGeom(p, t);
    const sg = stackGeom(p, t, bg, ref);
    const pg = sg.pg;
    const wc = wireCounts(p, t, pg);
    const pr = pitchRatios(p, t, bg);
    const problems = filters(p, t, sg, pg, pr);
    let tm = null;
    try { tm = timing(p, t, bg, sg, wc, pr, ref); } catch (e) { tm = null; }

    const banksPerDie = p.ch_per_die * p.pch * p.horiz_bg * p.vert_bg * p.banks;
    const dieArea = sg.die_w * sg.die_h;
    const capacity = p.sids * p.channels * p.pch * p.vert_bg * p.horiz_bg * p.banks * p.subarrays * p.mat_rows * p.mats * p.mat_cols / pow(2, 33);
    return {
      p, t, techKey, bank: bg, stack: sg, pages: pg, wires: wc, pitch: pr, timing: tm, problems, ref,
      banksPerDie,
      capacity,
      cellEff: banksPerDie * bg.cell_area_bank / dieArea, // Hbm.cell_efficiency
      totalArea: (sg.dies + 1) * dieArea / 1e6, // Hbm.total_area
      pumps: p.atom_size / pg.min_atom,
    };
  };

  // Die-area breakdown; the categories tile the die exactly.
  DR.areaBreakdown = function (m) {
    const p = m.p, b = m.bank, s = m.stack, n = m.banksPerDie;
    const dataRowsCells = p.subarrays * b.mat_h;
    const extraRowsCells = b.cells_h - dataRowsCells;
    const parts = [
      ['cells', 'Data cells', n * b.data_w * dataRowsCells],
      ['ecc', 'ECC cells', n * b.ecc_w * dataRowsCells],
      ['extrarow', 'Extra / SALP rows', n * b.cells_w * extraRowsCells],
      ['blsa', 'BLSA', n * b.cells_w * b.blsa_total],
      ['swd', 'SWD + conj.', n * b.swd_total * (b.cells_h + b.blsa_total)],
      ['rowdec', 'Row dec', n * b.rowdec_w * (b.cells_h + b.blsa_total)],
      ['coldec', 'Col dec + corner', n * b.bank_x * b.coldec_h],
      ['dummy', 'Dummy subarrays', n * b.bank_x * b.dummy_y],
      ['ctrl', 'Control stripes', s.cols * s.center_w * (s.non_tsv_y - s.mbus_h)],
      ['ioctl', 'I/O control (OD-ECC)', s.cols * s.rows * b.bank_x * p.vert_bg * s.od_ecc_h],
      ['mbus', 'GBUS CTRL / periphery', s.die_w * s.mbus_h],
      ['tsv', 'TSV region', s.die_w * s.tsv_h],
    ];
    const total = s.die_w * s.die_h;
    return parts.map(([key, label, a]) => ({ key, label, area: a, frac: a / total }));
  };

  // Compare this port against a tools/export_floorplan.py export (same params).
  DR.compareExport = function (m, ex) {
    const g = ex.geom, rows = [];
    const add = (label, js, py) => { if (py !== undefined && py !== null) rows.push({ label, js, py, rel: Math.abs(js - py) / Math.max(Math.abs(py), 1e-12) }); };
    add('bank_x', m.bank.bank_x, g.bank_x);
    add('bank_y', m.bank.bank_y, g.bank_y);
    add('BLSA height', m.bank.blsa_h, g.blsa_h);
    add('die width', m.stack.die_w, g.die_w);
    add('die height', m.stack.die_h, g.die_h);
    add('cmd TSV height', m.stack.cmd_tsv_y, g.cmd_tsv_y);
    add('data TSV height', m.stack.data_tsv_y, g.data_tsv_y);
    add('cell efficiency', m.cellEff, g.cell_eff);
    add('total area', m.totalArea, ex.derived && ex.derived.total_area_mm2);
    if (m.timing && ex.metrics) {
      add('bandwidth', m.timing.bw, ex.metrics.bw_gbytes);
      add('tCL', m.timing.tcl, ex.metrics.tcl);
      add('tRCD', m.timing.trcd, ex.metrics.trcd);
      add('tRP', m.timing.trp, ex.metrics.trp);
      add('tCCD_L', m.timing.tccdl, ex.metrics.tccdl);
      add('bank-path stage', m.timing.tck_bank, ex.derived && ex.derived.tck_bank_stage);
      add('BG-BUS stage', m.timing.tck_bgbus, ex.derived && ex.derived.tck_bgbus_stage);
    }
    return rows;
  };
})();
