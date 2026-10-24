// Canvas renderer: level-of-detail drawing of the floorplan tree, wire overlays, TSV grids,
// the exploded stack view, and hit-testing for hover/selection.
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});

  // Colours roughly follow the paper's Fig. 2/3 (CSL green, MDL purple, MWL gold, LDL magenta, BL blue, WL red).
  DR.PALETTES = {
    dark: {
      canvas: '#0f1217', grid: '#1a1f27', text: '#e6e9ef', textDim: '#9aa3b2', outline: 'rgba(230,233,239,0.55)',
      accent: '#ffd166', hover: 'rgba(255,255,255,0.9)', mask: 'rgba(8,10,14,0.62)',
      channel: '#7aa2f7', pch: '#9ece6a', bg: '#e0af68', bank: '#c0caf5', subarray: '#565f89',
      mat: '#3d6fb6', matExtra: '#344a6b', eccmat: '#8e5fc4', eccOd: '#6f4aa8', rhcells: '#d9534f', salpbuf: '#4b4f5c', extrarow: '#3a4252',
      blsa: '#d08a3c', swd: '#5c6b73', conj: '#3e474d', rowdec: '#e8b98a', coldec: '#8fb8de', corner: '#6d7d8f',
      dummy: '#2c313b', ioctl: '#e27aa6', ctrl: '#a68b6d', mbus: '#4f9d77', tsvother: '#5a4636', tsvcmd: '#b2453f', tsvdata: '#a23f8c',
      tsvDot: '#f2c6de', tsvCmdDot: '#ffb4a8',
      wl: '#e0524f', bl: '#4f8fe0', mwl: '#e6b422', csl: '#3fa34d', mdl: '#8b5cf6', mdlb: '#b59cf8', ldl: '#d1478f', lsl: '#2fa3a3',
      bgbus: '#4cc9f0', gbus: '#f472b6', path: '#ffd166',
      pages: ['#3d6fb6', '#2f9e8f', '#b0793a', '#9b4fb0', '#5a8f3a', '#b04f5f', '#3a7fb0', '#8f8f3a'],
      sid: ['#7aa2f7', '#9ece6a', '#f7768e', '#e0af68'], base: '#555b66',
      cpl: ['#7d8de2', '#d9667a', '#5fbf9f', '#c9a227'], edge: '#e9e4d8',
      cw: ['#2dd4bf', '#c084fc'],
      tsvp: { ra: '#ff8a80', ca: '#ffb74d', ck: '#fff59d', cke: '#eeeeee', dq: '#f48fb1', ecc: '#b39ddb', dbi: '#80deea', sev: '#a5d6a7', wck: '#ffe082', pwr: '#bcaaa4' },
    },
    light: {
      canvas: '#f6f7f9', grid: '#e6e8ec', text: '#1d2330', textDim: '#5d6676', outline: 'rgba(29,35,48,0.55)',
      accent: '#d97706', hover: 'rgba(0,0,0,0.85)', mask: 'rgba(246,247,249,0.7)',
      channel: '#2f5fd0', pch: '#4d8a1f', bg: '#b7791f', bank: '#3a4566', subarray: '#8a93ab',
      mat: '#9cc1ef', matExtra: '#c5d2e3', eccmat: '#c7a6ec', eccOd: '#b190e0', rhcells: '#e8837f', salpbuf: '#c9ccd3', extrarow: '#d6dbe3',
      blsa: '#f0b46b', swd: '#a9b6bd', conj: '#8e9aa1', rowdec: '#f6cfa6', coldec: '#b9d6f2', corner: '#a8b4c2',
      dummy: '#dfe2e7', ioctl: '#ef9cc0', ctrl: '#d6bf9f', mbus: '#9fd4b6', tsvother: '#d9c4b0', tsvcmd: '#ef9a92', tsvdata: '#e3a1d1',
      tsvDot: '#7a2160', tsvCmdDot: '#8f241b',
      wl: '#c62828', bl: '#1e63c4', mwl: '#b8860b', csl: '#2e7d32', mdl: '#6d28d9', mdlb: '#9f7aea', ldl: '#ad1457', lsl: '#00838f',
      bgbus: '#0284c7', gbus: '#db2777', path: '#d97706',
      pages: ['#9cc1ef', '#94d8cc', '#efc79a', '#d6b0e6', '#b8dc9c', '#efaab4', '#a6cbe8', '#dcdc9c'],
      sid: ['#2f5fd0', '#4d8a1f', '#c0392b', '#b7791f'], base: '#9aa1ad',
      cpl: ['#9aa8ea', '#eea3b1', '#9ad8c2', '#e3cf7f'], edge: '#3a3f4a',
      cw: ['#0d9488', '#9333ea'],
      tsvp: { ra: '#c62828', ca: '#ef6c00', ck: '#9e8a00', cke: '#455a64', dq: '#ad1457', ecc: '#5e35b1', dbi: '#00838f', sev: '#2e7d32', wck: '#b8860b', pwr: '#6d4c41' },
    },
  };

  const EXPAND = { bank: 70, subarray: 9, salpbuf: 9, extrarow: 9, tsvregion: 0 };
  const CONTAINERS = new Set(['die', 'channel', 'pch', 'bg', 'bank', 'subarray', 'salpbuf', 'extrarow', 'tsvregion']);

  class Renderer {
    constructor(canvas, app) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.app = app;
      this.cam = { x: 0, y: 0, s: 1 };
      this.anim = null;
      this.wireHits = [];
      this.stackHits = [];
      this.dpr = 1;
      this.W = 1; this.H = 1;
    }

    resize() {
      const r = this.cv.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
      this.cv.width = Math.round(this.W * this.dpr);
      this.cv.height = Math.round(this.H * this.dpr);
    }

    // camera: (cam.x, cam.y) is the world point at the canvas centre, cam.s is px per µm
    sx(x) { return (x - this.cam.x) * this.cam.s + this.W / 2; }
    sy(y) { return (y - this.cam.y) * this.cam.s + this.H / 2; }
    wx(px) { return (px - this.W / 2) / this.cam.s + this.cam.x; }
    wy(py) { return (py - this.H / 2) / this.cam.s + this.cam.y; }

    fitRect(r, animate, pad) {
      // leave room to see a MAT's neighbouring LWDs and BLSAs
      if (pad === undefined) pad = r.type === 'mat' || r.type === 'eccmat' ? 0.3 : 0.06;
      const s = Math.min(this.W / (r.w * (1 + 2 * pad)), this.H / (r.h * (1 + 2 * pad)));
      const target = { x: r.x + r.w / 2, y: r.y + r.h / 2, s };
      if (!animate) { this.cam = target; this.anim = null; this.app.requestDraw(); return; }
      const from = Object.assign({}, this.cam);
      const t0 = performance.now(), dur = 380;
      this.anim = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const ls = Math.log(from.s) + (Math.log(target.s) - Math.log(from.s)) * e;
        this.cam = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, s: Math.exp(ls) };
        if (k >= 1) this.anim = null;
      };
      this.app.requestDraw();
    }

    zoomAt(px, py, factor) {
      const wx = this.wx(px), wy = this.wy(py);
      this.cam.s *= factor;
      this.cam.x = wx - (px - this.W / 2) / this.cam.s;
      this.cam.y = wy - (py - this.H / 2) / this.cam.s;
    }

    layerOn(key) { return !key || this.app.layers[key] !== false; }
    typeOn(type) { const t = DR.TYPES[type]; return this.layerOn(t && t.layer); }

    draw(now) {
      if (this.anim) this.anim(now || performance.now());
      const ctx = this.ctx, P = this.P = DR.PALETTES[this.app.theme];
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = P.canvas;
      ctx.fillRect(0, 0, this.W, this.H);
      this.wireHits = [];
      this.stackHits = [];
      const app = this.app;
      if (!app.model) return;
      if (app.focus.type === 'stack') { this.drawStack(); return; }
      const die = app.currentDie;
      this.detailQueue = [];
      this.bankQueue = [];
      this.drawNode(die, 0);
      // dim everything outside the focused component (wires below stay bright, since they run on)
      const f = app.focus;
      if (f && f.type !== 'die') {
        ctx.save();
        ctx.fillStyle = P.mask;
        ctx.beginPath();
        ctx.rect(0, 0, this.W, this.H);
        ctx.rect(this.sx(f.x), this.sy(f.y), f.w * this.cam.s, f.h * this.cam.s);
        ctx.fill('evenodd');
        ctx.restore();
      }
      // second pass: MAT wiring goes over every fill (it crosses the neighbouring BLSA/SWD stripes)
      for (const n of this.detailQueue) this.matDetail(n);
      if (app.model.p.edge_pairing && this.layerOn('edgepair')) for (const bk of this.bankQueue) this.edgePairLink(bk);
      this.drawDieWires(die);
      if (this.layerOn('path')) this.drawAccessPath(die);
      if (app.hover) this.outline(app.hover, P.hover, 1.5, [4, 3]);
      if (app.selected && app.selected.type !== 'stack') this.outline(app.selected, P.accent, 2.5);
      if (f && f.type !== 'die') this.outline(f, P.accent, 1, [2, 4]);
      this.drawScaleBar();
    }

    outline(n, color, lw, dash) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      if (dash) ctx.setLineDash(dash);
      ctx.strokeRect(this.sx(n.x), this.sy(n.y), Math.max(1, n.w * this.cam.s), Math.max(1, n.h * this.cam.s));
      ctx.restore();
    }

    visible(n) {
      const x = this.sx(n.x), y = this.sy(n.y), w = n.w * this.cam.s, h = n.h * this.cam.s;
      return x + w >= 0 && y + h >= 0 && x <= this.W && y <= this.H;
    }

    expands(n) {
      if (!n.gen && !(n.kids && n.kids.length)) return false;
      const th = EXPAND[n.type];
      if (th === undefined) return true;
      return Math.min(n.w, n.h) * this.cam.s > th;
    }

    fill(n, color) {
      const s = this.cam.s;
      const x = this.sx(n.x), y = this.sy(n.y);
      this.ctx.fillStyle = color;
      // snap tiny rects to at least a hairline so dense stripes stay visible
      this.ctx.fillRect(x, y, Math.max(n.w * s, 0.6), Math.max(n.h * s, 0.6));
    }

    nodeColor(n) {
      const P = this.P, app = this.app;
      switch (n.type) {
        case 'mat': {
          if (n.rowKind === 'extrarow' || n.rowKind === 'salpbuf') return P.matExtra;
          if (this.layerOn('coupled') && app.model.p.coupled_rows > 1) return P.cpl[n.col.cpl % P.cpl.length];
          if (this.layerOn('pages') && app.model.pages.ind_row_pages > 1) return P.pages[n.col.page % P.pages.length];
          return P.mat;
        }
        case 'eccmat': return n.col.ecc === 'OD-ECC' ? P.eccOd : P.eccmat;
        default: return P[n.type] || '#888';
      }
    }

    drawNode(n, depth) {
      if (!this.visible(n)) return;
      const s = this.cam.s, sw = n.w * s, sh = n.h * s;
      if (sw < 0.2 && sh < 0.2) return;
      const on = this.typeOn(n.type);
      if (CONTAINERS.has(n.type)) {
        if (this.expands(n)) {
          if (n.type === 'bank') this.bankQueue.push(n);
          for (const k of DR.children(n)) this.drawNode(k, depth + 1);
          if (on) this.containerChrome(n, sw, sh);
        } else {
          this.summary(n, sw, sh);
          if (on && n.type !== 'die') this.containerChrome(n, sw, sh, true);
        }
        return;
      }
      if (on) this.fill(n, this.nodeColor(n));
      if ((n.type === 'mat' || n.type === 'eccmat') && n.sa.row.edge && this.layerOn('edgepair')) this.hatch(n);
      if ((n.type === 'mat' || n.type === 'eccmat') && n.rowKind === 'subarray' && this.layerOn('eccsym')) this.eccBand(n, sw, sh);
      if ((n.type === 'mat' || n.type === 'eccmat') && sw > 50) this.detailQueue.push(n);
      if (n.tsvKind && on && this.layerOn('tsvdots')) this.tsvDots(n);
      if (on && this.app.layers.labels !== false) this.leafLabel(n, sw, sh);
    }

    // Edge-subarray MATs: half of the bitlines are dummies (no sense amp on the outer side)
    hatch(n) {
      const ctx = this.ctx, s = this.cam.s;
      const x = this.sx(n.x), y = this.sy(n.y), w = n.w * s, h = n.h * s;
      if (w < 3 || h < 3) return;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.strokeStyle = this.P.edge;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      const step = Math.max(4, Math.min(10, w / 6));
      ctx.beginPath();
      for (let d = -h; d < w; d += step) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); }
      ctx.stroke();
      ctx.restore();
    }

    // Bracket joining the two edge subarrays whose wordlines one ACT drives together
    edgePairLink(bk) {
      const m = this.app.model, b = m.bank, ctx = this.ctx, s = this.cam.s;
      const F = bankFrame(bk);
      const rows = DR.subarrayRows(m.p);
      const vOf = (i) => b.dummy_y / 2 + i * (b.mat_h + b.blsa_h) + b.mat_h / 2;
      const far = F(b.bank_x - 2 / s, vOf(0), 0, 0), near = F(b.bank_x - 2 / s, vOf(rows.findIndex((r) => r.edge === 'near')), 0, 0);
      const x = this.sx(far.x) + (bk.flipX ? 10 : -10);
      const y1 = this.sy(far.y), y2 = this.sy(near.y);
      ctx.save();
      ctx.strokeStyle = this.P.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x + (bk.flipX ? -8 : 8), y1); ctx.lineTo(x, y1); ctx.lineTo(x, y2); ctx.lineTo(x + (bk.flipX ? -8 : 8), y2);
      ctx.stroke();
      if (Math.abs(y2 - y1) > 120 && this.app.layers.labels !== false) {
        ctx.setLineDash([]);
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = this.P.accent;
        ctx.translate(x + (bk.flipX ? 13 : -5), (y1 + y2) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('paired edge subarrays · one row', 0, 0);
      }
      ctx.restore();
    }

    containerChrome(n, sw, sh, collapsed) {
      const ctx = this.ctx, P = this.P;
      const col = P[n.type] || P.outline;
      const strong = n.type === 'channel' || n.type === 'pch';
      const lw = n.type === 'channel' ? 2 : n.type === 'pch' ? 1.4 : 1;
      if (sw > 3 && sh > 3) {
        ctx.save();
        ctx.strokeStyle = col;
        ctx.globalAlpha = strong ? 0.95 : collapsed ? 0.45 : 0.75;
        ctx.lineWidth = lw;
        if (n.type === 'pch') ctx.setLineDash([6, 4]);
        ctx.strokeRect(this.sx(n.x) + lw / 2, this.sy(n.y) + lw / 2, sw - lw, sh - lw);
        ctx.restore();
      }
      if (this.app.layers.labels === false || n.type === 'die') return;
      if (this.labelDepth(n) > 2) return;
      const label = this.shortName(n);
      const fs = n.type === 'channel' ? 14 : n.type === 'pch' ? 12 : 11;
      if (sw < label.length * fs * 0.62 + 8 || sh < fs + 6) return;
      if ((n.type === 'subarray' || n.type === 'extrarow' || n.type === 'salpbuf') && sh < 26) return;
      ctx.save();
      ctx.font = `${n.type === 'channel' ? 600 : 500} ${fs}px Inter, system-ui, sans-serif`;
      let tx = this.sx(n.x) + 5;
      let ty = this.sy(n.y) + fs + 3;
      if (n.type === 'pch') ty += 16; // keep clear of the channel label
      if (ty > this.H - 4) return ctx.restore();
      ty = Math.max(ty, fs + 4);
      const tw = ctx.measureText(label).width;
      // bank-group labels go top-right so they don't sit on their first bank's label
      if (n.type === 'bg') tx = this.sx(n.x) + sw - tw - 6;
      ctx.fillStyle = this.app.theme === 'dark' ? 'rgba(15,18,23,0.72)' : 'rgba(246,247,249,0.8)';
      ctx.fillRect(tx - 3, ty - fs, tw + 6, fs + 4);
      ctx.fillStyle = col;
      ctx.fillText(label, tx, ty);
      ctx.restore();
    }

    // how many hierarchy levels n sits below the current focus (Infinity if not inside it)
    labelDepth(n) {
      let d = 0;
      for (let a = n; a; a = a.parent, d++) if (a === this.app.focus) return d;
      return this.app.focus.type === 'die' ? Infinity : 99;
    }

    shortName(n) {
      switch (n.type) {
        case 'pch': return 'PC' + n.pcIdx;
        case 'bg': return n.bgName;
        case 'bank': return 'Bank ' + n.bankIdx;
        default: return n.name;
      }
    }

    leafLabel(n, sw, sh) {
      const nm = n.type === 'mat' ? 'MAT ' + n.col.idx : n.type === 'eccmat' ? 'ECC' : n.name;
      const vertical = sh > sw * 2.2;
      const len = vertical ? sh : sw, thick = vertical ? sw : sh;
      const fs = Math.min(13, Math.max(9, thick * 0.32));
      if (thick < fs + 4 || len < nm.length * fs * 0.6 + 10) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.font = `500 ${fs}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = this.app.theme === 'dark' ? 'rgba(255,255,255,0.82)' : 'rgba(10,14,22,0.78)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cx = this.sx(n.x) + sw / 2, cy = this.sy(n.y) + sh / 2;
      ctx.translate(Math.min(Math.max(cx, 40), this.W - 40), Math.min(Math.max(cy, 20), this.H - 20));
      if (vertical) ctx.rotate(-Math.PI / 2);
      ctx.fillText(nm, 0, 0);
      ctx.restore();
    }

    // Collapsed containers: draw a cheap but faithful miniature instead of all children.
    summary(n, sw, sh) {
      const P = this.P, m = this.app.model, b = m.bank;
      if (n.type === 'bank') {
        const F = bankFrame(n);
        const d2 = b.dummy_y / 2, arrH = b.cells_h + b.blsa_total;
        const R = (r, c, key) => { if (this.layerOn(key)) this.fill(r, c); };
        R(F(0, 0, b.bank_x, d2), P.dummy, 'dummy');
        R(F(0, d2 + b.bank_y, b.bank_x, d2), P.dummy, 'dummy');
        R(F(b.rowdec_w, d2, b.cells_w + b.swd_total + b.rh_w, arrH), P.mat, 'mat');
        R(F(0, d2, b.rowdec_w, arrH + b.cnt_h), P.rowdec, 'rowdec');
        if (b.cnt_h) R(F(b.rowdec_w, d2 + arrH, b.bank_x - b.rowdec_w, b.cnt_h), P.rhcells, 'rhcells');
        R(F(0, d2 + arrH + b.cnt_h, b.bank_x, b.coldec_h), P.coldec, 'coldec');
        R(F(b.rowdec_w + b.data_w + b.swd_w * (m.p.mats + m.p.subchannels), d2, b.ecc_w + b.swd_w * b.ecc_mats, arrH), P.eccmat, 'eccmat');
        if (b.rh_w) R(F(b.bank_x - b.swd_w - b.rh_w, d2, b.rh_w, arrH), P.rhcells, 'rhcells');
        if (this.layerOn('blsa') && sh > 26) {
          let v = d2 + b.mat_h;
          for (let i = 0; i < b.rows; i++, v += b.mat_h + b.blsa_h) this.fill(F(b.rowdec_w, v, b.cells_w + b.swd_total + b.rh_w, b.blsa_h), P.blsa);
        }
        return;
      }
      if (n.type === 'subarray' || n.type === 'salpbuf' || n.type === 'extrarow') {
        const F = bankFrame(n.bank);
        const v = n.local.v;
        const u0 = b.rowdec_w;
        if (this.layerOn('mat')) this.fill(F(u0, v, b.cells_w + b.swd_total + b.rh_w, b.mat_h), n.type === 'subarray' ? P.mat : P.matExtra);
        if (this.layerOn('blsa')) this.fill(F(u0, v + b.mat_h, b.cells_w + b.swd_total + b.rh_w, b.blsa_h), P.blsa);
        return;
      }
      if (this.typeOn(n.type)) this.fill(n, P[n.type] || P.grid);
    }

    // ---- MAT-level detail: cells (WL/BL), LWDs, BLSAs and the CSL/MDL/LDL routing scheme ----
    matDetail(n) {
      const ctx = this.ctx, P = this.P, m = this.app.model, p = m.p, b = m.bank, s = this.cam.s;
      const L = this.app.layers;
      const F = bankFrame(n.bank);
      const u0 = b.rowdec_w + n.col.u, v0 = n.sa.local.v;
      const cell = F(u0, v0, n.col.w, b.mat_h);
      const X = (x) => this.sx(x), Y = (y) => this.sy(y);
      const rows = p.mat_rows, cols = Math.round(n.col.w / (t_bl(m)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(X(cell.x), Y(cell.y), cell.w * s, cell.h * s);
      ctx.clip();
      // wordlines (horizontal) and bitlines (vertical), thinned to stay legible
      const thinLines = (count, horizontal, color, key, lw) => {
        if (L[key] === false) return;
        const span = horizontal ? cell.h : cell.w;
        const px = span * s / count;
        const step = Math.max(1, Math.ceil(3 / px));
        ctx.strokeStyle = color;
        ctx.globalAlpha = Math.min(0.85, 0.25 + px * step / 12);
        ctx.lineWidth = lw;
        ctx.beginPath();
        for (let i = 0; i < count; i += step) {
          const f = (i + 0.5) / count;
          if (horizontal) { const yy = Y(cell.y + f * cell.h); ctx.moveTo(X(cell.x), yy); ctx.lineTo(X(cell.x + cell.w), yy); }
          else { const xx = X(cell.x + f * cell.w); ctx.moveTo(xx, Y(cell.y)); ctx.lineTo(xx, Y(cell.y + cell.h)); }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (step === 1 && px > 5) this.wireHits.push({ kind: horizontal ? 'wl' : 'bl', count, rect: cell, horizontal });
      };
      thinLines(rows, true, P.wl, 'wl', 0.8);
      thinLines(cols, false, P.bl, 'bl', 0.8);
      if (n.sa.row.edge && L.edgepair !== false) {
        // every other bitline is a dummy in an open-BL edge subarray
        const px = cell.w * s / cols;
        if (px > 1.5) {
          ctx.strokeStyle = P.edge;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = Math.max(1, px * 0.5);
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          for (let i = n.sa.row.edge === 'far' ? 0 : 1; i < cols; i += 2) {
            const xx = X(cell.x + (i + 0.5) / cols * cell.w);
            ctx.moveTo(xx, Y(cell.y)); ctx.lineTo(xx, Y(cell.y + cell.h));
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
      // MWLs: one per 8 WLs (illustrative ratio; DreamRAM models one asserted MWL per ACT)
      thinLines(Math.max(1, rows / 8), true, P.mwl, 'mwl', 2);
      ctx.restore();

      // Vertical routing (bitline direction) spans the cell array and this MAT's BLSA stripe
      const vTop = v0, vH = b.mat_h + b.blsa_h;
      const span = (u, w) => F(u, vTop, w, vH);
      const cfg = p.mdlcsl, nMdl = p.ldls_mdls * 2, nCsl = m.pitch.csl_count;
      const leftSwd = span(u0 - b.swd_w, b.swd_w), rightSwd = span(u0 + n.col.w, b.swd_w);
      const overMat = span(u0, n.col.w);
      // Split a count across the right half of the left SWD and the left half of the right SWD (Fig. 3)
      const overSwds = (count) => {
        const half = Math.ceil(count / 2), out = [];
        const lh = halfRect(leftSwd, bankFlipX(n.bank) ? 'left' : 'right');
        const rh = halfRect(rightSwd, bankFlipX(n.bank) ? 'right' : 'left');
        for (let i = 0; i < half; i++) out.push(lh.x + (i + 0.5) / half * lh.w);
        for (let i = 0; i < count - half; i++) out.push(rh.x + (i + 0.5) / (count - half) * rh.w);
        return out;
      };
      const across = (count, r, offset) => Array.from({ length: count }, (_, i) => r.x + (i + 0.5 + (offset || 0)) / count * r.w);
      let mdlX = [], cslX = [];
      if (cfg === 0) { cslX = across(nCsl, overMat); mdlX = overSwds(nMdl); }
      else if (cfg === 1) { mdlX = across(nMdl, overMat); cslX = overSwds(nCsl); }
      else if (p.csl_mdl_shared_layer) {
        // one shared metal layer: MDL pairs interleaved among the CSLs at a common pitch
        const tot = nMdl + nCsl;
        for (let i = 0; i < tot; i++) {
          const x = overMat.x + (i + 0.5) / tot * overMat.w;
          (Math.floor((i + 1) * nMdl / tot) > Math.floor(i * nMdl / tot) ? mdlX : cslX).push(x);
        }
      } else { cslX = across(nCsl, overMat); mdlX = across(nMdl, overMat, 0.5); }
      const vline = (xs, color, key, w, label, total, dashedEvery) => {
        if (L[key] === false || !xs.length) return;
        const pxPitch = xs.length > 1 ? Math.abs(xs[1] - xs[0]) * s : 99;
        if (pxPitch < 1.2) return;
        ctx.save();
        ctx.lineWidth = Math.max(1, Math.min(w, pxPitch * 0.45));
        const y1 = Y(overMat.y), y2 = Y(overMat.y + overMat.h);
        xs.forEach((x, i) => {
          ctx.strokeStyle = dashedEvery && i % 2 === 1 ? P.mdlb : color; // complementary MDL of each pair
          ctx.beginPath(); ctx.moveTo(X(x), y1); ctx.lineTo(X(x), y2); ctx.stroke();
        });
        ctx.restore();
        if (pxPitch > 3) this.wireHits.push({ kind: key, xs, y1: overMat.y, y2: overMat.y + overMat.h, label, total });
      };
      vline(cslX, P.csl, 'csl', 3, 'CSL', nCsl);
      vline(mdlX, P.mdl, 'mdl', 3, 'MDL', nMdl, true);

      // LDLs (LSLs under DLOMAT) run along the BLSA stripe
      if (L.ldl !== false) {
        const bl = F(u0, v0 + b.mat_h, n.col.w, b.blsa_h);
        const nL = p.ldls_mdls * (p.ha_double_ldls ? 2 : 1);
        const px = bl.h * s / nL;
        if (px > 0.8) {
          ctx.save();
          ctx.strokeStyle = cfg === 1 ? P.lsl : P.ldl;
          ctx.lineWidth = Math.max(0.8, Math.min(2.5, px * 0.4));
          for (let i = 0; i < nL; i++) {
            const y = Y(bl.y + (i + 0.5) / nL * bl.h);
            ctx.beginPath(); ctx.moveTo(X(bl.x), y); ctx.lineTo(X(bl.x + bl.w), y); ctx.stroke();
          }
          ctx.restore();
          if (px > 3) this.wireHits.push({ kind: 'ldl', count: nL, rect: bl, horizontal: true, label: cfg === 1 ? 'LSL' : 'LDL' });
        }
      }
    }

    tsvDots(n) {
      const P = this.P, m = this.app.model, t = m.t, s = this.cam.s, ctx = this.ctx;
      const pitch = m.stack.tsv_grid_pitch;
      if (pitch * s < 3.5) return;
      // power bands span the die minus the edge keep-out; DWORD/AWORD blocks use their own width
      const xm = n.tsvKind === 'power' ? t.tsv_koz : 0;
      const x0 = n.x + xm, w = n.w - 2 * xm;
      const perRow = Math.max(1, Math.floor(w / pitch)), colPitch = w / perRow;
      const count = Math.round(n.count);
      const rowsN = Math.max(1, Math.ceil(count / perRow));
      const y0 = n.y + (n.kozTop || 0), hUse = n.h - (n.kozTop || 0) - (n.kozBot || 0);
      const rowPitch = hUse / rowsN;
      const die = this.app.currentDie;
      const myCh0 = die.chBase, myCh1 = die.chBase + m.p.ch_per_die;
      const byPurpose = this.layerOn('tsvpurpose');
      const r = Math.max(1, Math.min(colPitch, rowPitch) * 0.3 * s);
      // cumulative [end, channel, part] over the block's channel sequence, filled row-major
      if (!n.bounds) {
        n.bounds = [];
        let acc = 0;
        for (const g of n.seq) for (const q of g.parts) n.bounds.push([(acc += q.n), g.ch, q]);
      }
      const c0 = Math.max(0, Math.floor((this.wx(0) - x0) / colPitch) - 1), c1 = Math.min(perRow - 1, Math.ceil((this.wx(this.W) - x0) / colPitch) + 1);
      const r0 = Math.max(0, Math.floor((this.wy(0) - y0) / rowPitch) - 1), r1 = Math.min(rowsN - 1, Math.ceil((this.wy(this.H) - y0) / rowPitch) + 1);
      const plain = n.tsvKind === 'cmd' ? P.tsvCmdDot : P.tsvDot;
      const paths = new Map();
      let bi = 0;
      for (let ri = r0; ri <= r1; ri++) {
        for (let ci = c0; ci <= c1; ci++) {
          const i = ri * perRow + ci;
          if (i >= count) break;
          while (bi > 0 && n.bounds[bi - 1][0] > i) bi--;
          while (bi < n.bounds.length - 1 && n.bounds[bi][0] <= i) bi++;
          const [, ch, part] = n.bounds[bi];
          const mine = ch === null || (ch >= myCh0 && ch < myCh1);
          const k = (byPurpose ? part.key : 'plain') + (mine ? '' : '~');
          if (!paths.has(k)) paths.set(k, new Path2D());
          const cx = this.sx(x0 + (ci + 0.5) * colPitch), cy = this.sy(y0 + (ri + 0.5) * rowPitch);
          const path = paths.get(k);
          path.moveTo(cx + r, cy);
          path.arc(cx, cy, r, 0, Math.PI * 2);
        }
      }
      for (const [k, path] of paths) {
        const key = k.replace('~', '');
        ctx.fillStyle = key === 'plain' ? plain : P.tsvp[key];
        ctx.globalAlpha = k.endsWith('~') ? 0.28 : 1; // channels of other dies just pass through
        ctx.fill(path);
      }
      ctx.globalAlpha = 1;
      if (colPitch * s > 10) this.wireHits.push({ kind: 'tsv', tsv: n, x0, y0, colPitch, rowPitch, perRow, count });
    }

    // OD-ECC codeword band along the top of a MAT: which codeword (A/B) its symbols belong to
    eccBand(n, sw, sh) {
      if (sw < 3 || sh < 4) return;
      const m = this.app.model, P = this.P, ctx = this.ctx;
      const e = m.ecc || (m.ecc = DR.eccLayout(m));
      const x = this.sx(n.x), y = this.sy(n.y), h = Math.max(2, sh * 0.18);
      const segs = Math.max(1, Math.round(e.spm));
      for (let k = 0; k < segs; k++) {
        ctx.fillStyle = P.cw[DR.codeword(e.spm, n.col.acc, k) === 'A' ? 0 : 1];
        ctx.fillRect(x + (sw * k) / segs, y, sw / segs, h);
      }
    }

    // Shared data-path geometry (Ryu et al., Fig. 3): BG-BUS x per bank group, GBUS CTRL rows, and the two
    // alternating GBUS sets per column running between the top and bottom GBUS CTRL through the DWORD block
    busGeom(die) {
      const m = this.app.model, s = m.stack, lay = die.layout;
      return {
        bgX: (bg) => bg.x + bg.w * (0.25 + 0.5 * (bg.halfIdx + 0.5) / bg.halfN),
        ctrlY: (top) => (top ? lay.mbusTopY : lay.mbusBotY) + s.mbus_h / 4,
        gbusX: (col, k) => { const d = die.tsv.dword[col]; return d.x + d.w * (k ? 0.24 : 0.14); },
        dword: (col) => die.tsv.dword[col],
      };
    }

    drawDieWires(die) {
      const L = this.app.layers, m = this.app.model, P = this.P, ctx = this.ctx;
      if (L.bgbus === false && L.gbus === false) return;
      const G = this.busGeom(die), s = this.cam.s;
      const busW = Math.max(2, Math.min(8, m.bank.bank_x * s * 0.02));
      ctx.save();
      ctx.lineCap = 'round';
      for (const ch of DR.children(die)) {
        if (ch.type !== 'channel') continue;
        for (const pc of DR.children(ch)) {
          for (const bg of DR.children(pc)) {
            if (bg.type !== 'bg' || L.bgbus === false) continue;
            // BG-BUS: from the bank group's I/O control to the GBUS CTRL on its side of the TSV region
            const x = G.bgX(bg), y1 = bg.iocY + m.stack.od_ecc_h / 2, y2 = G.ctrlY(bg.top);
            ctx.strokeStyle = P.bgbus; ctx.globalAlpha = 0.85; ctx.lineWidth = busW;
            ctx.beginPath(); ctx.moveTo(this.sx(x), this.sy(y1)); ctx.lineTo(this.sx(x), this.sy(y2)); ctx.stroke();
            ctx.fillStyle = P.bgbus;
            ctx.beginPath(); ctx.arc(this.sx(x), this.sy(y1), busW * 0.9, 0, Math.PI * 2); ctx.fill();
            this.wireHits.push({ kind: 'bgbus', seg: [x, y1, x, y2], label: `BG-BUS (${bg.bgName})`, bg });
          }
        }
      }
      if (L.gbus !== false) {
        for (let col = 0; col < m.stack.cols; col++) {
          const yT = G.ctrlY(true), yB = G.ctrlY(false);
          for (let k = 0; k < 2; k++) {
            const x = G.gbusX(col, k);
            ctx.strokeStyle = P.gbus; ctx.globalAlpha = 0.9; ctx.lineWidth = busW;
            ctx.beginPath(); ctx.moveTo(this.sx(x), this.sy(yT)); ctx.lineTo(this.sx(x), this.sy(yB)); ctx.stroke();
            this.wireHits.push({ kind: 'gbus', seg: [x, yT, x, yB], label: `GBUS-${k + 1}`, col });
          }
        }
      }
      ctx.restore();
    }

    // Example access: ACT opens one row page (MWL + LWLs in the page's MATs); RD fires CSLs and moves data
    // over MDLs → column decoder → I/O control → BG-BUS → GBUS CTRL → GBUS → DWORD TSVs.
    drawAccessPath(die) {
      const app = this.app, m = app.model, p = m.p, b = m.bank, P = this.P, ctx = this.ctx, s = this.cam.s;
      const bank = app.traceBank();
      if (!bank) return;
      const F = bankFrame(bank);
      const rowsL = DR.subarrayRows(p);
      const ri = rowsL.findIndex((r) => r.kind === 'subarray' && r.idx === Math.floor(p.subarrays / 2));
      const v = b.dummy_y / 2 + ri * (b.mat_h + b.blsa_h);
      const cols = bank.matCols || (bank.matCols = DR.matColumns(m));
      const eccOpen = Math.ceil(b.ecc_mats / m.pages.ind_row_pages);
      const opened = cols.filter((c) => (c.kind === 'mat' && c.page === 0) || (c.kind === 'eccmat' && c.idx < eccOpen));
      // with coupled rows the ACT opens every half of the wordline, but a READ reaches only the target row
      const open = opened.filter((c) => !c.cpl);
      ctx.save();
      ctx.globalAlpha = 0.55;
      for (const c of opened) {
        ctx.fillStyle = c.cpl ? P.cpl[c.cpl % P.cpl.length] : P.path;
        const r = F(b.rowdec_w + c.u, v, c.w, b.mat_h);
        ctx.fillRect(this.sx(r.x), this.sy(r.y), Math.max(1, r.w * s), Math.max(1, r.h * s));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = P.path;
      ctx.lineCap = 'round';
      // MWL from the row decoder across the bank
      const mw = F(0, v + b.mat_h / 2, b.bank_x, 0);
      ctx.lineWidth = Math.max(2, Math.min(5, b.mat_h * s * 0.15));
      ctx.beginPath(); ctx.moveTo(this.sx(mw.x), this.sy(mw.y)); ctx.lineTo(this.sx(mw.x + mw.w), this.sy(mw.y)); ctx.stroke();
      // MDL bundles from open MATs to the column decoder
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = Math.max(1.5, Math.min(3, b.mat_w * s * 0.08));
      const colY = b.dummy_y / 2 + b.cells_h + b.blsa_total;
      for (const c of open) {
        const a = F(b.rowdec_w + c.u + c.w / 2, v + b.mat_h / 2, 0, colY - v - b.mat_h / 2);
        ctx.beginPath(); ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(a.x), this.sy(a.y + a.h)); ctx.stroke();
      }
      ctx.setLineDash([]);
      // column decoder → I/O control → BG-BUS → GBUS CTRL → GBUS-1 → DWORD TSVs
      const G = this.busGeom(die), bg = bank.bg;
      const cd = F(b.rowdec_w, colY, b.bank_x - b.rowdec_w, b.coldec_h);
      const cx = cd.x + cd.w / 2, cy = cd.y + cd.h / 2;
      const yIoc = bg.iocY + m.stack.od_ecc_h / 2, xBus = G.bgX(bg), yCtrl = G.ctrlY(bg.top);
      const xG = G.gbusX(bg.col, 0), dw = G.dword(bg.col), yT = dw.y + dw.h / 2;
      ctx.lineWidth = Math.max(3, Math.min(9, m.bank.bank_x * s * 0.025));
      ctx.beginPath();
      ctx.moveTo(this.sx(cx), this.sy(cy)); ctx.lineTo(this.sx(cx), this.sy(yIoc)); ctx.lineTo(this.sx(xBus), this.sy(yIoc));
      ctx.lineTo(this.sx(xBus), this.sy(yCtrl)); ctx.lineTo(this.sx(xG), this.sy(yCtrl)); ctx.lineTo(this.sx(xG), this.sy(yT));
      ctx.lineTo(this.sx(dw.x + dw.w / 2), this.sy(yT));
      ctx.stroke();
      ctx.fillStyle = P.path;
      ctx.beginPath(); ctx.arc(this.sx(dw.x + dw.w / 2), this.sy(yT), 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawScaleBar() {
      const ctx = this.ctx, P = this.P;
      const target = 120 / this.cam.s; // µm for ~120px
      const pow10 = Math.pow(10, Math.floor(Math.log10(target)));
      const nice = [1, 2, 5, 10].map((k) => k * pow10).filter((v) => v <= target).pop() || pow10;
      const px = nice * this.cam.s;
      const x = 16, y = this.H - 18;
      ctx.save();
      ctx.strokeStyle = P.text; ctx.fillStyle = P.text; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      ctx.fillText(fmtLen(nice), x + px + 8, y + 1);
      ctx.restore();
    }

    // ---- exploded 3D stack ----
    drawStack() {
      const app = this.app, m = app.model, ctx = this.ctx, P = this.P, p = m.p;
      const n = m.stack.dies + 1; // + base die
      const aspect = m.stack.die_h / m.stack.die_w;
      const W = this.W, H = this.H;
      const faceW = Math.min(W * 0.42, 420), faceD = faceW * aspect * 0.5;
      const thick = 10;
      const gap = Math.max(14, Math.min(46, (H * 0.78 - faceD) / n - thick));
      const totalH = n * (thick + gap) + faceD;
      const ox = W * 0.36 - faceW / 2 - faceD * 0.5, oy = (H + totalH) / 2 - thick;
      const diesPerSid = p.channels / p.ch_per_die;
      ctx.save();
      ctx.font = '500 12px Inter, system-ui, sans-serif';
      for (let i = 0; i < n; i++) {
        const isBase = i === 0;
        const dieIdx = i - 1;
        const y = oy - i * (thick + gap);
        // top face is a parallelogram: (x,y) → (x+faceW, y) → (x+faceW+faceD, y-faceD) → (x+faceD, y-faceD)
        const A = [ox, y], B = [ox + faceW, y], C = [ox + faceW + faceD, y - faceD], D = [ox + faceD, y - faceD];
        const sid = isBase ? -1 : Math.floor(dieIdx / diesPerSid);
        const base = isBase ? P.base : P.sid[sid % P.sid.length];
        const hovered = app.stackHover === i;
        const selected = !isBase && app.selectedDieIdx === dieIdx;
        ctx.globalAlpha = 1;
        // front and side faces
        ctx.fillStyle = shade(base, -0.35);
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(B[0], B[1] + thick); ctx.lineTo(A[0], A[1] + thick); ctx.fill();
        ctx.fillStyle = shade(base, -0.5);
        ctx.beginPath(); ctx.moveTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(C[0], C[1] + thick); ctx.lineTo(B[0], B[1] + thick); ctx.fill();
        // top face
        ctx.fillStyle = shade(base, hovered ? 0.1 : -0.1);
        ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]); ctx.closePath(); ctx.fill();
        if (!isBase) {
          // channel columns on the top face
          const rowsN = m.stack.rows, slotsN = p.ch_per_die / rowsN;
          for (let c = 0; c < p.ch_per_die; c++) {
            const f0 = ((c % slotsN) + 0.08) / slotsN, f1 = ((c % slotsN) + 0.92) / slotsN;
            // depth fractions: channel rows sit on either side of the TSV band (A–B is the near edge)
            const r = Math.floor(c / slotsN), g0 = rowsN === 1 ? 0 : r ? 0.03 : 0.55, g1 = rowsN === 1 ? 1 : r ? 0.45 : 0.97;
            const lerp = (P1, P2, f) => [P1[0] + (P2[0] - P1[0]) * f, P1[1] + (P2[1] - P1[1]) * f];
            const A2 = lerp(A, D, g0), B2 = lerp(B, C, g0), C2 = lerp(B, C, g1), D2 = lerp(A, D, g1);
            const a = lerp(A2, B2, f0), b2 = lerp(A2, B2, f1), c2 = lerp(D2, C2, f1), d = lerp(D2, C2, f0);
            ctx.fillStyle = shade(base, 0.25);
            ctx.globalAlpha = 0.55;
            ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b2[0], b2[1]); ctx.lineTo(c2[0], c2[1]); ctx.lineTo(d[0], d[1]); ctx.fill();
            ctx.globalAlpha = 1;
          }
          // TSV band across the middle of the die
          const tsvF = (m.stack.die_h / 2) / m.stack.die_h;
          const l1 = [A[0] + (D[0] - A[0]) * tsvF, A[1] + (D[1] - A[1]) * tsvF];
          ctx.strokeStyle = P.tsvdata; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(l1[0], l1[1]); ctx.lineTo(l1[0] + faceW, l1[1]); ctx.stroke();
        }
        if (hovered || selected) {
          ctx.strokeStyle = P.accent; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.lineTo(D[0], D[1]); ctx.closePath(); ctx.stroke();
        }
        // label
        const lx = C[0] + 18, ly = (B[1] + C[1]) / 2 + 4;
        ctx.fillStyle = hovered ? P.accent : P.text;
        const label = isBase ? 'Base (logic) die' : `Die ${dieIdx} · SID ${sid} · CH${(dieIdx % diesPerSid) * p.ch_per_die}–${(dieIdx % diesPerSid) * p.ch_per_die + p.ch_per_die - 1}`;
        ctx.fillText(label, lx, ly);
        this.stackHits.push({ i, dieIdx, isBase, poly: [A, B, [B[0], B[1] + thick], C, D], label: [lx, ly - 12, ctx.measureText(label).width, 16] });
      }
      ctx.fillStyle = P.textDim;
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.fillText(`${m.stack.dies} core dies + base die · ${p.sids} SID${p.sids > 1 ? 's' : ''} × ${diesPerSid} dies · ${p.channels} channels`, 16, 24);
      ctx.fillText('Click a core die to open its floorplan', 16, 42);
      ctx.restore();
    }

    hitStack(px, py) {
      for (let k = this.stackHits.length - 1; k >= 0; k--) {
        const h = this.stackHits[k];
        const [lx, ly, lw, lh] = h.label;
        if (px >= lx && px <= lx + lw && py >= ly && py <= ly + lh) return h;
        if (pointInPoly(px, py, h.poly)) return h;
      }
      return null;
    }

    // Deepest drawn node under the cursor (same LOD rules as drawing)
    hit(px, py) {
      const wx = this.wx(px), wy = this.wy(py);
      const app = this.app;
      const rec = (n) => {
        if (wx < n.x || wy < n.y || wx > n.x + n.w || wy > n.y + n.h) return null;
        if (CONTAINERS.has(n.type) && this.expands(n)) {
          for (const k of DR.children(n)) {
            const r = rec(k);
            if (r) return r;
          }
        }
        return n;
      };
      return rec(app.currentDie);
    }

    hitWire(px, py) {
      const wx = this.wx(px), wy = this.wy(py), s = this.cam.s, tol = 4 / s;
      for (let k = this.wireHits.length - 1; k >= 0; k--) {
        const h = this.wireHits[k];
        if (h.xs) {
          if (wy < h.y1 || wy > h.y2) continue;
          for (let i = 0; i < h.xs.length; i++) if (Math.abs(h.xs[i] - wx) < tol) return { kind: h.kind, idx: i, total: h.xs.length, label: h.label };
        } else if (h.tsv) {
          const ci = Math.floor((wx - h.x0) / h.colPitch), ri = Math.floor((wy - h.y0) / h.rowPitch);
          const i = ri * h.perRow + ci;
          if (ci < 0 || ci >= h.perRow || ri < 0 || i >= h.count) continue;
          const cx = h.x0 + (ci + 0.5) * h.colPitch, cy = h.y0 + (ri + 0.5) * h.rowPitch;
          if (Math.hypot(wx - cx, wy - cy) > Math.min(h.colPitch, h.rowPitch) * 0.45) continue;
          const [, ch, part] = h.tsv.bounds.find(([end]) => i < end) || h.tsv.bounds[h.tsv.bounds.length - 1];
          return { kind: 'tsv', tsvKind: h.tsv.tsvKind, ch, part, idx: i };
        } else if (h.seg) {
          const [x1, y1, x2, y2] = h.seg;
          if (Math.abs(wx - x1) < tol * 2 && wy >= Math.min(y1, y2) && wy <= Math.max(y1, y2)) return { kind: h.kind, label: h.label };
        } else if (h.rect) {
          const r = h.rect;
          if (wx < r.x || wx > r.x + r.w || wy < r.y || wy > r.y + r.h) continue;
          const f = h.horizontal ? (wy - r.y) / r.h : (wx - r.x) / r.w;
          const i = Math.floor(f * h.count);
          const c = r[h.horizontal ? 'y' : 'x'] + (i + 0.5) / h.count * r[h.horizontal ? 'h' : 'w'];
          if (Math.abs((h.horizontal ? wy : wx) - c) < tol) return { kind: h.kind, idx: i, total: h.count, label: h.label };
        }
      }
      return null;
    }
  }

  function bankFlipX(bk) { return bk.flipX; }
  function t_bl(m) { return m.t.pitch_bl * m.t.iso_cols; }
  function halfRect(r, side) { return side === 'left' ? { x: r.x, y: r.y, w: r.w / 2, h: r.h } : { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h }; }
  function bankFrame(bk) {
    return (u, v, w, h) => ({
      x: bk.flipX ? bk.x + bk.w - u - w : bk.x + u,
      y: bk.flipY ? bk.y + bk.h - v - h : bk.y + v,
      w, h,
    });
  }
  DR.bankFrame = bankFrame;

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = (c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
    r = f(r); g = f(g); b = f(b);
    return `rgb(${r},${g},${b})`;
  }

  function fmtLen(um) {
    if (um >= 1000) return (um / 1000).toPrecision(3).replace(/\.?0+$/, '') + ' mm';
    if (um >= 1) return (+um.toPrecision(3)) + ' µm';
    return (+(um * 1000).toPrecision(3)) + ' nm';
  }
  DR.fmtLen = fmtLen;
  DR.Renderer = Renderer;
})();
