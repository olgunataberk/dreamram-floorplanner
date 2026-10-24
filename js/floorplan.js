// Builds the die floorplan hierarchy (die → channel → pseudo-channel → bank group → bank →
// subarray → MAT) from a DR.compute() result. Coordinates are in µm, origin at the die's top-left.
// Children are generated lazily, so a die with ~100k MATs only materialises what is on screen.
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});

  // type → { label, layer (toggle key), level (navigable hierarchy level) }
  DR.TYPES = {
    stack: { label: 'Stack' },
    die: { label: 'Core die', level: true },
    channel: { label: 'Channel', layer: 'channel', level: true },
    pch: { label: 'Pseudo-channel', layer: 'pch', level: true },
    bg: { label: 'Bank group', layer: 'bg', level: true },
    bank: { label: 'Bank', layer: 'bank', level: true },
    subarray: { label: 'Subarray', layer: 'subarray', level: true },
    salpbuf: { label: 'SALP buffer subarray', layer: 'salpbuf', level: true },
    extrarow: { label: 'Extra subarray row (+1)', layer: 'extrarow', level: true },
    mat: { label: 'MAT', layer: 'mat', level: true },
    eccmat: { label: 'ECC MAT', layer: 'eccmat', level: true },
    rhcells: { label: 'PRAC counter cells', layer: 'rhcells' },
    blsa: { label: 'BLSA stripe', layer: 'blsa' },
    swd: { label: 'Sub-wordline driver (LWD) stripe', layer: 'swd' },
    conj: { label: 'SWD/BLSA conjunction', layer: 'swd' },
    rowdec: { label: 'Row decoder', layer: 'rowdec' },
    coldec: { label: 'Column decoder', layer: 'coldec' },
    corner: { label: 'Decoder corner', layer: 'coldec' },
    dummy: { label: 'Dummy half-subarray (open BL edge)', layer: 'dummy' },
    ioctl: { label: 'I/O control (bank group)', layer: 'ioctl' },
    ctrl: { label: 'Bank control stripe', layer: 'ctrl' },
    mbus: { label: 'GBUS CTRL / periphery', layer: 'mbus' },
    tsvregion: { label: 'TSV region', layer: 'tsvother', level: true },
    tsvcmd: { label: 'AWORD (command) TSV block', layer: 'tsvcmd' },
    tsvdata: { label: 'DWORD (data) TSV block', layer: 'tsvdata' },
    tsvother: { label: 'Power TSVs / keep-out', layer: 'tsvother' },
  };

  const chName = (i) => 'CH' + i;

  function node(type, name, x, y, w, h, extra) {
    return Object.assign({ type, name, x, y, w, h, kids: null, gen: null, parent: null }, extra);
  }
  function setKids(n, kids) {
    for (const k of kids) k.parent = n;
    n.kids = kids;
    return kids;
  }
  DR.children = function (n) {
    if (n.kids) return n.kids;
    if (n.gen) return setKids(n, n.gen(n));
    return (n.kids = []);
  };

  // Build one core die. dieIdx is the die's index in the stack (0 = bottom core die).
  DR.buildDie = function (m, dieIdx) {
    const p = m.p, b = m.bank, s = m.stack;
    const diesPerSid = p.channels / p.ch_per_die;
    const sid = Math.floor(dieIdx / diesPerSid);
    const chBase = (dieIdx % diesPerSid) * p.ch_per_die;
    const colW = b.bank_x + s.center_w;
    const slotH = b.bank_y + b.dummy_y;
    const bgH = p.banks * slotH + s.od_ecc_h;
    // DreamRAM splits each pseudo-channel's bank groups across both sides of the TSVs; with
    // channel_rows = 2 every channel keeps all of its bank groups on its own side
    const rows = s.rows, slots = p.ch_per_die / rows;
    const vTop = rows === 2 ? p.vert_bg : Math.ceil(p.vert_bg / 2), vBot = rows === 2 ? p.vert_bg : p.vert_bg - vTop;
    const topH = vTop * bgH, botH = vBot * bgH;
    const mbusTopY = topH, tsvY = topH + s.mbus_h / 2, mbusBotY = tsvY + s.tsv_h, botY = mbusBotY + s.mbus_h / 2;

    const die = node('die', `Die ${dieIdx} · SID ${sid} · ${chName(chBase)}–${chName(chBase + p.ch_per_die - 1)}`, 0, 0, s.die_w, s.die_h,
      { dieIdx, sid, chBase, m });
    die.layout = { colW, slotH, bgH, vTop, vBot, topH, botH, tsvY, mbusTopY, mbusBotY, botY, rows, slots };

    die.tsv = DR.tsvBlocks(m, die);

    die.gen = () => {
      const kids = [];
      const tsv = node('tsvregion', 'TSV region', 0, tsvY, s.die_w, s.tsv_h, { die });
      tsv.gen = () => {
        const o2 = s.other_tsv_y / 2;
        const r = [];
        const koz = m.t.tsv_koz, pwr = s.power_tsv_count / 2;
        const power = (extra) => Object.assign({ tsvKind: 'power', seq: [{ ch: null, parts: [{ key: 'pwr', label: 'Power / ground', n: pwr }] }], count: pwr, die }, extra);
        // keep-out bands sit on the outer edges of the TSV region; power TSVs fill the rest
        r.push(node('tsvother', `Power TSVs (${Math.round(pwr)}) + keep-out`, 0, tsvY, s.die_w, o2, power({ kozTop: koz })));
        for (const blk of die.tsv.blocks) r.push(node(blk.type, blk.name, blk.x, blk.y, blk.w, blk.h, Object.assign({ die }, blk)));
        r.push(node('tsvother', `Power TSVs (${Math.round(pwr)}) + keep-out`, 0, tsvY + o2 + die.tsv.bandH, s.die_w, o2, power({ kozBot: koz })));
        return r;
      };
      kids.push(tsv);
      // GBUS CTRL: one block per bank column on each side of the TSV region (Ryu et al., JSSC'23, Fig. 3).
      // Together they are DreamRAM's MBUS / periphery height (0.55 × baseline bank_y), split in half.
      for (let col = 0; col < s.cols; col++) {
        const c = Math.floor(col / (p.pch * p.horiz_bg)), q = Math.floor((col % (p.pch * p.horiz_bg)) / p.horiz_bg);
        const cBot = rows === 2 ? c + slots : c;
        kids.push(node('mbus', `GBUS CTRL · ${chName(chBase + c)} PC${q} (top)`, col * colW, mbusTopY, colW, s.mbus_h / 2, { die, half: 'top', col }));
        kids.push(node('mbus', `GBUS CTRL · ${chName(chBase + cBot)} PC${q} (bottom)`, col * colW, mbusBotY, colW, s.mbus_h / 2, { die, half: 'bot', col }));
      }
      for (let c = 0; c < p.ch_per_die; c++) {
        const chW = p.pch * p.horiz_bg * colW;
        const side = rows === 2 ? (c < slots ? 'top' : 'bot') : null;
        const cy = side === 'bot' ? botY : 0, chH = side === 'top' ? topH : side === 'bot' ? botH : s.die_h;
        const ch = node('channel', chName(chBase + c), (c % slots) * chW, cy, chW, chH, { chIdx: chBase + c, die, side });
        ch.gen = () => {
          const pcs = [];
          for (let q = 0; q < p.pch; q++) {
            const pcW = p.horiz_bg * colW;
            const pc = node('pch', `${chName(chBase + c)} · PC${q}`, ch.x + q * pcW, ch.y, pcW, ch.h, { die, ch, pcIdx: q });
            pc.gen = () => buildPch(m, die, pc, c, q);
            pcs.push(pc);
          }
          return pcs;
        };
        kids.push(ch);
      }
      return kids;
    };
    return die;
  };

  function buildPch(m, die, pc, c, q) {
    const p = m.p, b = m.bank, s = m.stack, L = die.layout;
    const kids = [];
    const side = pc.ch.side; // 'top' / 'bot' with two channel rows, null when the channel spans both
    for (let h = 0; h < p.horiz_bg; h++) {
      const col = ((c % L.slots) * p.pch + q) * p.horiz_bg + h; // bank column across the die
      const mirror = col % 2 === 0; // pairs of columns face each other across their control stripes
      const colX = pc.x + h * L.colW;
      const bankX = mirror ? colX : colX + s.center_w;
      const stripeX = mirror ? colX + b.bank_x : colX;
      if (L.topH > 0 && side !== 'bot') kids.push(node('ctrl', 'Bank control stripe', stripeX, 0, s.center_w, L.topH, { die }));
      if (L.botH > 0 && side !== 'top') kids.push(node('ctrl', 'Bank control stripe', stripeX, L.botY, s.center_w, L.botH, { die }));
      for (let v = 0; v < p.vert_bg; v++) {
        const top = side ? side === 'top' : v < L.vTop;
        // BG0 is farthest from the TSVs; with one channel row the bottom half continues outward from the TSVs
        const halfIdx = side || top ? v : v - L.vTop, halfN = top ? L.vTop : L.vBot;
        const y = top ? v * L.bgH : side ? L.botY + L.botH - (v + 1) * L.bgH : L.botY + halfIdx * L.bgH;
        const name = p.horiz_bg > 1 ? `BG${h}.${v}` : `BG${v}`;
        const bgn = node('bg', `${pc.name} · ${name}`, bankX, y, b.bank_x, L.bgH,
          { die, pc, bgName: name, flipX: mirror, flipY: !top, bgV: v, bgH: h, top, col, halfIdx, halfN });
        // I/O control sits mid-group: ceil(banks/2) banks on the far side, the rest toward the TSVs
        const nFar = Math.ceil(p.banks / 2), off = nFar * L.slotH;
        bgn.iocY = top ? y + off : y + L.bgH - off - s.od_ecc_h;
        bgn.gen = () => buildBg(m, die, bgn);
        kids.push(bgn);
      }
    }
    return kids;
  }

  // Bank group as in the HBM3 core die (Ryu et al., JSSC'23, Fig. 3): banks 0..k-1 from the far end,
  // the I/O control block in the middle, and each bank mirrored so its column decoder faces the I/O
  // control. I/O control holds the I/O sense amps / write drivers, the per-group OD-ECC + DBI logic and
  // the BG-BUS drivers; its height is DreamRAM's per-group OD-ECC height (or the ioctl_h extension).
  function buildBg(m, die, bgn) {
    const p = m.p, b = m.bank, s = m.stack;
    const slotH = b.bank_y + b.dummy_y;
    const nFar = Math.ceil(p.banks / 2);
    const Y = (off, h) => (bgn.flipY ? bgn.y + bgn.h - off - h : bgn.y + off); // offset from the far end
    const kids = [node('ioctl', `${bgn.bgName} I/O control`, bgn.x, bgn.iocY, b.bank_x, s.od_ecc_h, { die, bg: bgn })];
    for (let k = 0; k < p.banks; k++) {
      const near = k >= nFar;
      const off = k * slotH + (near ? s.od_ecc_h : 0);
      const bk = node('bank', `${bgn.pc.name} · ${bgn.bgName} · Bank ${k}`, bgn.x, Y(off, slotH), b.bank_x, slotH,
        // unflipped banks put the column decoder on their TSV-facing (local bottom) side
        { die, bg: bgn, bankIdx: k, near, flipX: bgn.flipX, flipY: near !== bgn.flipY });
      bk.gen = () => buildBank(m, bk);
      kids.push(bk);
    }
    return kids;
  }

  // TSV region aligned with the bank columns (Ryu et al., Fig. 3): each pseudo-channel column gets a DWORD
  // block of data TSVs under it, and the AWORD command TSVs sit in the gap between the two mirrored
  // columns (the control-stripe gap). Every die carries all channels; the channels stacked at the same
  // position as die channel c (c, c + ch_per_die, ...) share that column slice. Block widths split each
  // slice by TSV count, so the total TSV area is DreamRAM's; AWORD blocks spill past the stripe gap when
  // command TSVs need more width than the gap.
  DR.tsvBlocks = function (m, die) {
    const p = m.p, s = m.stack, b = m.bank;
    const colW = b.bank_x + s.center_w, nC = p.pch * p.horiz_bg, S = nC * colW;
    const slots = p.ch_per_die / s.rows;
    const y = die.layout.tsvY + s.other_tsv_y / 2, bandH = s.cmd_tsv_y + s.data_tsv_y;
    const nGaps = Math.max(1, Math.floor(nC / 2));
    const blocks = [], dword = [];
    const share = (parts, k) => parts.map((q) => ({ key: q.key, label: q.label, note: q.note, n: q.perCh / k }));
    for (let c = 0; c < slots; c++) {
      // channels whose columns sit at this x position: the die channel above (and, with two channel
      // rows, the one below) the TSVs, plus the channels stacked at the same positions on other dies
      const chs = [];
      for (let ch = 0; ch < p.channels; ch++) if ((ch % p.ch_per_die) % slots === c) chs.push(ch);
      const here = s.rows === 2 ? `CH${die.chBase + c} / CH${die.chBase + c + slots}` : `CH${die.chBase + c}`;
      const cmd = chs.length * s.cmd_per_ch, data = chs.length * s.data_per_ch;
      const awW = (S * cmd / (cmd + data)) / nGaps, dwW = (S - awW * nGaps) / nC;
      const chList = chs.map((ch) => 'CH' + ch).join(', ');
      let x = c * S;
      for (let j = 0; j < nC; j++) {
        const col = c * nC + j, q = Math.floor(j / p.horiz_bg);
        const seq = chs.map((ch) => ({ ch, parts: share(s.tsv_data, nC) }));
        const blk = { type: 'tsvdata', tsvKind: 'data', name: `DWORD TSVs · ${here} PC${q} column (${chList})`, x, y, w: dwW, h: bandH, seq, col, chs };
        blk.count = seq.reduce((a, g) => a + g.parts.reduce((u, z) => u + z.n, 0), 0);
        blocks.push(blk);
        dword[col] = blk;
        x += dwW;
        if (j % 2 === 0 && j + 1 < nC) {
          const aseq = chs.map((ch) => ({ ch, parts: share(s.tsv_cmd, nGaps) }));
          const ab = { type: 'tsvcmd', tsvKind: 'cmd', name: `AWORD TSVs · ${here} gap (${chList})`, x, y, w: awW, h: bandH, seq: aseq, chs };
          ab.count = aseq.reduce((a, g) => a + g.parts.reduce((u, z) => u + z.n, 0), 0);
          blocks.push(ab);
          x += awW;
        }
      }
    }
    return { blocks, dword, bandH, y };
  };

  // OD-ECC organisation of one access (Ryu et al., Sec. III-A): each active MAT delivers ldls_mdls bits;
  // 8-bit Reed-Solomon symbols are split over two codewords so that a sub-wordline driver fault, which
  // corrupts the two MATs on either side of it, costs each codeword as few symbols as possible.
  DR.eccLayout = function (m) {
    const p = m.p, b = m.bank, ip = m.pages.ind_pages;
    if (p.odecc_model) {
      // structural engine: odecc_cw codewords per 32 B over odecc_sym-bit symbols, each correcting odecc_t symbols.
      // A driver fault corrupts the two MATs beside it: 2 × ldls_mdls bits, spread over the access's codewords
      const e = DR.eccCircuit(p.odecc_sym, p.odecc_t, p.odecc_cw, m.t.md_ecc, p.atom_size);
      const dataMats = p.mats / ip, eccMats = b.ecc_mats / ip, hits = Math.ceil(2 * p.ldls_mdls / (p.odecc_sym * e.ncw));
      return { dataMats, eccMats, active: dataMats + eccMats, spm: p.ldls_mdls / p.odecc_sym, n: e.n, k: e.k, check: 2 * p.odecc_t,
        tCorr: p.odecc_t, swdSymPerCw: hits, ncw: e.ncw, sym: p.odecc_sym, structural: true, correctable: hits <= p.odecc_t };
    }
    const dataMats = p.mats / ip, eccMats = b.ecc_mats / ip;
    const active = dataMats + eccMats, spm = p.ldls_mdls / 8; // symbols per MAT per access
    const symbols = active * spm, n = symbols / 2;
    const check = (m.t.od_ecc * p.atom_size) / 8 / 2; // OD-ECC check symbols per codeword
    // a driver fault puts one symbol in each codeword when MATs carry one symbol, else spm symbols per codeword
    const tCorr = Math.floor(check / 2), swdSymPerCw = spm <= 1 ? 1 : spm;
    return { dataMats, eccMats, active, spm, symbols, n, k: n - check, check, tCorr, swdSymPerCw, correctable: swdSymPerCw <= tCorr };
  };
  // codeword of symbol s of the MAT at access position a ('A' / 'B')
  DR.codeword = (spm, a, s) => ((spm <= 1 ? a : s) % 2 ? 'B' : 'A');

  // Bank internals in a local frame (u from the row decoder, v from the top dummy, column decoder at
  // the far end), mapped to die coordinates with the bank's mirroring.
  function frame(bk) {
    return (u, v, w, h) => ({
      x: bk.flipX ? bk.x + bk.w - u - w : bk.x + u,
      y: bk.flipY ? bk.y + bk.h - v - h : bk.y + v,
      w, h,
    });
  }

  DR.subarrayRows = function (p) {
    // Row kinds in local order (far from the column decoder first). DreamRAM sizes the cell array as
    // subarrays + (salp_groups-1) buffers + repair + 1; the +1 row is drawn first.
    const rows = [{ kind: 'extrarow' }];
    const per = p.subarrays / p.salp_groups;
    let sa = 0;
    for (let g = 0; g < p.salp_groups; g++) {
      if (g > 0) rows.push({ kind: 'salpbuf', group: g });
      const n = g === p.salp_groups - 1 ? p.subarrays - sa : Math.round(per);
      for (let i = 0; i < n; i++) rows.push({ kind: 'subarray', idx: sa++, group: g });
    }
    for (let r = 0; r < p.repair; r++) rows.push({ kind: 'subarray', idx: sa++, repair: true });
    if (p.edge_pairing) {
      // Paired open-BL edges: the far edge row and the last subarray (next to the column decoder) each
      // sense only half their bitlines; ACT drives both wordlines and together they form subarray S-1.
      const last = rows.map((r) => r.kind).lastIndexOf('subarray');
      rows[0] = { kind: 'subarray', idx: rows[last].idx, edge: 'far' };
      rows[last] = Object.assign({}, rows[last], { edge: 'near' });
    }
    return rows;
  };

  // Column order across the array: SWD, MAT, SWD, MAT, ... with one extra SWD stripe at each
  // subchannel boundary (Hbm.bank_dims: swd_count = mats + ecc_mats + 1 + (subchannels - 1)).
  DR.matColumns = function (m) {
    const p = m.p, b = m.bank, t = m.t;
    const cols = [];
    const perSc = p.mats / p.subchannels;
    const perPage = p.mats / m.pages.ind_row_pages;
    const perHalf = perPage / p.coupled_rows; // MATs holding one of the coupled host rows
    const eccW = b.ecc_mats ? b.ecc_w / b.ecc_mats : 0;
    const mdMats = Math.round(p.mats * t.md_ecc);
    let u = 0;
    const swd = () => { cols.push({ kind: 'swd', u, w: b.swd_w }); u += b.swd_w; };
    swd();
    const g = p.mats / m.pages.ind_pages, ge = b.ecc_mats / m.pages.ind_pages; // MATs per column access
    for (let i = 0; i < p.mats; i++) {
      if (i > 0 && p.subchannels > 1 && i % perSc === 0) swd();
      cols.push({ kind: 'mat', u, w: b.mat_w, idx: i, page: Math.floor(i / perPage), sc: Math.floor(i / perSc), cpl: Math.floor((i % perPage) / perHalf), acc: i % g, grp: Math.floor(i / g) });
      u += b.mat_w;
      swd();
    }
    for (let e = 0; e < b.ecc_mats; e++) {
      cols.push({ kind: 'eccmat', u, w: eccW, idx: e, ecc: e < mdMats ? 'MD-ECC' : 'OD-ECC', cpl: Math.floor(e * p.coupled_rows / Math.max(1, b.ecc_mats)), acc: g + Math.floor(e - Math.floor(e / ge) * ge), grp: Math.floor(e / ge) });
      u += eccW;
      swd();
    }
    // PRAC counter cells (extension) sit beside the last ECC MAT, inside its outer SWD stripe
    if (b.rh_w) {
      const last = cols.pop();
      u -= last.w;
      cols.push({ kind: 'rhcells', u, w: b.rh_w });
      u += b.rh_w;
      swd();
    }
    return cols;
  };

  function buildBank(m, bk) {
    const b = m.bank, p = m.p;
    const F = frame(bk);
    const d2 = b.dummy_y / 2;
    const arrH = b.cells_h + b.blsa_total;
    const kids = [];
    const mk = (type, name, r, extra) => node(type, name, r.x, r.y, r.w, r.h, Object.assign({ bank: bk }, extra));
    if (d2 > 0) {
      kids.push(mk('dummy', 'Dummy half-subarray', F(0, 0, b.bank_x, d2)));
      kids.push(mk('dummy', 'Dummy half-subarray', F(0, d2 + b.bank_y, b.bank_x, d2)));
    }
    // a Chronus counter subarray (PRAC extension) sits between the array and the column decoder
    kids.push(mk('rowdec', 'Row decoder', F(0, d2, b.rowdec_w, arrH + b.cnt_h)));
    if (b.cnt_h) kids.push(mk('rhcells', `PRAC counter subarray (${b.counter_rows} rows)`, F(b.rowdec_w, d2 + arrH, b.bank_x - b.rowdec_w, b.cnt_h)));
    kids.push(mk('corner', 'Decoder corner', F(0, d2 + arrH + b.cnt_h, b.rowdec_w, b.coldec_h)));
    kids.push(mk('coldec', 'Column decoder', F(b.rowdec_w, d2 + arrH + b.cnt_h, b.bank_x - b.rowdec_w, b.coldec_h)));
    const cols = bk.matCols || (bk.matCols = DR.matColumns(m));
    let v = d2;
    for (const row of DR.subarrayRows(p)) {
      const name = row.kind === 'subarray' ? `Subarray ${row.idx}${row.repair ? ' (repair)' : ''}${row.edge ? ` · ${row.edge} edge half` : ''}`
        : row.kind === 'salpbuf' ? `SALP buffer (before group ${row.group})` : 'Extra subarray row (+1)';
      const v0 = v;
      const sa = mk(row.kind, name, F(b.rowdec_w, v0, b.cells_w + b.swd_total + b.rh_w, b.mat_h + b.blsa_h),
        { row, local: { v: v0 }, cols });
      sa.gen = () => buildSubarray(m, bk, sa, F, v0, cols);
      kids.push(sa);
      v += b.mat_h + b.blsa_h;
    }
    return kids;
  }

  function buildSubarray(m, bk, sa, F, v, cols) {
    const b = m.bank;
    const kids = [];
    const u0 = b.rowdec_w;
    const blsaV = v + b.mat_h; // BLSA stripe on the column-decoder side of each cell row
    cols.forEach((c, i) => {
      if (c.kind === 'swd') {
        const r = F(u0 + c.u, v, c.w, b.mat_h);
        // a sub-WL driver feeds local wordlines into the MATs directly on either side of it
        const left = cols[i - 1] && cols[i - 1].kind !== 'swd' ? cols[i - 1] : null;
        const right = cols[i + 1] && cols[i + 1].kind !== 'swd' ? cols[i + 1] : null;
        kids.push(node('swd', 'LWD / SWD stripe', r.x, r.y, r.w, r.h, { bank: bk, sa, between: [left, right] }));
        const q = F(u0 + c.u, blsaV, c.w, b.blsa_h);
        kids.push(node('conj', 'SWD/BLSA conjunction', q.x, q.y, q.w, q.h, { bank: bk, sa }));
      } else {
        const r = F(u0 + c.u, v, c.w, b.mat_h);
        const nm = c.kind === 'mat' ? `MAT ${c.idx}` : c.kind === 'rhcells' ? 'PRAC counter cells' : `ECC MAT ${c.idx} (${c.ecc})`;
        kids.push(node(c.kind, nm, r.x, r.y, r.w, r.h, { bank: bk, sa, col: c, rowKind: sa.row.kind }));
        const q = F(u0 + c.u, blsaV, c.w, b.blsa_h);
        kids.push(node('blsa', 'BLSA', q.x, q.y, q.w, q.h, { bank: bk, sa, col: c }));
      }
    });
    return kids;
  }

  DR.ancestors = function (n) {
    const out = [];
    for (let a = n; a; a = a.parent) out.unshift(a);
    return out;
  };
})();
