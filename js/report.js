// Report tab: the HBM4 8 → 32 Gb/s interface-scaling study (tools/sweep_interface.py, README "Scaling the HBM4
// interface"). Static text and tables; die outlines are drawn to scale against the JEDEC HBM4 footprint. Buttons
// with data-load="ex:<name>" open a bundled design in the Floorplan tab (handled in app.js).
(function () {
  'use strict';
  const DR = (window.DR = window.DR || {});

  const FOOT = [14.175, 10.975]; // JEDEC HBM4 32 Gb die footprint (MO-362), mm
  const DIES = [
    ['Thinnest at 32 Gb/s', '32 B, 4 groups stacked, two channel rows', 7.15, 19.88, '142.2 mm², 2.78 : 1'],
    ['4 PCs × 16 DQ, 4 groups', 'two channel rows', 14.30, 11.05, '158.0 mm², 1.29 : 1'],
    ['64 B, 4 groups', 'one channel row', 14.30, 11.22, '160.5 mm², 1.27 : 1'],
    ['32 B, 4 groups, near-square', 'two channel rows', 13.24, 12.62, '167.1 mm², 1.05 : 1'],
    ['HBM4 interface, 16 Gb/s', 'two channel rows', 13.24, 11.90, '157.5 mm², 1.11 : 1'],
  ];

  function dieSvg(name, w, h) {
    const S = 8.5, BOX = 21, pad = 4, W = BOX * S + 2 * pad, c = W / 2;
    return `<svg viewBox="0 0 ${W} ${W}" role="img" aria-label="${name}: ${w} by ${h} mm">
      <rect x="${c - w * S / 2}" y="${c - h * S / 2}" width="${w * S}" height="${h * S}" class="rdie"/>
      <rect x="${c - FOOT[0] * S / 2}" y="${c - FOOT[1] * S / 2}" width="${FOOT[0] * S}" height="${FOOT[1] * S}" class="rfoot"/>
      <text x="${c}" y="${c + 4}" text-anchor="middle" class="rdim">${w.toFixed(2)} × ${h.toFixed(2)}</text></svg>`;
  }
  const load = (k, label) => `<button class="rload" data-load="ex:${k}" title="Open in the Floorplan tab">${label}</button>`;

  const HTML = () => `<article class="rdoc">
  <div class="reyebrow">DreamRAM sweep · 16 GB stack · 34/36 nm array</div>
  <h1>HBM4 at 32 Gb/s</h1>
  <p class="rlede">How far HBM4's pin rate can scale from 8 Gb/s while the host-facing interface stays as specified, and which interface changes make 32 Gb/s work on a die of the same capacity and a package-friendly shape.</p>
  <p class="rnote">Results from <code>tools/sweep_interface.py</code>. Each design is evaluated by DreamRAM with the staged tCCD_L model.</p>

  <div class="rverdict"><ul>
    <li><b>No design that keeps the HBM4 interface reaches 32 Gb/s.</b> Across 2,016 die organisations and three sense-amp placements, the best reaches 19.0 Gb/s.</li>
    <li><b>16 Gb/s works on the HBM4 interface</b>, but only with an I/O sense amp (IOSA) in every bank, and with 16% timing margin.</li>
    <li><b>32 Gb/s needs more bank groups.</b> 4 pseudo-channels of 16 DQs with 4 bank groups each, or 64 B accesses with 4 bank groups, both pass under every sense-amp placement. Each has a near-square die of about 158–161 mm².</li>
    <li><b>Package-friendly shapes cost 10–20% area.</b> The smallest passing dies are long and thin, up to 2.8 : 1. Choosing how channels and bank groups are arranged brings them to 1.05–1.29 : 1, close to the JEDEC footprint's 1.29.</li>
  </ul></div>

  <h2>What the sweep holds and varies</h2>
  <p>Fixed for every design: 16 GB per stack in four 32 Gb dies, 32 channels, 2,048 data DQs, 1 KiB host rows, and the 34/36 nm cell array. Each TSV runs at no more than 8 Gb/s. DreamRAM's die-size filter is relaxed to 20 mm.</p>
  <div class="rcols">
    <div class="rbox"><h3><span class="rtag keep">Keeps the spec</span> Swept freely</h3>
      <p class="rnote">Inside the die; the host never sees these.</p>
      <ul>
        <li>MAT size (256–1,024 wordlines × 256–1,024 bitlines) and MATs per row</li>
        <li>MDLs per MAT, CSL/MDL routing and metal layers</li>
        <li>BLSA or BRVSA sense amps</li>
        <li>Coupled rows: 1, 2 or 4 host rows per physical wordline</li>
        <li>Subarrays per bank (set by capacity)</li>
        <li>Physical bank-group arrangement</li>
        <li>Channels in one or two rows on the die</li>
        <li>IOSA placement and column-decoder placement</li>
        <li>TSV count and rate (GBUS→TSV serdes), GBUS copies</li>
      </ul></div>
    <div class="rbox"><h3><span class="rtag break">Breaks the spec</span> Interface options</h3>
      <p class="rnote">HBM4 values in brackets.</p>
      <ul>
        <li>Column access size [32 B, BL8]: 64 B (BL16)</li>
        <li>Bank groups per pseudo-channel [2]: 4 or 8</li>
        <li>Banks per bank group [8]</li>
        <li>Pseudo-channels per channel and DQs each [2 × 32]: 4 × 16</li>
      </ul>
      <p class="rnote">The tCCD_L value in the timing table (max of 4 nCK and 2.5 ns) also has to drop at higher rates: to 1 ns for 16 Gb/s with two bank groups. That changes a number in the table, not the structure.</p></div>
  </div>

  <h3>Rate rule</h3>
  <p>Each pseudo-channel moves one access per burst: <code>t<sub>B</sub> = access bits / (DQs × pin rate)</code>, which is tCCD_S. Bank groups take turns, so each group has <code>G × t<sub>B</sub></code> for its column cycle. tCCD_L comes from the staged model: the bank's CSL, LDL, MDL, IOSA and equalise steps, or the stages its group shares (OD-ECC + DBI, BG-BUS), whichever is slower.</p>
  <p>The IOSA placement is the main unknown, so every result is checked under three placements: one IOSA per bank; one per bank with a mid-bank column decoder; and one shared at the bank group's I/O control (the HBM3 calibration point, and the closest match to JEDEC's 2.5 ns HBM4 tCCD_L).</p>

  <h2>Keeping the HBM4 interface</h2>
  <p>2 pseudo-channels × 32 DQs, 32 B accesses, 2 bank groups × 8 banks. Each cell shows the smallest passing die, then the smallest with an aspect ratio of 1.3 or less.</p>
  <div class="rtbl"><table>
    <thead><tr><th>Pin rate</th><th>IOSA per bank</th><th>Per bank, mid-bank decoder</th><th>IOSA at I/O control</th></tr></thead>
    <tbody>
      <tr><td class="n">8 Gb/s</td><td class="n">127.0 mm² (2.48 : 1)<br>151.1 mm², 13.24 × 11.41</td><td class="n">125.6 mm² (1.69 : 1)<br>151.1 mm², 13.24 × 11.41</td><td class="n">152.8 mm², 13.24 × 11.54 (1.15 : 1)</td></tr>
      <tr><td class="n">16 Gb/s</td><td class="n">132.7 mm² (2.59 : 1)<br>157.5 mm², 13.24 × 11.90</td><td class="n">132.7 mm² (2.59 : 1)<br>157.5 mm², 13.24 × 11.90</td><td class="no">none</td></tr>
      <tr><td class="n">32 Gb/s</td><td class="no">none</td><td class="no">none</td><td class="no">none</td></tr>
      <tr><td>Fastest possible</td><td class="n">19.0 Gb/s</td><td class="n">19.0 Gb/s</td><td class="n">10.6 Gb/s</td></tr>
      <tr><td>Limited by</td><td>OD-ECC + DBI</td><td>OD-ECC + DBI</td><td>bank cycle (long MDL)</td></tr>
    </tbody></table></div>
  <ul>
    <li><b>32 Gb/s gives each bank group 0.5 ns per access.</b> OD-ECC + DBI alone takes 0.84 ns at this node (24 gate delays, inside tCCD_L as in HBM3). Even with ECC pipelined out of the loop, the bank's own cycle tops out near 26–29 Gb/s. No internal parameter in the sweep closes that gap.</li>
    <li><b>16 Gb/s costs about 4% more die than 8 Gb/s</b>, for twice the TSVs. It needs a 4 GHz clock and 2–4 GBUS copies instead of 1–2. Its tCCD_L is 0.84 ns against the 1.00 ns allowed. With the IOSA at the I/O control it fails at 10.6 Gb/s.</li>
  </ul>

  <h3>Smallest designs, bundled</h3>
  <p>The two smallest distinct organisations at each rate, under <b>Example designs → HBM4 interface scaling</b>. All keep the HBM4 interface and need an IOSA in every bank.</p>
  <div class="rtbl"><table>
    <thead><tr><th>Design</th><th>Organisation</th><th>tCCD_L</th><th>Die</th><th>Latency</th><th></th></tr></thead>
    <tbody>
      <tr><td class="n">8 Gb/s</td><td>16 × 1024-WL subarrays, 16 × 512-BL MATs, 8 MDLs, mid-bank decoder</td><td class="n">1.73 / 2.00 ns</td><td class="n">8.62 × 14.58 = 125.6 mm²</td><td class="n">100 ns</td><td>${load('hbm4if_8g_mid', 'Open')}</td></tr>
      <tr><td class="n">8 Gb/s</td><td>8 × 1024-WL subarrays, 16 × 1024-BL MATs coupled ×2, 16 MDLs, two channel rows</td><td class="n">1.88 / 2.00 ns</td><td class="n">7.15 × 17.77 = 127.0 mm²</td><td class="n">115 ns</td><td>${load('hbm4if_8g_bank', 'Open')}</td></tr>
      <tr><td class="n">16 Gb/s</td><td>8 × 1024-WL subarrays, 16 × 1024-BL MATs coupled ×2, 32 MDLs, two channel rows</td><td class="n">0.94 / 1.00 ns</td><td class="n">7.15 × 18.55 = 132.7 mm²</td><td class="n">119 ns</td><td>${load('hbm4if_16g_bank', 'Open')}</td></tr>
      <tr><td class="n">16 Gb/s</td><td>16 × 1024-WL subarrays, 16 × 512-BL MATs, 16 MDLs, mid-bank decoder</td><td class="n">0.84 / 1.00 ns</td><td class="n">8.62 × 15.53 = 133.8 mm²</td><td class="n">126 ns</td><td>${load('hbm4if_16g_mid', 'Open')}</td></tr>
    </tbody></table></div>

  <h2>Breaking the interface at 32 Gb/s</h2>
  <p>Each option keeps capacity and total DQs. Picks shown are the smallest die with an aspect ratio of 1.3 or less, preferring designs that pass under all three IOSA placements.</p>
  <div class="rtbl"><table>
    <thead><tr><th>Option</th><th>Passes under all three IOSA placements</th><th>Package-friendly pick</th><th>Latency</th><th>Power*</th><th>CA bus</th><th>GBUS copies</th></tr></thead>
    <tbody>
      <tr class="pick"><td><b>4 PCs × 16 DQ, 4 bank groups</b><br><span class="rnote">32 B access, 32 banks per channel as in HBM4</span></td><td class="yes">yes</td><td class="n">158.0 mm²<br>14.30 × 11.05, 1.29 : 1</td><td class="n">85 ns</td><td class="n">162 W</td><td class="n">100%</td><td class="n">2–4</td></tr>
      <tr class="pick"><td><b>64 B access, 4 bank groups</b></td><td class="yes">yes</td><td class="n">160.5 mm²<br>14.30 × 11.22, 1.27 : 1</td><td class="n">142 ns</td><td class="n">145 W</td><td class="n">50%</td><td class="n">2–4</td></tr>
      <tr><td>32 B access, 8 bank groups</td><td class="yes">yes</td><td class="n">158.0 mm²<br>14.30 × 11.05, 1.29 : 1</td><td class="n">93 ns</td><td class="n">206 W</td><td class="n">100%</td><td class="n">4–7</td></tr>
      <tr><td>32 B access, 4 bank groups</td><td class="yes">yes</td><td class="n">167.1 mm²<br>13.24 × 12.62, 1.05 : 1</td><td class="n">75 ns</td><td class="n">241 W</td><td class="n">100%</td><td class="n">4–7</td></tr>
      <tr><td>64 B access only ${load('g32_2bg_staged_bank', 'Open preset')}</td><td class="no">per-bank IOSA only</td><td class="n">160.4 mm²<br>14.30 × 11.21, 1.28 : 1</td><td class="n">93 ns</td><td class="n">115 W</td><td class="n">50%</td><td class="n">2–4</td></tr>
      <tr><td>4 PCs × 16 DQ, 2 bank groups</td><td class="no">per-bank IOSA only</td><td class="n">157.7 mm²<br>14.30 × 11.03, 1.30 : 1</td><td class="n">66 ns</td><td class="n">154 W</td><td class="n">100%</td><td class="n">2–4</td></tr>
    </tbody></table></div>
  <p class="rnote">* Worst case: every access a row miss, at the full 8.2 TB/s. CA bus is the column-command bus's busy share at an 8 GHz clock. GBUS copies are the alternating GBUS sets each needed to hold data for its minimum window, from Ryu et al.'s 1–2 ns at 16 nm, scaled to this node. The HBM4 reference in DreamRAM is 174 mm² at 8 Gb/s. The bundled 64 B preset is the smallest such die with 4 TSVs per DQ (149.4 mm², 1.37 : 1).</p>
  <ul>
    <li><b>Adding bank groups is what makes 32 Gb/s robust.</b> With 4 groups, each gets 2 ns per access instead of 1 ns. That's enough even with the IOSA shared at the I/O control. The wider-access-only and 4-pseudo-channel-only options pass only with an IOSA in every bank.</li>
    <li><b>4 pseudo-channels × 16 DQs with 4 groups is the closest to HBM4 for software.</b> It keeps 32 B accesses and 32 banks per channel, and has the lowest latency of the robust options. The cost is a column-command bus at 100% and an 8 GHz clock.</li>
    <li><b>64 B accesses with 4 groups halves the command load</b>, at a coarser access size and higher row-miss latency.</li>
    <li><b>32 B with 4 or 8 groups on 32 DQs</b> needs a 0.25 ns burst and 4–7 GBUS copies, and draws the most power.</li>
  </ul>

  <h2>Package friendliness</h2>
  <p>The smallest passing dies are long and thin, down to 7 × 20 mm at 32 Gb/s. They stack bank groups four or eight high and put the die's channels in two rows, which halves the width. The sweep can also place channels in one row (DreamRAM's layout) or in two rows (as in Samsung's ISSCC 2026 HBM4), and arrange bank groups side by side. Choosing those for shape gives dies of 1.05–1.29 : 1 at about 10–20% more area than the thinnest. The JEDEC HBM4 footprint is 14.175 × 10.975 mm (1.29 : 1).</p>
  <div class="rdies">${DIES.map(([name, sub, w, h, dims]) => `<figure class="rfig">${dieSvg(name, w, h)}<figcaption><b>${name}</b><span>${sub} · ${dims}</span></figcaption></figure>`).join('')}</div>
  <div class="rlegend"><span><i class="ldie"></i>die, to scale</span><span><i class="lfoot"></i>JEDEC HBM4 footprint, 14.175 × 10.975 mm</span></div>

  <h2>How far to trust this</h2>
  <ul>
    <li>One number is fitted: a gate delay of 43 ps at 16 nm, set so HBM3 cycles at 2 ns. The 24-gate-delay OD-ECC + DBI step, which sets the 19 Gb/s ceiling, is an assumption. Below about 18 gate delays (0.62 ns) the bank cycle becomes the limit instead, and the ceiling still stays below 30 Gb/s.</li>
    <li>The area of per-bank IOSAs and of extra GBUS copies is not counted, and neither is the clock and command bus at 8 GHz.</li>
    <li>Power is DreamRAM's worst case and scales with bandwidth. Every 32 Gb/s design draws 3–5× an 8 Gb/s HBM4 stack.</li>
    <li>DreamRAM's die model is calibrated to HBM3. Absolute areas are best read as comparisons with its own HBM4 reference (174 mm²).</li>
  </ul>

  <h2>Reproduce</h2>
  <pre>python3 tools/sweep_interface.py --dreamram /path/to/DreamRAM --rates 8,16,32 --csv out.csv
# package-friendly only:
python3 tools/sweep_interface.py --dreamram /path/to/DreamRAM --rates 32 --max-aspect 1.3</pre>
</article>`;

  let rendered = false;
  DR.renderReport = function (container) {
    if (rendered) return;
    container.innerHTML = HTML();
    rendered = true;
  };
})();
