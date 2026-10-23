# DreamRAM Floorplan Viewer

An interactive floorplan viewer for [DreamRAM](https://github.com/harvard-acc/DreamRAM) (Cai et al., DATE 2026). It draws the core die of a 3D-stacked DRAM design, to scale, from DreamRAM's own area model. You can move up and down the hierarchy and show or hide each kind of component:

**Stack → core die → channel → pseudo-channel → bank group → bank → subarray → MAT**

It needs no build step and has no dependencies. It is a static page with plain JavaScript and a canvas.

## Running it

```bash
python3 tools/serve.py
```

Then open <http://localhost:8813/>. You can also open `index.html` directly from disk.

### Navigating

| Action | How |
| --- | --- |
| Select a component | Click it (details appear in the **Selection** panel) |
| Go down one level | Double-click, press **Enter** on a selection, or click a node in the **Hierarchy** tree |
| Go up one level | **Backspace** / **Esc**, the **↑ Up** button, or a breadcrumb |
| Free zoom / pan | Scroll wheel / drag (**F** re-fits the current level) |
| Show / hide components | The **Components** panel, the legend of the die-area bar, or **Hide …** in the selection panel |
| Labels on/off | **L** |
| Column-read wave diagram | The **Timing** tab (see [below](#timing-tab)) |

Each level dims everything outside the focused component. Drawing switches automatically between level-of-detail stages, so the whole die (~100k MATs) stays responsive.

### What you can see

- **Stack**: an exploded view of the core dies plus the base die, coloured by SID, with each die's channels.
- **Die**: channels, pseudo-channels, bank-group columns, control stripes, per-bank-group I/O control, per-column GBUS CTRL blocks and the TSV region. The TSV region has DWORD (data) blocks under each pseudo-channel, AWORD (command) blocks in each channel gap, and power/keep-out bands. Zoom in to see individual TSVs, coloured by purpose: row/column command-address, clocks, CKE, data (MDL bits), MD-ECC, DBI, SEV/flags, WCK and power. This die's channels are drawn solid and the rest faded; hovering a TSV names its purpose and channel. Selecting the TSV region, a TSV array or a channel shows the allocation table, per channel and for the whole stack, using the terms of `Hbm.calc_stack_dims`.
- **Bank group**: the I/O control block in the middle, with the banks on each side mirrored so their column decoders face it, and the BG-BUS starting there.
- **Bank**: row and column decoders, the corner block, dummy half-subarrays, subarray rows, SALP buffer rows, data and ECC MATs (MD-/OD-ECC), BLSA and LWD stripes, and row-page partitions (subchannels / half-page).
- **MAT**: the cell array with WL/BL/MWL. The CSL/MDL/LDL routing follows the configured scheme:
  - `0`: MDLs over the LWDs, CSLs over the MAT
  - `1`: DLOMAT, with MDLs over the MAT, CSLs over the LWDs, and LDLs becoming LSLs
  - `3`: both over the MAT, on a shared layer or on separate layers

  Hovering a wire shows its index, pitch and pitch ratio versus the baseline.
- **Overlays**:
  - BG-BUS (from each I/O control to its GBUS CTRL) and the two alternating GBUS sets per pseudo-channel.
  - An example ACT + RD path: the activated page and MWL, then MDLs → column decoder → I/O control → BG-BUS → GBUS CTRL → GBUS → DWORD TSVs.
  - **OD-ECC codewords (A / B)**: which codeword each MAT's 8-bit symbols belong to. Selecting an LWD stripe shows the bounded error a driver fault causes and whether the codewords can correct it.

The right panel holds:
- every DreamRAM design parameter, with the default sweep ranges;
- live metrics: capacity, bandwidth, row-miss latency, die size, stack area, cell efficiency, and more;
- per-bank-group data rate: one 256-bit atom per tCCD_L (DreamRAM's `tccdl` = core tCK × pumps). Same-group column commands share the group's I/O control and BG-BUS, so a pseudo-channel reaches DreamRAM's peak only with groups alternating every tCCD_S. The panel shows how many groups that takes (2 in every bundled design except the 8-pump subchannel one) and flags designs with fewer. DreamRAM's own bandwidth assumes the groups are there; its `bgbuses_per_gbus` = 2 factor does not check `vert_bg × horiz_bg`;
- an exact die-area breakdown;
- the list of DreamRAM filters that would discard the current design (`dreamram.simulate()` status codes 1–15).

The URL hash stores the design, so a link reproduces it.

## Exact geometry from DreamRAM

`js/model.js` ports DreamRAM's physical model (`hbm.py`, `tech.py` and the filters in `dreamram.py`) to the browser, so parameters can change live. To get numbers straight from the simulator, and to cross-check the port, export a design with DreamRAM itself:

```bash
python3 tools/export_floorplan.py --dreamram /path/to/DreamRAM -o my_design.json \
    --set channels=32 --set subchannels=4 --set brvsa=1
# or take a design point from a sweep CSV:
python3 tools/export_floorplan.py --dreamram /path/to/DreamRAM --csv data/<label>/hbm3_<label>.csv --row 123 -o pt.json
```

Load the JSON with **Load DreamRAM export…**, or drag it onto the page. The viewer then shows DreamRAM's energy and power numbers, and a **Port vs. DreamRAM** table comparing every dimension and timing value. The exporter builds the design exactly like `dreamram.py` does: same baseline references, same timing overrides, and `simulate()` for the metrics and the discard status.

The examples in `examples/` were produced this way and bundled into `js/examples.js` with `python3 tools/build_examples.py`.

**Validation.** The port matches DreamRAM to floating-point precision (relative error ≤ 2e-16) on all bundled examples. The checks cover bank_x/y, die width/height, TSV heights, cell efficiency, total area, bandwidth, tCL, tRCD and tRP. 80 random sweep points were also checked. On the 61 that DreamRAM can evaluate, geometry and the discard status code match too. The other 19 make DreamRAM raise an error, and the port flags all of them with status 2. The HBM3 baseline reproduces the README values: 1024 GB/s, 64 ns, 1030.19 mm².

## HBM4 (1 SID) model

Choose **Example designs → HBM4 · 1 SID** to load it. A coupled-row variant is described below. It maps JESD270-4 onto DreamRAM's parameters and uses a 34 nm WL / 36 nm BL array.

**Organization** (JESD270-4 §3, Tables 1, 4 and 5; 32 Gb 4-high)

| DreamRAM parameter | Value | Source |
| --- | --- | --- |
| `sids` | 1 | 4-high stack (SID[0]=1 is invalid at 4H) |
| `channels`, `ch_per_die` | 32, 8 | Up to 32 channels; 4 dies are needed for 32 channels |
| `pch` | 2 | 32-DQ pseudo-channels |
| `vert_bg × banks` | 2 × 8 | 16 banks per PC, BA[3:0], grouped A/B (banks 0–7, 8–15) |
| `subarrays × mat_rows` | 32 × 512 | 16 K rows per bank (RA[13:0]) |
| `mats × mat_cols` | 16 × 512 | 1 KiB row per PC (8 Kib), matching the 1 KB page |
| `ldls_mdls` | 16 | 16 MATs × 16 MDLs = 256 bits per pump, so one pump fills an atom (8 MDLs would need 2 pumps and halve the DQ count) |
| `atom_size` | 256 | 256-bit prefetch per PC (BL8 × 32 DQ) |

This adds up to 16 banks × 16 K rows × 8 Kib = 2 Gb per PC, 4 Gb per channel and 16 GB per stack. It also gives 2,176 DQs (2,048 data + 128 ECC), matching 2 ECC pins per 32 DQs.

The 1 KiB row could also be built as 32 MATs × 256 BL, but DreamRAM rejects that design because its column-select lines get too tight (status 15). Keeping 512 × 512 MATs means the MAT size follows directly from the pitches.

**Technology** (`configs/tech/hbm4_34wl_36bl.json`)
- `wlp` = 0.034 µm and `blp` = 0.036 µm, so a cell is 1,224 nm². A 512 × 512 MAT is then 18.7 × 17.7 µm (including DreamRAM's 1.5% isolation overheads).
- Every other parameter is DreamRAM's: decoder, BLSA and SWD tile sizes; capacitances; TSV and µbump pitch; ECC overheads; scaling confidences.
- DreamRAM scales the peripheral tiles and capacitances by (f / 26 nm)^conf, so `f` must also be chosen. It keeps DreamRAM's ratio of f to cell area (16 nm for a 41 × 47 nm cell): f = 16 nm × √(34·36 / (41·47)) = **12.75 nm**.

**Results** (exported with `tools/export_floorplan.py`)
- Bank: 452 × 903 µm. Die: 8.62 × 17.92 mm (154.3 mm²); stack area 771.7 mm²; cell efficiency 34.4%.
- 1,535 GB/s at 6.0 Gb/s per pin (core tCK 2.67 ns); 79.8 ns row-miss latency (tCL 46.5 + tRCD 16.6 + tRP 16.6).
- 3.36 pJ/b (closed row) and 2.41 pJ/b (streaming); 41.3 W worst case.

**Caveats**
- **Die height.** DreamRAM stacks each pseudo-channel's 16 banks in one column, 8 above and 8 below the TSV region. With 16 K rows per bank, the die is 17.9 mm tall, over DreamRAM's 13 mm limit. The bundled export was made with `--max-die-mm 18` so `simulate()` still reports metrics; the in-browser preset keeps the 13 mm limit and shows the status-11 warning. JESD270-4 leaves the floorplan to the vendor, but DreamRAM's die template has no other way to place the banks.
- **Timing.** DreamRAM computes timing relative to the HBM3 baseline evaluated at the *same* node. This bank is twice as tall as that baseline bank (32 vs 16 subarrays), so the CSLs and MDLs run twice as far. That stretches core tCK from 2 ns to 2.67 ns and drops the pin rate to 6 Gb/s. The die is also taller, which lengthens tCL. The model does not include any speed-up from the newer node itself.

To reproduce the export:

```bash
python3 tools/export_floorplan.py --dreamram /path/to/DreamRAM -t configs/tech/hbm4_34wl_36bl.json --max-die-mm 18 \
    --set sids=1 --set channels=32 --set ch_per_die=8 --set vert_bg=2 --set banks=8 \
    --set mats=16 --set mat_cols=512 --set ldls_mdls=16 --set subarrays=32 -o examples/hbm4_1sid_4h.json
python3 tools/build_examples.py
```

### HBM4 with coupled rows

JESD270-4 Table 4, note 3 says the RA MSB "is used to select half of open 2 KB page". That describes coupled rows (see below), so the second HBM4 design (**HBM4 · 1 SID · coupled rows**) models it directly:

| | |
| --- | --- |
| Physical row | 8 K wordlines per bank, each 2 KiB (32 MATs × 512 BL); `subarrays` = 16 |
| Host-visible rows | 16 K rows of 1 KiB (RA[13:0]), MSB coupling |
| `ldls_mdls` | 16, so one coupled half (16 MATs × 16 MDLs) delivers a 256-bit atom per pump |
| `pages_per_bgbus_mux` | 2: the two halves share one BGBUS |

Results (DreamRAM export, die limit relaxed to 16 mm):
- Die: 15.10 × 10.28 mm, the same width problem as the 2 KiB-row variant.
- 2,117 GB/s at 8.27 Gb/s; 63.7 ns row-miss latency.
- 3.12 / 1.79 pJ/b (closed row / streaming); 52.8 W worst case.

### Samsung HBM4 organisation (ISSCC 2026)

Samsung's ISSCC 2026 paper 15.6, "A 36GB 3.3TB/s HBM4 DRAM with Per-Channel TSV RDQS Auto Calibration…", is 12-high with "8 channels per slice, 4 slices per rank". Its core-die photo places four channels above the TSV band and four below, each channel entirely on one side. DreamRAM's template can't express that: it splits every pseudo-channel's bank groups across both sides, which is why our 8-channel HBM4 die came out 15 mm wide. The new `channel_rows` extension (implemented in both the port and the exporter) adds Samsung's arrangement:
- `1` (default) is DreamRAM's template.
- `2` puts half the die's channels on each side, each with all of its bank groups. `Hbm.bankdie_dims` becomes `ch_per_die / 2` channels across and twice the bank-group height. DreamRAM's own wire-length, TSV and tCL formulas then follow from the new die dimensions.

Two designs model the Samsung organisation. Both use JESD270-4's 24 Gb 12H column (3 SIDs × 4 dies, 8 channels per die, 16 banks per PC per die, 12 K host rows of 1 KiB) and 34/36 nm WL/BL pitches:
- **Samsung HBM4 · coupled rows** (preset, plus an export with the die limit relaxed to 18 mm): 2 bank groups × 8 banks, 6 K coupled 2 KiB wordlines.
- **Samsung HBM4 · 1 KiB rows, banks 2 wide** (export): `horiz_bg` = 2 × 8 banks, 12 K wordlines of 1 KiB.

| | Our HBM4 (1 SID, coupled, 1 row) | Samsung org, coupled, 2 × 8 banks | Samsung org, 1 KiB rows, banks 2 wide | Slide (measured) |
| --- | --- | --- | --- | --- |
| Dies / capacity | 4 / 16 GB | 12 / 36 GB | 12 / 36 GB | 12 / 36 GB |
| Die (w × h) | 15.10 × 10.28 mm | 7.55 × 17.08 mm | 8.62 × 14.72 mm | |
| Die height / width | 0.68 | 2.26 | 1.71 | 1.11 |
| TSV + GBUS band, share of height | 18.8% | 21.0% | 21.6% | 21.4% |
| Channel box height / width | | 3.58 | 2.68 | 1.77 |
| Bandwidth | 2,117 GB/s @ 8.27 Gb/s | 2,339 GB/s @ 9.14 Gb/s | 1,780 GB/s @ 6.95 Gb/s | 3.3 TB/s (~12.9 Gb/s) |
| Row-miss latency | 63.7 ns | 83.9 ns | 74.5 ns | |
| Stack area | 776 mm² | 1,677 mm² | 1,649 mm² | |

What the comparison shows:
- **The centre band matches the slide** (21% vs 21.4%).
- **No tiling matches the shape.** The die and channel aspect ratios fall between the two tilings. With DreamRAM's bank template (one full-width row per bank, decoders at the edges), a 128 Mib bank is either wide and short (2 KiB rows) or narrow and tall (1 KiB rows). Matching the photo would need a near-square bank or banks split into sub-banks, which DreamRAM does not model.
- **Bandwidth falls short of 3.3 TB/s.** DreamRAM calibrates core tCK to the HBM3 baseline at the same node. Its pin rate follows from bank geometry, not from HBM4's faster I/O, so it cannot reach Samsung's figure.
- **The base die is not modelled.** The slide shows its PHY / TSV / DA / MBIST & IEEE1500 regions, but DreamRAM does not floorplan the base die.

### HBM5 exploration: 2× DQs, 2× channels per die, same concurrency

The scenario is a hypothetical HBM5 with twice HBM4's DQ pins and twice its channels per die, kept to 4 dies and 1 SID. It is compared with our HBM4 coupled-row design at the same die density. Concurrency is kept: every pseudo-channel still has **2 bank groups × 8 banks**, as in HBM4. The only thing given up is rows: each die now has 512 banks, so at 32 Gb per die each bank holds 64 Mib, or **8 K host rows of 1 KiB instead of 16 K**. The row size is unchanged.

**Fixed parameters**
- 64 channels, 16 per die, 2 pseudo-channels each.
- 4,352 DQs (4,096 data); each pseudo-channel keeps 32 DQs and one 256-bit pump per atom.
- 16 GB per stack.
- 34/36 nm array.
- At least 8 Gb/s.

**Search.** Every bank organisation meeting those constraints was run through DreamRAM's exporter **with the BG-BUS-limited tCCD_L extension on** (`tccd_bgbus` = 1, see below). The sweep covered:
- bank-group tiling: 2 vertical, or 2 side by side;
- MAT size, MAT count, MDLs, MDL/CSL routing and layer sharing;
- BLSA vs BRVSA;
- coupled rows;
- 1 or 2 channel rows.

That gave 490 valid designs; 204 have 1 KiB rows and 83 of those still run at ≥ 8 Gb/s once the shared bus is a pipeline stage. **None fits DreamRAM's 13 mm die limit.** Two-channel-row layouts drop out: each channel's bank groups all sit on one side, so its BG-BUS is 5–8 mm long and sets tCCD_L. Four designs are in **Example designs → HBM5 exploration**, each exported with the extension on and a die limit just above its size:

| | HBM4 (reference) | Smallest die | HBM4 latency | Lowest latency | HBM4 MATs + coupled 2 KiB WL |
| --- | --- | --- | --- | --- | --- |
| Banks / PC, rows / bank | 16, 16 K | 16, 8 K | 16, 8 K | 16, 8 K | 16, 8 K |
| Bank groups | 2 vertical | 2 vertical | 2 vertical | 2 side by side | 2 vertical |
| Bank organisation | 32 × 512-BL MATs, coupled, 16 × 512 WL | 16 × 512-BL MATs, 8 × 1024 WL, 2 CSL/MDL layers | 16 × 512-BL MATs, 16 × 512 WL, 2 layers | 16 × 512-BL MATs, 8 × 1024 WL, 2 layers, BRVSA | 32 × 512-BL MATs, coupled, 8 × 512 WL |
| Channel rows | 1 | 1 | 1 | 1 | 1 |
| Die | 15.10 × 10.28 mm = 155.3 mm² | 17.23 × 11.15 mm = 192.2 mm² (+24%) | 17.23 × 11.52 mm = 198.5 mm² (+28%) | 34.46 × 5.80 mm = 199.7 mm² (+29%) | 30.21 × 7.08 mm = 214.0 mm² (+38%) |
| TSV region | 25.0 mm² | 49.9 mm² | 49.9 mm² | 50.1 mm² | 50.0 mm² |
| Column stages (bank / BG-BUS) | 1.93 / 2.01 ns (not enforced) | 1.74 / **1.94** ns | 1.80 / **1.98** ns | **1.76** / 1.52 ns | 1.57 / **1.64** ns |
| Data rate / bandwidth | 8.27 Gb/s · 2,117 GB/s | 8.24 Gb/s · 4,220 GB/s | 8.07 Gb/s · 4,130 GB/s | 9.12 Gb/s · 4,668 GB/s | 9.79 Gb/s · 5,010 GB/s |
| Row-miss latency (tCL + tRCD + tRP) | 63.7 (27.7 + 18 + 18) | 82.5 (29.4 + 26.6 + 26.6) | 63.6 (30.3 + 16.6 + 16.6) | 57.3 (15.6 + 15.1 + 26.6) | 55.3 (19.3 + 18 + 18) |
| Energy / bit (closed / stream) | 3.12 / 1.79 pJ | 3.01 / 1.79 pJ | 2.68 / 1.81 pJ | 2.56 / 1.43 pJ | 2.78 / 1.50 pJ |
| Worst-case power | 53 W | 102 W | 88 W | 96 W | 111 W |

Takeaways:
- **The die grows 24–38%.** About 25 mm² comes from the doubled TSV region (every channel's TSVs on every die). The rest is per-bank overhead: twice as many banks, each with its own decoders, dummy and edge rows, and an I/O-control share, over the same total number of cells.
- **One channel row, bank groups stacked vertically, 1 KiB rows wins on area.** Each pseudo-channel's two groups sit one on each side of the TSVs, so the BG-BUS stays about 4 mm long (bus stage under 2 ns). Halving the rows per bank makes the 1 KiB-wide bank (16 MATs × 512 BL) short enough to stay fast.
- **Matching HBM4's latency costs about 28% area.** 512-WL MATs keep tRCD/tRP at 16.6 ns; 1024-WL MATs save 3% area but add 10 ns to each.
- **Lower latency needs very wide dies.** Placing the two groups side by side (shorter bus, smaller tCL) with BRVSA reaches 57 ns, and HBM4's coupled 2 KiB wordline reaches 55 ns and 9.8 Gb/s. Both make 30–34 mm wide dies at similar or larger area.
- **The pin rate is DreamRAM's estimate,** set by the slower column stage relative to its HBM3 calibration. The BG-BUS stage is a pessimistic bound for long buses, which real designs retime.

## Extensions: coupled rows and paired edge subarrays

These are not part of DreamRAM. Both are implemented twice, kept in sync and cross-checked:
- in the in-browser port;
- in `tools/export_floorplan.py`, as a subclass of DreamRAM's `Hbm` (`--set coupled_rows=2 --set edge_pairing=1`).

With both options off, the exporter reproduces DreamRAM bit-for-bit. With them on, the port matches the extended exporter on all bundled examples and on 60 random sweep points: geometry, discard codes, command bits, page size, bandwidth and latency.

**Coupled rows** (`coupled_rows` = C; `coupled_lsb` selects the address mapping)

C host-visible rows share one physical wordline, and one ACT/PRE drives all of them. DDR4 ×4 parts show MSB coupling (Row[i] ↔ Row[i + N/2]); some LPDDR4 parts show LSB coupling (adjacent rows). In DreamRAM terms, coupled rows are a column-side page split with no activation split:

| Quantity | What changes |
| --- | --- |
| Host page, column datapath | Divided by C: `ind_pages`, `page_act_size`, `min_atom` and `mdl_width_per_page`. A READ reaches only the addressed row's MATs, so it fires C× fewer CSLs, and the atom/pump filters apply to the host page. |
| Activation | Unchanged (`ind_row_pages`): every MAT's LWLs and bitlines still fire, so ACT/PRE energy is that of the full wordline. |
| Row address | log2(C) extra host-visible bits. Column bits drop with the smaller page. |
| Shared datapath | Only one coupled row is read at a time. Data TSVs count MDLs of one host row (`mats × ldls_mdls / C`), and per-access DQs and tBURST use the channel's DQs rather than C separate pages. |
| Area | The die geometry is unchanged, apart from fewer data TSVs. |

In the viewer, **Coupled-row halves** colours each wordline's halves (blue, rose, …). The selection panel lists the host rows a subarray or MAT holds and which rows they are coupled with. The **Example ACT + RD path** overlay shows the whole wordline opening, with data read out of the target half only.

To keep a full atom per pump, give each half enough MDLs (e.g. 32 MATs × 16 MDLs / 2). With 8 MDLs, a coupled HBM3 bank needs 2 pumps and bandwidth halves.

**Paired edge subarrays** (`edge_pairing` = 1)

In an open-bitline array, the two edge subarrays have no sense amps on their outer side, so only every other bitline in them is sensed. Instead of discarding them, the far and near edge subarrays are activated together, and their live halves form one row. This replaces DreamRAM's two dummy half-subarrays (`dummy_subarray_height` → 0). The `subarrays + 1` cell rows and `subarrays + 1` BLSA stripes are left as DreamRAM counts them.

On the HBM3 baseline, this saves one MAT height per bank: die height 11.79 → 11.44 mm, stack area 1030 → 1000 mm². The viewer hatches the edge rows, dashes their dummy bitlines at MAT level, and draws a bracket joining each pair.

## Die organisation from the Samsung HBM3 paper

DreamRAM's HBM3 baseline is Ryu et al., "A 16 GB 1024 GB/s HBM3 DRAM With Source-Synchronized Bus Design and On-Die Error Control Scheme for Enhanced RAS Features", JSSC 2023 (DreamRAM reference [4]). The viewer follows that paper's Fig. 3 core-die organisation. All four changes below also apply to the HBM4 designs, because they are derived from the same parameters.

| Feature | What the viewer does | Source |
| --- | --- | --- |
| **I/O control** | One block in the middle of each bank group, e.g. A0, A1 \| I/O control \| A2, A3. The banks on each side are mirrored so their column decoders face it. HBM4's 8 banks per group split 4 \| 4. | The paper puts "I/O controllers for sensing or driving data" in the array region. Fig. 7 places the shared OD-ECC + DBI logic between the uncorrected bus (272 + 32 check bits) and the bus driven out (272 + 32 DBI flags). DBI exists to cut BG-BUS power, and tCCDL includes the OD-ECC computation time, so this logic sits at each group's I/O control, before the BG-BUS. Its height is DreamRAM's per-group OD-ECC height (1% of the baseline bank, about 6 µm) unless the `ioctl_h` extension sets it; the paper gives no size. |
| **GBUS CTRL** | DreamRAM's MBUS/periphery height is drawn as one block per bank column on each side of the TSV region. Two GBUS sets (ADL) run between them through the column's DWORD block. | Fig. 3; Fig. 4 for the alternating GBUS sets. |
| **Aligned TSVs** | Each pseudo-channel column gets a DWORD block of data TSVs. The AWORD command TSVs sit in the gap between a channel's mirrored columns (DreamRAM's control-stripe gap). Every die carries the TSVs of all channels stacked at that position: this die's channel is drawn solid, the others faded. | Fig. 3. Block widths split each channel slice by TSV count, so total TSV area is DreamRAM's. AWORD blocks spread beyond the stripe gap when the command TSVs need more room. |
| **OD-ECC codewords** | Each access reads `ldls_mdls` bits from each active MAT. 8-bit symbols are split over two Reed–Solomon codewords so that an LWD fault, which corrupts the local wordline in the MATs on both sides, costs each codeword as few symbols as possible. | Sec. III-A, Fig. 5. |

The codeword model checks out on both designs:
- **HBM3 baseline:** 38 MATs × 8 bits gives 2 × RS(19,17), the paper's code. An LWD fault is a 16-bit error with one symbol per codeword, so it is correctable.
- **HBM4 designs (16 MDLs per MAT):** an LWD fault becomes 32 bits, two symbols per codeword, so the same scheme cannot correct it. The exception is a fault between the two halves of a coupled row, which lands in two separate accesses.

Other findings from the paper:
- DreamRAM's HBM3 area target of 121 mm² equals the paper's 11 × 11 mm package ("MPGA cube") footprint; the core-die area is not given.
- The core-die photo (Fig. 11a), measured roughly, suggests DreamRAM's TSV/periphery band is too thin (about 14% of die height, vs about 20% in the photo) and its banks too tall.
- The 1/16 metadata + 1/8 OD-ECC cell overheads match exactly.

`ioctl_h` (µm per bank group, 0 = DreamRAM) is a new extension in both the port and `tools/export_floorplan.py`. It overrides `Hbm.od_ecc_height`. For example, `ioctl_h=100` gives a 12.16 mm die and 64.9 ns latency on the HBM3 baseline; the port matches DreamRAM exactly.

**BG-BUS-limited tCCD_L** (`tccd_bgbus` = 1)

**What it changes.** DreamRAM sets the core column cycle, and with it tCCD_L/S, the pin rate and bandwidth, from one pipeline stage only: the in-bank CSL + MDL path (`Hbm.core_tck`). The bank group's shared BG-BUS only affects tCL and energy. But tCCD_L is the occupancy window of that shared path: a new access can start every tCCD_L, while each one takes about tCL to come out. Ryu et al. say it is set by "core cycle time and OD-ECC computation time".

**How it works.** With this extension, the column cycle is the slower of two stages:
- **Bank column path:** `Hbm.core_tck`, unchanged.
- **BG-BUS window:** a repeated wire, so delay is linear in length times its pitch-dependent capacitance. It uses DreamRAM's own bus length (`wire_lengths()['bgbus+gbus']` = half the bank-area height) and BG-BUS capacitance ratio (as in tCL). It is calibrated like the bank path, `1 ns + (2 ns − 1 ns) × L·C / L_baseline`, so both stages are exactly 2 ns on the HBM3 baseline.

The metrics panel shows both stage times and which one limits. The port matches the exporter to ≤ 2.5e-16. OD-ECC/DBI logic time is not scaled, because DreamRAM has nothing to scale it with.

**Re-evaluation** (bundled designs, extension on):

| Design | Bank stage | BG-BUS stage (bus length) | Pin rate | Bandwidth | Power |
| --- | --- | --- | --- | --- | --- |
| HBM3 baseline | 2.00 ns | 2.00 ns (5.2 mm) | 8.00 → 8.00 Gb/s | 1,024 → 1,024 GB/s | 36 → 36 W |
| HBM4 1 SID, 1 KiB rows | 2.67 | 2.71 (7.5 mm) | 6.00 → 5.90 | 1,535 → 1,510 | 41 → 41 |
| HBM4 1 SID, coupled | 1.93 | 2.01 (4.3 mm) | 8.27 → 7.96 | 2,117 → 2,039 | 53 → 51 |
| Samsung org, coupled (2 rows) | 1.75 | 2.61 (6.9 mm) | 9.14 → 6.13 | 2,339 → 1,568 | 91 → 61 |
| Samsung org, 1 KiB, banks 2 wide | 2.30 | 2.41 (5.9 mm) | 6.95 → 6.64 | 1,780 → 1,700 | 61 → 58 |
| HBM5 · HBM4 MATs + coupled (2 rows; replaced) | 1.57 | 2.24 (5.3 mm) | 10.20 → 7.15 | 5,224 → 3,661 | 141 → 99 |
| HBM5 · smallest die (2 rows; replaced) | 1.74 | 2.85 (8.1 mm) | 9.20 → 5.61 | 4,708 → 2,873 | 149 → 91 |
| HBM5 · near-smallest, 1 row (now "smallest die") | 1.74 | 1.94 (4.1 mm) | 9.20 → 8.24 | 4,708 → 4,220 | 113 → 102 |
| HBM5 · HBM4 latency, 1 row | 1.80 | 1.98 (4.3 mm) | 8.87 → 8.07 | 4,541 → 4,130 | 97 → 88 |

Takeaways:
- **Two-row layouts lose the most.** Each channel stacks all its bank groups on one side, so its BG-BUS is long and becomes the bottleneck.
- **The HBM5 picks change.** Re-sweeping HBM5 (2 bank groups × 8 banks, 8 K rows, ≥ 8 Gb/s) with the extension on leaves 83 of 172 designs. The two-row "smallest die" and "HBM4 MATs" designs above no longer reach 8 Gb/s; the HBM5 exploration set has been re-exported with the extension (see the HBM5 section).
- **Fewer bank groups per column is penalised.** DreamRAM's capacitance ratio assumes wire width grows with pitch, so a BG-BUS spread wider than the baseline's (fewer bank groups per column) gets *more* capacitance. That is why the HBM4 coupled design's BG-BUS stage (2.01 ns) slightly exceeds the baseline's despite a shorter bus.
- **This is a pessimistic bound for long buses.** Real designs retime and source-synchronise these buses (Ryu et al.'s ADL / GBUS-SEL tracking), and Samsung ships a two-row HBM4 at 3.3 TB/s.

## Extensions: column-cycle model, bank-group cap, TSV accounting

These five options are implemented in both the port and `tools/export_floorplan.py` (`--set key=value`). All default to DreamRAM. With them off, every bundled example is unchanged. Checked on 83 points (3 presets and 80 random designs with these and the earlier extensions set at random): the discard code agrees on all 83, and the 60 that DreamRAM keeps match to ≤ 3.4e-16 in geometry, bandwidth, timing and TSV/DQ counts. DreamRAM raises on 11 others; the port flags all of them with the same status 6.

**Column-cycle model** (`tck_fixed`, `tck_fixed_scale`, `tck_wire`)

DreamRAM's core column cycle is `driver + (2 ns − driver) × wire ratio`. The driver time is a constant 1 ns ("minimum timing for CSL, LDL, MDL, and precharging"). The wire ratio is the CSL/MDL capacitance × bank height plus the LDL term, relative to the HBM3 baseline. So no bank can cycle faster than 1 ns, and the node never speeds anything up. The extensions change this:
- `tck_fixed` (ns) sets the fixed share as at the 16 nm HBM3 node. Values: 1 (DreamRAM), 0.75, 0.5, 0.25, or 0 for pure wire scaling. The wire share becomes `2 ns − tck_fixed`, so the HBM3 baseline still cycles at 2 ns.
- `tck_fixed_scale = 1` scales the fixed share with the logic node, `(f / 16 nm)^0.9`, as DreamRAM scales its peripheral tiles. On the 34/36 nm HBM4 array, 0.5 ns becomes 0.41 ns.
- `tck_wire = 2` treats the in-bank CSL/MDL/LDL lines as unrepeated RC wires, so their delay grows with length² instead of length × capacitance.

The fixed share applies to both column stages (bank path and, with `tccd_bgbus`, the BG-BUS window). The wire-length law applies to the bank path only, since the BG-BUS is modelled as repeated.

**Bank-group cap** (`bw_bg_cap = 1`)

Bandwidth is capped at bank groups × one atom per tCCD_L per pseudo-channel. Without the cap, DreamRAM's peak assumes `bgbuses_per_gbus` groups exist whether or not they do. The metrics panel shows the uncapped peak beside the capped value.

**TSV accounting** (`tsv_chain = 1`)

DreamRAM counts each channel's data TSVs as `ldls_mdls × mats`, which is one pseudo-channel's MDL bits. That count ignores `gbus_tsv_sd` and the second pseudo-channel, so the TSV region doesn't respond to the TSV serialization ratio. With `tsv_chain`, data TSVs are `pch × GBUS bits / gbus_tsv_sd` per channel, with MD-ECC and DBI in proportion. `gbus_tsv_sd` may then go below 1: ½ means two TSVs per GBUS wire, each at half the rate.

On the HBM3 baseline this doubles the data TSVs per die (5,248 → 10,112) and the TSV region (12.7 → 22.0 mm²). On the HBM4 coupled design they go 10,496 → 20,224 and 25.0 → 43.7 mm².

**Wider serdes choices.** The parameter panel now offers:
- `mdl_bgbus_sd`: 1–4
- `bgbuses_per_gbus`: 1–16
- `bgbus_gbus_sd`: 1–4
- `gbus_tsv_sd`: ¼–4
- `tsv_dq_sd`: 1–32

The panel also lists the per-pseudo-channel datapath as wires × Gb/s per wire at each level: BG-BUS, GBUS, TSV, DQ.

## 32 Gb/s exploration: 32 data DQs per pseudo-channel

```bash
python3 tools/sweep_pin_rate.py --dreamram /path/to/DreamRAM [--rate 32] [--max-die-mm 20] [--csv out.csv]
```

This asks which bank organisations reach a target pin rate. Every design is evaluated by DreamRAM itself, through `tools/export_floorplan.py` and its extensions, so it needs only Python and a DreamRAM checkout; the default sweep (all eight column-cycle models) takes about 10 s. Options widen the search: `--bank-groups` (vertical × side-by-side pairs, e.g. `2x1,1x2`), `--banks`, `--mats`, `--ldls`, `--atoms` (column access size in bits) and `--models` (column-cycle models to run).

**Fixed:**
- HBM4 34/36 nm array, 1 SID, 32 channels on 4 dies, 2 pseudo-channels;
- 16 GB per stack, 1 KiB host rows, 256-bit atoms, one channel row;
- `tccd_bgbus`, `bw_bg_cap` and `tsv_chain` on.

**Swept** (1,206 valid designs): bank groups (2–8 vertical × 1–2 side by side), banks per group, MAT size and count, MDLs, MDL/CSL routing, BLSA/BRVSA and coupled rows. Subarrays per bank follow from the capacity.

**How each design is set up:**
- It keeps 32 data DQs per pseudo-channel, with all its bank groups alternating onto the GBUS. Its pin rate is then 8 × bank groups / tCCD_L (Gb/s, per atom pump).
- The GBUS→TSV vs. TSV→DQ split leaves the pin rate unchanged and only moves TSV count and area, so it is reported separately.
- The HBM4 reference is the coupled-row design. With chain-counted TSVs its die is 174.0 mm².

| Column-cycle model | HBM4 tCCD_L | Fastest tCCD_L | Designs ≥ 32 Gb/s | Smallest such design | Its tCCD_L | Die vs. HBM4 |
| --- | --- | --- | --- | --- | --- | --- |
| DreamRAM (1 ns fixed, C × L) | 2.01 ns | 1.92 | 28 | 8 × 2 BGs × 2 banks, 16 × 512-BL MATs, 1024 WL | 3.49 (BG-BUS) | 187.0 mm² (+7%) |
| 0.5 ns fixed, node-scaled, C × L | 1.92 | 1.78 | 8 | 8 × 2 BGs × 2 banks, 32 × 256-BL MATs | 3.71 (BG-BUS) | 196.2 (+13%) |
| 0.5 ns fixed, node-scaled, L² | 1.92 | 1.75 | 8 | same | 3.71 (BG-BUS) | 196.2 (+13%) |
| No fixed time, C × L | 2.02 | 1.84 | 0 | | | |
| 0.5 ns fixed, node-scaled, bank path only (no BG-BUS window) | 1.81 | 0.91 | 248 | 8 × 1 BGs × 2 banks, 16 × 1024-BL MATs, coupled × 2, 32 MDLs | 1.50 | 163.2 (−6%) |

Takeaways:
- **At 16 GB the fixed share barely matters.** Iso-capacity keeps banks large, so the wire share dominates, and no model gets a 16 GB bank much below about 1.8 ns. Removing the fixed time entirely makes things slightly worse: the wire share then takes the full 2 ns × ratio, and these ratios are near or above 1.
- **32 Gb/s needs about 8–16 bank groups per pseudo-channel streaming at once,** against 2 today. This assumes the groups can alternate faster than DreamRAM's tCCD_S (see the caveat at the end of the staged section). With the BG-BUS window enforced it takes 16: stacking 8 groups per column lengthens the shared bus, so tCCD_L grows to 3.5–3.8 ns and eats most of the extra concurrency.
- **The answer hinges on the BG-BUS window.** With the bank path alone, the same 16 banks per pseudo-channel regrouped as 8 groups × 2 banks reach 43 Gb/s at a 6% smaller die. The BG-BUS stage is a pessimistic bound for long buses (see the extension above), so the truth for a retimed bus lies between these two rows.
- **TSVs are an area knob, not a rate limit.** For the smallest DreamRAM-model design:

| GBUS→TSV | TSVs per PC × rate | TSV→DQ | Data TSVs per die | TSV region | Die |
| --- | --- | --- | --- | --- | --- |
| 8 | 34 × 36.7 Gb/s | 1:1 | 3,200 | 11.5 mm² | 154.3 mm² |
| 2 | 136 × 9.2 | 4:1 | 10,496 | 25.5 | 168.3 |
| 1 | 272 × 4.6 | 8:1 | 20,224 | 44.2 | 187.0 |
| ½ | 544 × 2.3 | 16:1 | 39,680 | 81.6 | 224.4 |
| ¼ | 1,088 × 1.15 | 32:1 | 78,592 | 156.3 | 299.1 |

  If HBM4 carries 4× HBM3's TSVs with 2× its DQs, that is about the ½ row: 4 × 10,112 chain-counted HBM3 TSVs ≈ 40,400 per die. Those TSVs would carry 32 Gb/s pins at about 2.3 Gb/s each. DreamRAM's TSV region uses a 40 µm µbump pitch, so this area is an upper bound for finer-pitch hybrid bonding.

**Bundled designs** (**Example designs → 32 Gb/s exploration**)

Five passing designs from the default sweep, exported with DreamRAM (a sixth, with only 2 bank groups and 64 B accesses, is described under "Only 2 bank groups per pseudo-channel?" below and exported with a 27 mm die limit):
- Each has 16 GB, 2,176 DQs (34 per pseudo-channel), GBUS→TSV 1 and all bank groups alternating onto the GBUS.
- Each was exported with the die limit relaxed to 19.5 mm.
- "DreamRAM tCCD_L" keeps the 1 ns fixed share and enforces the BG-BUS window (`tccd_bgbus` = 1). "Bank path only" uses a 0.5 ns node-scaled fixed share and `tccd_bgbus` = 0.
- Pin rates are each design's maximum. At exactly 32 Gb/s the core would run slower and draw proportionally less power.

| | DreamRAM tCCD_L, smallest die | DreamRAM tCCD_L, lowest latency | Bank path only, smallest die | Bank path only, 32 banks / PC | Bank path only, lowest latency |
| --- | --- | --- | --- | --- | --- |
| Bank groups per PC (vertical × side by side), banks each | 8 × 2, 2 | 8 × 2, 2 | 8 × 1, 2 | 4 × 2, 4 | 8 × 2, 2 |
| Bank | 8 × 1024 WL, 16 × 512-BL MATs, 16 MDLs, 2 layers | 16 × 512 WL, 32 × 256-BL MATs, 8 MDLs, BRVSA | 8 × 1024 WL, 16 × 1024-BL MATs coupled × 2, 32 MDLs, 2 layers | 8 × 1024 WL, 16 × 512-BL MATs, 16 MDLs, 2 layers | 32 × 256 WL, 16 × 512-BL MATs, 8 MDLs, BRVSA, 2 layers |
| tCCD_L | 3.49 ns (BG-BUS) | 3.39 ns (BG-BUS) | 1.50 ns | 1.52 ns | 3.92 ns (2 pumps) |
| Max pin rate / bandwidth | 36.7 Gb/s · 9.4 TB/s | 37.8 · 9.7 | 42.8 · 10.9 | 42.2 · 10.8 | 32.6 · 8.4 |
| Die | 17.23 × 10.85 mm | 18.83 × 11.11 | 14.30 × 11.41 | 17.23 × 10.83 | 17.23 × 11.94 |
| Row-miss latency | 127.7 ns | 95.5 | 103.0 | 94.4 | 63.2 |
| Energy / bit (closed / stream) | 4.19 / 2.94 pJ | 3.78 / 2.89 | 4.33 / 2.26 | 3.35 / 2.10 | 3.01 / 2.30 |
| Worst-case power | 315 W | 292 | 379 | 290 | 201 |
| Per PC: BG-BUS · GBUS = TSV · DQ (wires × Gb/s) | 272 × 0.29 · 272 × 4.58 · 34 × 36.7 | 272 × 0.29 · 272 × 4.72 · 34 × 37.8 | 272 × 0.67 · 272 × 5.35 · 34 × 42.8 | 272 × 0.66 · 272 × 5.27 · 34 × 42.2 | 136 × 0.51 · 136 × 8.16 · 34 × 32.6 |

For comparison, the HBM4 coupled design draws 51 W at 2 TB/s with the BG-BUS extension, at 3.12 / 1.79 pJ/b. So 4–5× the bandwidth costs more energy per bit as well as more power, and a 32 Gb/s stack would draw about 200–380 W in DreamRAM's worst case. Latency grows because these designs stack more bank groups per column and use taller 1024-WL MATs. Only the 256-WL BRVSA design keeps HBM4's 63 ns.

**Only 2 bank groups per pseudo-channel?**

```bash
python3 tools/sweep_pin_rate.py --dreamram /path/to/DreamRAM --bank-groups 2x1,1x2 --banks 2,4,8,16 \
    --mats 16,32,64 --ldls 8,16,32,64 --atoms 256,512,1024 --max-die-mm 40
```

With two groups alternating, the pin rate is `access bits × 2 / (32 DQs × tCCD_L)`. At HBM4's 256-bit (32 B) access, 32 Gb/s needs tCCD_L ≤ 0.5 ns, and no 16 GB bank gets below about 0.9 ns in any model. Highest pin rate with 2 bank groups:

| Column-cycle model | 32 B access | 64 B access | 128 B access |
| --- | --- | --- | --- |
| DreamRAM (1 ns fixed, C × L) | 9.3 Gb/s | 19.5 | 19.5 |
| 0.5 ns fixed, node-scaled, C × L | 10.7 | 23.5 | 23.5 |
| 0.5 ns fixed, node-scaled, L² | 10.9 | 23.5 | 23.5 |
| No fixed time, C × L | 11.0 | 25.1 | 25.1 |
| 0.5 ns fixed, node-scaled, bank path only | 17.7 | **34.4** | **34.4** |

- **With the BG-BUS window enforced, 2 groups top out at 19–25 Gb/s.** A 64 B access halves the number of accesses per pin bit, but the shared bus then limits tCCD_L to 1.3–1.6 ns.
- **128 B accesses gain nothing.** DreamRAM's MDL-pitch filter keeps any 1 KiB-row MAT set below 512 bits per pump, so a 128 B access takes two pumps and doubles tCCD_L.
- **Only the bank-path-only model reaches 32 Gb/s,** and only with 64 B accesses: 9 designs, all 2 vertical groups × 16 banks (32 banks per pseudo-channel, twice HBM4's) with a 4 KiB wordline of four coupled 1 KiB rows and 512 bits per pump. The smallest is bundled as **32G · bank path only · 2 BGs × 16 banks, 64 B access**: tCCD_L 0.97 ns, 33.1 Gb/s (8.5 TB/s), 26.48 × 10.94 mm = 289.7 mm² (+67% vs. HBM4 coupled), 70.3 ns row-miss latency, 192 W. Its BG-BUS stage is 1.75 ns, so enforcing that window caps it at about 18 Gb/s.
- **TSVs dominate its extra area.** With GBUS→TSV 1:1 its 544 GBUS bits per pseudo-channel each need a TSV (39,680 data TSVs per die, 81 mm²). Serialising 4:1 onto the TSVs (136 TSVs per pseudo-channel at 8.3 Gb/s) brings the die to 233.7 mm² at the same pin rate.

## Staged tCCD_L model (`tccd_staged`)

DreamRAM's column cycle is one number: a 1 ns driver term plus a wire term. The staged model breaks it into the steps of one column read. tCCD_L is then the slower of two things, each paid once per pump (see [Pumps](#pumps)):
- the bank's own serial cycle;
- the stages the bank group shares.

```
tCCD_L = pumps × max(bank cycle, shared stage per pump)        tCCD_S = tCCD_L / 2 (as DreamRAM)
```

Turn it on under **Parameters → Extensions → Column-cycle model: Staged**, or with `--set tccd_staged=1` in the exporter. Both implementations match to ≤ 4.5e-16 on 80 random staged designs (62 of them multi-pump, 40 with `mdl_bgbus_sd` = 2). With it off, every bundled example is unchanged.

<a id="pumps"></a>
**Pumps.** One column cycle (a "pump": one CSL firing) moves `min_atom = mats × ldls_mdls / (2^(ha_layout − ha_double_ldls) × subchannels)` bits over the MDLs. With coupled rows, divide by `coupled_rows` as well, because a READ reaches only one logical row's MATs. When the column access (`atom_size`, 256 bits = 32 B in HBM3/HBM4) is wider than that, the bank fires `pumps = atom_size / min_atom` CSLs in a row on the same open row, a different column each time. Each slice goes over the MDL, the BG-BUS and the GBUS separately.
- **DreamRAM's rules.** DreamRAM keeps `core_tck` per pump and multiplies tCCD_L (4 peripheral cycles), tCCD_S (2) and tRTP (5) by the pump count; `peri_tck = core_tck / 4`. It discards designs with `min_atom > atom` (status 6), a non-integer `min_atom` (7), a non-integer pump count (8) or more than 8 pumps (10).
- **What it trades.** Pumping trades wires for time. The MDL, BG-BUS, GBUS, TSV and DQ widths all follow `min_atom`, not `atom_size`. Per-wire and per-pin rates are unchanged, but a bank group's throughput falls as 1 / pumps.
  - The sweeps below hold 32 data DQs fixed, so for them more pumps means a lower pin rate.
  - Every datapath toggle is counted per pump in energy. Data energy per atom therefore stays about the same; the real cost is the extra CSL firings.
- **Examples.**
  - The HBM2 cross-check design below: 16 MATs × 8 MDLs = 128 bits per cycle, so a 256-bit atom takes 2 pumps.
  - The `high_bw_subchannels` example: 8 pumps.
  - In the Timing tab, a 2-pump design draws two CSL/LDL/MDL/IOSA/ECC/BG-BUS slices per read.
- **The staged model pays every shared stage per pump or per BG-BUS transfer.** This covers OD-ECC + DBI, the BG-BUS window, the shared IOSA and the shared MDL line. Ryu et al. decode each BG-BUS word's codewords inside tCCD_L, and DreamRAM generates DBI per BG-BUS transfer. So pumping never amortises a shared stage, and 128 B accesses gain nothing over 64 B.

### Is the MDL shared by the banks of a group?

Not the wires. What the group shares is the sense amp at their end. Every source draws a bank's MDL (global I/O) pairs over that bank's own MATs. They differ on where the I/O sense amp (IOSA) sits, so on how far a bank's MDL pair runs before it is resolved:

| Organisation | Source | `mdl_share` |
| --- | --- | --- |
| IOSA per bank: per-bank global sense amps and data bus, muxed onto a shared bus | NVIDIA FGDRAM (O'Connor et al., MICRO 2017) | `0` |
| Helper flip-flop at the LDL/MDL junction, 256 global SAs per bank. tCCD_L is set by the CSL → column mux → local SA → global SA path | Chatterjee et al., HPCA 2017 (subchannels) | `0` |
| IOSA shared by 2–4 adjacent banks through bank-select transfer gates on each bank's global I/O lines | Samsung, US 6,327,214 B1 | `1` |
| Central I/O control per bank group, between its banks | Ryu et al. (HBM3, JSSC 2023) | `1` (calibration) |
| One GIO pair shared by 4 banks through switches. Interleaved reads need non-overlapping windows, which caps frequency | US 7,289,385 | `2` |
| Local I/O gating per bank group, then global I/O gating | Micron DDR4 design guide | — |

So "one differential MDL pair shared by all banks in a group" describes only the `2` style. The common case is per-bank MDL wires into a shared (`1`) or per-bank (`0`) IOSA. All three are modelled.

### Stages

Each stage is a device delay in FO4 units plus, for the long lines, the line's distributed RC (0.38 · r · c · L²):

| Stage (per pump) | FO4 at the reference load | Wire | Length |
| --- | --- | --- | --- |
| CSL rise | 4 + 4 × load | M3 | bank height (half with `col_mid`) |
| LDL develop | 1 + 4 × load | M2 | sub-wordline driver + one MAT's columns |
| MDL develop | 2 + 6 × load | M3 | per-bank IOSA: bank height. IOSA at the I/O control: ceil(banks / 2) bank slots |
| IOSA resolve | 4 | — | — |
| Equalise | 1 + 4 × MDL load | half the MDL RC | — |

| Shared stage | FO4 | Paid |
| --- | --- | --- |
| OD-ECC decode/correct + DBI (`od_ecc_logic`) | 24 | per pump |
| BG-BUS window | 4 + 0.15 × repeated-wire flight (2.5 FO4/mm) | per BG-BUS transfer (pumps × `mdl_bgbus_sd`) |
| Shared IOSA occupancy (`mdl_share` ≥ 1) | 6 | per pump |
| Shared MDL line (`mdl_share = 2`) | MDL + IOSA + equalise | per pump |

"Load" is the line's C × L relative to the calibration design, using DreamRAM's own per-µm capacitances and pitch ratios. Resistance uses ρ_eff = 3 × 10⁻⁸ Ω·m. M3 CSL/MDL lines are 2 × BL pitch wide (half of DreamRAM's minimum 4 × BL pitch) with aspect ratio 2; M2 LDLs are half the LDL pitch wide. One FO4 is κ · (f / 16 nm)^0.9, the same logic scaling DreamRAM applies to its peripheral tiles.

**Calibration.** Only κ is fitted. The FO4 counts are priors, chosen to be plausible, not fitted. κ = 43.0 ps makes the HBM3 baseline (16 nm, IOSA at the I/O control) cycle at Ryu et al.'s 2.00 ns:

| HBM3 baseline | CSL | LDL | MDL | IOSA | Equalise | **Bank cycle** | OD-ECC + DBI | BG-BUS | Shared IOSA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ns | 0.51 | 0.22 | 0.70 | 0.17 | 0.40 | **2.00** | 1.03 | 0.26 | 0.26 |

Its MDL runs 1,265 µm, two bank slots, to the I/O control. With per-bank IOSAs the same die would cycle at 1.36 ns.

**Cross-check on a design not used in the fit.** HBM2 (8 Gb die, 20 nm, `configs/tech/hbm2_20nm.json`, per-bank global SAs as in FGDRAM, no OD-ECC) is reported at 2 ns per internal column cycle (tCCD_L = 4 ns over 2 pumps). The model gives 1.77 ns (−12%) with a mid-bank column decoder (`col_mid = 1`), and 3.21 ns with DreamRAM's edge decoder. Fitting both anchors with an edge decoder needs a negative wire term, which suggests HBM2's tall banks are driven from the middle.

```bash
python3 tools/export_floorplan.py --dreamram /path/to/DreamRAM -t $PWD/configs/tech/hbm2_20nm.json \
  --set sids=1 --set channels=8 --set ch_per_die=2 --set vert_bg=4 --set banks=4 --set mats=16 \
  --set subarrays=32 --set ldls_mdls=8 --set tccd_staged=1 --set mdl_share=0 --set col_mid=1 --set od_ecc_logic=0
```

(DreamRAM discards this point with status 11, a die dimension over 13 mm. The exporter still reports the staged bank cycle.)

### Bundled designs under the staged model

tCCD_L in ns / implied pin rate in Gb/s. The rate assumes each design keeps its DreamRAM-sized datapath.

| Design | DreamRAM | Staged, per-bank IOSA (`0`) | Staged, IOSA at I/O control (`1`) |
| --- | --- | --- | --- |
| HBM3 baseline | 2.00 / 8.0 | 1.36 / 11.7 | 2.00 / 8.0 |
| HBM3 organisation, 17 nm | 2.00 / 8.0 | 1.49 / 10.8 | 2.17 / 7.4 |
| HBM4 1 SID, 4-high | 2.67 / 6.0 | 1.75 / 9.1 | 8.21 / 2.0 |
| HBM4 1 SID, coupled rows | 1.93 / 8.3 | 0.99 / 16.2 | 3.21 / 5.0 |
| Samsung HBM4 12H, coupled | 1.75 / 9.1 | 0.85 / 18.8 | 2.36 / 6.8 |
| HBM5 2 BGs, min area | 1.94 / 8.2 | 0.87 / 18.4 | 2.64 / 6.1 |
| HBM5 2 BGs, HBM4 MATs | 1.64 / 9.8 | 0.84 / 19.0 | 1.67 / 9.6 |
| 32G · 2 BGs × 16 banks, 64 B | 0.97 / 33.1 | 0.84 / 38.0 (OD-ECC + DBI limits) | 2.71 / 11.8 |
| High-BW subchannels (8 pumps) | 13.77 / 9.3 | 8.91 / 14.4 | 8.96 / 14.3 |

`mdl_share = 2` matches `1` on all of these, because the bank cycle already dominates.

- **Where the IOSA sits matters most.** With IOSAs at the I/O control, the farthest bank's MDL runs ceil(banks / 2) bank slots. Its RC grows with length², so the 8- and 16-bank groups of the HBM4/HBM5 designs land at 1.7–8.2 ns.
- **Large groups therefore need per-bank IOSAs, or IOSAs shared by a pair of banks.** That fits the Samsung patent's 2–4-bank sharing.
- **With per-bank IOSAs the picture is better than DreamRAM's.** Every HBM4/HBM5 design here reaches 0.84–1.75 ns. The 32 Gb/s design's limit moves from its banks to OD-ECC + DBI (24 FO4 = 0.84 ns at the HBM4 node).
- **The default stays `mdl_share = 1`** because that is the HBM3 organisation the model is calibrated on.

### 32 Gb/s with 2 bank groups, staged

```bash
python3 tools/sweep_pin_rate.py --dreamram /path/to/DreamRAM --models staged_ioctl,staged_bank,staged_bank_mid \
    --bank-groups 2x1,1x2 --banks 2,4,8,16 --mats 16,32,64 --ldls 8,16,32,64 --atoms 256,512,1024 --max-die-mm 40
```

This is the same 2-group search as above (about 14 s), with three staged models:
- `staged_ioctl`: IOSA at the I/O control;
- `staged_bank`: per-bank IOSA;
- `staged_bank_mid`: per-bank IOSA with a mid-bank column decoder.

The table gives the highest pin rate with at least 16 banks per pseudo-channel, as in HBM4, and the number of such designs reaching 32 Gb/s:

| Column-cycle model | 32 B access | 64 B access | 128 B access |
| --- | --- | --- | --- |
| IOSA at the I/O control | 10.6 Gb/s (bank cycle), 0 pass | 19.2 (bank cycle), 0 | 19.2, 0 |
| Per-bank IOSA | 19.0 (OD-ECC + DBI), 0 | **38.0** (OD-ECC + DBI), 223 | 38.0, 223 |
| Per-bank IOSA, mid-bank decoder | 19.0 (OD-ECC + DBI), 0 | **38.0** (OD-ECC + DBI), 362 | 38.0, 362 |

The smallest passing designs at 64 B:
- **Per-bank IOSA:** 2 groups × 8 banks, 8 × 1024-WL subarrays, 16 × 1024-BL MATs, 64 MDLs, two coupled rows.
  - tCCD_L 0.99 ns (bank cycle), 32.2 Gb/s.
  - Die 14.30 × 14.37 mm = 205.5 mm² (+18% vs. HBM4 coupled).
  - Row-miss latency 95 ns; 199 W.
- **Mid-bank decoder:** 2 groups × 8 banks, 16 × 1024-WL subarrays, 16 × 512-BL MATs, 32 MDLs.
  - 0.89 ns, 35.9 Gb/s.
  - Die 8.62 × 23.25 mm = 200.3 mm². This ties on area with two routing variants; one of them, 38.0 Gb/s, is limited by OD-ECC.
  - 142 ns; 288 W.

Takeaways:
- **32 B accesses cannot reach 32 Gb/s with 2 groups.** That needs tCCD_L ≤ 0.5 ns. With OD-ECC + DBI inside tCCD_L (24 FO4 = 0.84 ns at the HBM4 node), the cap is 19 Gb/s. Even with ECC pipelined out of the loop, the bank cycle caps it at 25.7 Gb/s (29.2 with mid-bank decoders). This held under every single change to the priors tried below.
- **IOSAs at the I/O control never reach it**, at any access size or prior: the farthest bank's MDL is too long.
- **With per-bank IOSAs, 64 B accesses reach 32–38 Gb/s.** The limit is then OD-ECC + DBI: 64 B at 32 Gb/s leaves 1.0 ns per access, and the ECC prior has 16% margin (it breaks at about 28.5 FO4).
- **The extra area is all TSVs.** These designs carry 544 GBUS bits per pseudo-channel at GBUS→TSV 1:1 (81 mm² of TSV region against 44 for HBM4 coupled); their non-TSV area is smaller than HBM4's. At GBUS→TSV 2:1 the 205.5 mm² design shrinks to about 168 mm².

**How far to trust this.** An independent re-check reproduced the 32 B and 64 B numbers above from the exporter's CLI, and both CSVs exactly. It also found the following:
- **JEDEC disagrees with the per-bank models.** JESD270-4 gives HBM4's 16-bank organisation as 2 groups × 8 banks with tCCD_L = max(4 nCK, 2.5 ns). For that organisation, the HBM4 coupled reference, the three models give 3.21 ns (I/O-control IOSA), 0.99 ns (per bank) and 0.84 ns (mid-bank). The only public HBM4 number is closest to the I/O-control model and 2.5–3× slower than the per-bank ones. It is a cross-vendor minimum, so it may be conservative. Fitting κ to it under the per-bank models leaves no 2-group design at 32 Gb/s. Fitting it under the I/O-control model lets 15 designs pass at 64 B. No single κ fits both the HBM3 and HBM4 numbers.
- **The calibration choice decides the 64 B result.** Ryu et al. do not say where HBM3's IOSA sits. Calibrating on HBM3 with per-bank IOSAs raises κ to 56.8 ps, and then 64 B tops out at 28.8 Gb/s with nothing passing. Halving ρ_eff does the same.
- **Effect of each prior alone.** Changed one at a time (ECC 12/0/36 FO4, load-dependent FO4 × 0.5 / 1.5, ρ 2 / 4.5 × 10⁻⁸, MDL device term, BG-BUS launch):
  - Per-bank 64 B passes in 9 of 11 runs; it fails at ECC 36 FO4 and at load FO4 × 0.5.
  - 32 B never passes. With ρ = 4.5 × 10⁻⁸ and ECC ≤ 18 FO4 together, 6 designs (2 × 16 banks, four coupled rows) reach 33 Gb/s.
- **Not modelled:**
  - per-bank IOSA area (`mdl_share` changes timing only);
  - the command/address rate (32 Gb/s needs a 4 GHz CK for 64 B bursts);
  - a GBUS window (Ryu found 1 ns too short and added a second GBUS set);
  - thermals: these stacks draw about 200–290 W against 51 W for HBM4 coupled.
- **Footprint.** None of the dies fits HBM4's 14.2 × 11.0 mm footprint (MO-362). The DreamRAM HBM4 reference doesn't either: it is 15.10 × 11.52 mm.

The default sweep (2–16 bank groups) has one caveat that applies to every model, not only the staged ones. It credits all bank groups alternating onto the GBUS, i.e. tCCD_S = tCCD_L / groups. DreamRAM's own tCCD_S is tCCD_L / 2. With more than 2 groups, the pin rates in the first table above therefore assume a command rate and a GBUS window that DreamRAM doesn't check. Capping at DreamRAM's tCCD_S leaves no default-sweep design at 32 Gb/s.

<a id="timing-tab"></a>
### Timing tab

The **Timing** tab draws four column reads as a wave diagram. Its lanes are:
- CK and the column commands;
- per bank group: CSL, LDL ΔV and MDL ΔV (as analog development ramps), the IOSA, OD-ECC + DBI and the BG-BUS window;
- the two alternating GBUS sets;
- the DQ burst after tCL. A dashed break stands for the tCL gap.

Three scenarios:
- **Same bank**: the bank's own lines must equalise before its next CSL.
- **Other bank, same bank group**: banks overlap their own lines but share the IOSA, OD-ECC/DBI and BG-BUS.
- **Other bank group**: reads alternate every tCCD_S, and each group still sees tCCD_L.

The stage widths come from the staged model. With the staged model off, the same split is scaled to DreamRAM's tCK, and the header says so. Hover any segment for its duration. It follows the selected design and every parameter change.

## Drawing choices (not specified by DreamRAM)

DreamRAM's model fixes the size of every block, but not always where each block sits. Where it does not, the viewer makes these choices:

- **Bank columns**: adjacent columns are mirrored so that pairs face each other across their control stripes (2 × row-decoder width per column).
- **Bank groups**: with one channel row (DreamRAM), they split evenly above and below the TSV region; with two, each channel keeps all of its bank groups on its side. Inside a group, ceil(banks/2) banks sit on the far side of the I/O control. Bank 0 is the farthest from the TSVs.
- **GBUS CTRL / TSVs**: see the HBM3 section above. Power/keep-out bands remain full-width at the top and bottom of the TSV region.
- **Inside a bank**:
  - Each subarray row places its BLSA stripe on the column-decoder side.
  - DreamRAM's "+1" cell row (`subarrays + salp_groups − 1 + repair + 1`) is drawn as the row farthest from the column decoder.
  - ECC MATs are drawn as whole MATs at the far end of the row.
- **TSVs**: inside each block they are laid out row-major at max(µbump, TSV) pitch, channel by channel, in the order of the purpose terms.
- **Illustrative wiring**:
  - MWLs are drawn at 1 per 8 WLs. DreamRAM itself only models the one MWL asserted per ACT.
  - When the MDLs or CSLs run over LWDs, they are split between the two neighbouring LWD stripes, as in Fig. 3 of the paper.
  - BG-BUS/GBUS lines show topology, not wire count; counts appear in tooltips.
  - OD-ECC codeword assignment is by MAT position within the access (even/odd MAT for 8 bits per MAT, alternating symbols for wider MATs). This reproduces the paper's guarantee for HBM3; the paper does not give the exact bit mapping.

## Layout

```
index.html, css/style.css
js/model.js        DreamRAM model port (geometry, filters, bandwidth/latency)
js/floorplan.js    lazy hierarchy of placed rectangles (µm)
js/render.js       canvas renderer, LOD, wiring, TSVs, stack view, hit-testing
js/app.js          UI: navigation, tree, components, parameters, metrics, exports
js/timing.js       Timing tab: column-read wave diagram (SVG)
js/examples.js     bundled DreamRAM exports (generated)
tools/export_floorplan.py   export a design's geometry + metrics from DreamRAM
tools/build_examples.py     bundle examples/*.json into js/examples.js
tools/serve.py              no-cache local server
tools/sweep_pin_rate.py     iso-capacity sweep for a target pin rate (runs DreamRAM via the exporter)
configs/tech/*.json         DreamRAM tech configs for the HBM4 array and the 20 nm HBM2 cross-check
```
