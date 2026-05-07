# UESIM testDefinition → Simnovus cfg mapping

Source: 7 sample testcase JSONs pulled from `http://192.168.1.95/v2/testcases/{id}` plus
353 enb/gnb cfg files and 37 mme/ims cfg files mined into
[corpus-catalog.json](../output/corpus-catalog.json).

Stack confirmed: **Simnovus's own `lteenb` / `ltemme` / `ltesim_server`** — libconfig with C
preprocessor (`#define`, `#if`, `#include`). Not Amarisoft, despite the syntactic similarity.

## Top-level routing

| testDefinition field | Decision |
|---|---|
| `cellConfig.master.ratType: "sa"` | Emit `gnb-sa.cfg` (SA gNB, no eNB) |
| `cellConfig.master.ratType: "nsa"` | Emit both `enb.cfg` (eNB anchor) **and** `gnb.cfg` (NR secondary) |
| `cellConfig.master.ratType: "smartphone"` | LTE smartphone — emit `enb.cfg` only |
| `cellConfig.cells[].cellConfig.cellType: "5g"` | NR cell → goes into `nr_cell_list` of the gNB |
| `cellConfig.cells[].cellConfig.cellType: "4g"` | LTE cell → goes into `cell_list` of the eNB |
| Any `userPlaneConfig.profiles[].dataGeneralInfo.dataType` ∈ {`volte`,`vonr`} | Add IMS APN to `mme.cfg` + emit/use `ims.cfg` |
| `cellConfig.master.carrierAggregation: true` | Multi-CC: cells in same gNB, same `nr_cell_list[]` with multiple entries |

## eNB (`enb.cfg`) knobs

| testDefinition path | cfg target | Notes |
|---|---|---|
| `cells[].cellConfig.duplexMode` | `#define TDD 0/1` | "FDD"→0, "TDD"→1 |
| `cells[].cellBandwidthInfo.bandwidth` (MHz) | `#define N_RB_DL` | 1.4→6, 3→15, 5→25, 10→50, 15→75, 20→100 |
| `cells[].cellRadioInfo.antennas.dl` | `#define N_ANTENNA_DL` | 1, 2, 4 (corpus values) |
| `cells[].cellRadioInfo.antennas.ul` | `#define N_ANTENNA_UL` | 1, 2 |
| `cells[].cellConfig.band` | `band:` in `cell_list[]` and `dl_earfcn` | Use band→EARFCN table; corpus has symbolic `LTE_FDD_B7=3350` etc. |
| `cells[].cellRadioInfo.EARFCN.dl` | `dl_earfcn:` | Direct override if testcase pins it |
| `cells[].cellRadioInfo.EARFCN.ul` | `ul_earfcn:` | FDD only |
| TDD config (derived) | `uldl_config:`, `sp_config:` | Corpus uses `uldl_config: 2/3`, `sp_config: 7/8` |
| `master.channelSim` | `#define CHANNEL_SIM 0/1` | Enables AWGN channel block |
| `cells.length` | `cell_list[]` size + `#define N_CELL` | Corpus seen: 1, 2, 3 cells |
| `cells[].cellCarrierConfig.gainInfo.txGain[]` | `tx_gain:` per rf_port | LTE: scalar; multi-antenna: per-port |
| `cells[].cellCarrierConfig.gainInfo.rxGain[]` | `rx_gain:` per rf_port | |
| Derived from `subscriberProfileInfo.startingIMSI` | `plmn_list: ["00101"]` | First 5 digits of IMSI = MCC+MNC |
| Constant for now | `tac:`, `enb_id:`, `n_id_cell:`, `cell_id:` | Allocate per cell; TAC pinned `0x0001` |

## gNB (`gnb.cfg` or `gnb-sa.cfg`) knobs

| testDefinition path | cfg target | Notes |
|---|---|---|
| `cells[].cellConfig.duplexMode` | `#define NR_TDD 0/1` | |
| `cells[].cellBandwidthInfo.bandwidth` | `#define NR_BANDWIDTH` | Corpus values: 10, 20, 40, 50, 100 (MHz) |
| `cells[].cellCarrierConfig.ScsInfo.scs` | `#define SCS` and per-cell `subcarrier_spacing:` | Corpus: 30 (FR1), 120 (FR2) |
| `cells[].cellConfig.band` | `band:` per `nr_cell_list[]` entry | Strip leading "n" if present (e.g. `"n78"` → `78`) |
| `cells[].cellRadioInfo.NRARFCN.dl` | `dl_nr_arfcn:` | Direct |
| `cells[].cellRadioInfo.NRARFCN.ssb` | `ssb_nr_arfcn:` (or via `ssb_pos_bitmap`) | |
| `cells[].cellRadioInfo.antennas.dl` | `#define N_ANTENNA_DL` | 1, 2, 4 |
| `cells[].cellRadioInfo.antennas.ul` | `#define N_ANTENNA_UL` | 1, 2 |
| `master.ratType: "sa"` | `#define NR_SA 1`, `#define NG_ENB 0` | |
| `cells.length` (NR cells) | `nr_cell_list[]` entries | |
| `cells[].cellRadioInfo.rfInfo.rfCard` | `rf_port:` per nr_cell | Multi-cell on different RF cards = multi-CC |
| `master.carrierAggregation` | (cell entries with same `cell_id` group, separate `rf_port`) | |
| FR2 marker (`band` ∈ {257, 258, 260…}) | `#define FR2 1`, `subcarrier_spacing: 120` | |
| VoNR support (`subscriberDeviceConfig.VoNRSupport`) | `#define EPS_FALLBACK 0` | Pure 5G voice; `1` enables fallback to 4G for voice |

## MME (`mme.cfg`) knobs

| testDefinition path | cfg target | Notes |
|---|---|---|
| Derived from `subscriberProfileInfo.startingIMSI/SUPI` | `plmn:` | Constant `00101` in this lab |
| Constant (corpus) | `mme_group_id: 32769`, `mme_code: 1` | |
| `subscriberAuthSecurity.cipherAlgorithm[]` (`eea0..2`/`nea0..2`) | (no separate field — supported set is wired in) | Used to validate UE caps match |
| `subscriberProfileInfo.ueCount` | (sized to UE pool, drives `pdn_list[].first_ip_addr/last_ip_addr` range) | 1000 UEs needs IP pool ≥1000 |
| `userPlaneConfig.profiles[].dataGeneralInfo.apnName` | one entry in `pdn_list[]` per APN | Corpus APNs: `default`, `internet`, `ims`, `ntn-internet`, `sos`, `test123` |
| `userPlaneConfig.profiles[].dataNetworkConfig.pdnType` | `pdn_list[].pdn_type` | `ipv4`, `ipv4v6`, `non-ip` |
| `userPlaneConfig.profiles[].dataNetworkConfig.pcscfIpAddress` (VoLTE/VoNR) | (shared with IMS) | |
| `subscriberAuthSecurity.resLength` | (used in MME auth response sizing) | Corpus: 8 |

## IMS (`ims.cfg`) — only when VoLTE/VoNR

| testDefinition path | cfg target |
|---|---|
| `userPlaneConfig.profiles[].dataNetworkConfig.realm` | IMS realm field |
| `userPlaneConfig.profiles[].dataNetworkConfig.pcscfIpAddress` | P-CSCF address |
| `userPlaneConfig.profiles[].mediaConfig.codec` | Allowed codec list |
| `userPlaneConfig.profiles[].mediaConfig.videoCodec` | Video codec (ViNR cases) |
| `userPlaneConfig.profiles[].dataAuth.{userName,password}` | Per-UE creds in `lte_ue_ims.db` |

## UE database (separate file: `ue_db-ims.cfg` or `lte_ue_ims.db`)

For each subscriber group, generate `ueCount` entries:

- `imsi` / `supi` derived from `startingIMSI/SUPI + i`
- `K` = `subscriberNetworkConfig.sharedKey`
- `algorithm` = `subscriberProfileInfo.algorithm` ("xor")
- `OPc` derived (or fixed test value)
- IMS profile (if VoLTE/VoNR): username/password from `dataAuth`

## Inter-file consistency constraints (must hold in all bundles)

1. PLMN appears in: `enb.plmn_list`, `gnb.plmn_list`, `mme.plmn`, IMSI prefix in `ue_db`. **All must agree.**
2. `enb.mme_list[].mme_addr` must equal `mme.gtp_addr` host (same-host: `127.0.1.100`).
3. `gnb.amf_list[].amf_addr` must equal AMF address (in lab: same as MME, `127.0.1.100`).
4. `mme.pdn_list[].access_point_name` must include every APN referenced by the testcase's userPlane profiles.
5. UE pool size in `mme.pdn_list[].first_ip_addr..last_ip_addr` must be ≥ `ueCount`.

## Known unknowns / TODOs

- **Channel sim mobility** (HO testcases): `cellMobility` block maps to `rf_ports[].channel_dl` AWGN params, but exact field names not yet validated against a working HO config.
- **NSSAI/slicing**: `subscriberNetworkConfig.networkSlicing` plus `pduSnssai` map to `gnb.plmn_list_5gc[].nssai` and `mme.nssai[]` — corpus has 1, 2, 4 slices but mapping rule TBD.
- **NTN**: `cellConfig.NTN: true` triggers `#define NTN_MODE` and `SAT_ALTITUDE`, but TLE → orbital params mapping not yet defined.
- **NR-eRedCap / RedCap**: `subscriberDeviceConfig.ueCategory` could drive `#define ALLOW_REDCAP` — needs example testcase with redcap UEs.
- **GET /version returns 401** with valid admin token — spec mismatch worth filing against the API team.
