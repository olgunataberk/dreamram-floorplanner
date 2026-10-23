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

**Search.** Every bank organisation meeting those constraints was run through DreamRAM's exporter. The sweep covered:
- bank-group tiling: 2 vertical, or 2 side by side;
- MAT size, MAT count, MDLs, MDL/CSL routing and layer sharing;
- BLSA vs BRVSA;
- coupled rows;
- 1 or 2 channel rows.

That gave 490 valid designs; 172 have 1 KiB rows and run at ≥ 8 Gb/s. **None fits DreamRAM's 13 mm die limit.** Four representative designs are in **Example designs → HBM5 exploration**, each exported with a die limit just above its size:

| | HBM4 (reference) | HBM4 MATs + coupled 2 KiB WL | Smallest die | Near-smallest, 1 channel row | HBM4 latency |
| --- | --- | --- | --- | --- | --- |
| Banks / PC, rows / bank | 16, 16 K | 16, 8 K | 16, 8 K | 16, 8 K | 16, 8 K |
| Bank organisation | 32 × 512-BL MATs, coupled, 16 × 512 WL | same, 8 × 512 WL | 16 × 512-BL MATs, 8 × 1024 WL, 2 CSL/MDL layers | same | 16 × 512-BL MATs, 16 × 512 WL, 2 layers |
| Channel rows | 1 | 2 | 2 | 1 | 1 |
| Bank (µm) | 857 × 503 | 857 × 304 | 452 × 463 | 452 × 463 | 452 × 503 |
| Die | 15.10 × 10.28 mm = 155.3 mm² | 15.10 × 13.89 mm = 209.7 mm² (+35%) | 8.62 × 22.02 mm = 189.8 mm² (+22%) | 17.23 × 11.15 mm = 192.2 mm² (+24%) | 17.23 × 11.52 mm = 198.5 mm² (+28%) |
| TSV region | 25.0 mm² | 49.9 mm² | 49.9 mm² | 49.9 mm² | 49.9 mm² |
| Data rate / bandwidth | 8.27 Gb/s · 2,117 GB/s | 10.20 Gb/s · 5,224 GB/s | 9.20 Gb/s · 4,708 GB/s | 9.20 Gb/s · 4,708 GB/s | 8.87 Gb/s · 4,541 GB/s |
| Row-miss latency (tCL + tRCD + tRP) | 63.7 (27.7 + 18 + 18) | 74.2 (38.2 + 18 + 18) | 111.9 (58.8 + 26.6 + 26.6) | 82.5 (29.4 + 26.6 + 26.6) | 63.6 (30.3 + 16.6 + 16.6) |
| Energy / bit (closed / stream) | 3.12 / 1.79 pJ | 3.38 / 1.99 pJ | 3.95 / 2.55 pJ | 3.01 / 1.79 pJ | 2.68 / 1.81 pJ |
| Worst-case power | 53 W | 141 W | 149 W | 113 W | 97 W |

Takeaways:
- **The die grows 22–35%.** About 25 mm² comes from the doubled TSV region (every channel's TSVs on every die). The rest is per-bank overhead: twice as many banks, each with its own row and column decoders, dummy and edge rows, and an I/O-control share, over the same total number of cells.
- **1 KiB physical rows win.** Halving the rows per bank makes the 1 KiB-wide bank (16 MATs × 512 BL) short enough to stay fast, and its decoders and LWDs cost less than HBM4's 2 KiB coupled wordline. The coupled design is still the fastest (10.2 Gb/s) because its bank is so short, but it is the largest.
- **HBM4 latency costs about 28% area.** With 512-WL MATs and one channel row, the HBM5 die matches HBM4's 63.6 ns row-miss latency at 198.5 mm². 1024-WL MATs save 3% area but add 10 ns to tRCD/tRP. A tall two-row die adds as much again to tCL.
- **The pin rate is DreamRAM's estimate,** set by bank geometry relative to its HBM3 calibration.

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
js/examples.js     bundled DreamRAM exports (generated)
tools/export_floorplan.py   export a design's geometry + metrics from DreamRAM
tools/build_examples.py     bundle examples/*.json into js/examples.js
tools/serve.py              no-cache local server
```
