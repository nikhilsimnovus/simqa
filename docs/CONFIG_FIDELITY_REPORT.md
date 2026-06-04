# Config Fidelity — Validation Report

**What this proves:** that a test created in Simnovator (the JSON config authored via
`/tests/*`) is faithfully reflected in the Amarisoft **`ue.cfg`** the UE-sim generates at
execution time. UE-side only (no callbox), so it runs in a customer lab.

- **Tool:** simqa → *Config Fidelity* tab (`/config-fidelity`) + CLI sweep (`scripts/cf-matrix-run.ts`).
- **Method (per case):** create → execute → SSH-pull `/root/ue/config/ue.cfg` → diff **every input
  parameter** against its `ue.cfg` field → PASS only if config-error-free **and** every parameter honoured.
- **Validated against:** Simnovator API `192.168.10.202`, UE-sim `192.168.1.101`, build **4.0.0_260529**.
- **Offline regression fixture:** real input-config ↔ `ue.cfg` pair → 26/26 parameters honoured.

---

## 1. Feature-by-feature: what is validated & working

Legend: ✅ validated in `ue.cfg` · ⚙️ created/accepted by the box (structural) · ➖ not ue.cfg-observable · ⬜ not yet covered

| Area | Parameter / feature | Status | Notes |
|---|---|---|---|
| **Cell** | RAT type → `group_type` (NR/LTE) | ✅ | sa→nr, smartphone→lte |
| | Band → `band` (NR) / via `dl_earfcn` (LTE) | ✅ | LTE has no `band` field; verified through EARFCN |
| | Bandwidth | ✅ | NR MHz; LTE {3,5,10,15,20}; NBIoT 1.4 |
| | SCS / SSB SCS (NR) | ✅ | `subcarrier_spacing` |
| | Antennas DL/UL → `n_antenna_dl/ul` | ✅ | LTE UL fixed at 1 (box constraint) |
| | ARFCN — NR `dl/ssb` (+`ul`), LTE `dl/ul earfcn` | ✅ | NR UL derived by box |
| | PRACH → `prach_delay`, duplex (FDD/TDD) | ✅ | |
| **Subscriber** | UE count → `ue_list` length | ✅ | up to 256 verified |
| | IMSI/SUPI, shared key → `K` | ✅ | key compared case-insensitively |
| | Auth algorithm → `sim_algo` | ✅ | xor / milenage |
| | Cipher / integrity lists → `*_algo_bitmap` | ✅ | nea/nia/eea/eia → bitmap |
| | asRelease, ueCategory, pdnType, powerControl, imeisv | ✅ | |
| **User plane** | Data type no_data / UDP / TCP | ✅ | `global_traffic.iperf[].type` |
| | DL/UL bitrate, server IP | ✅ | `bitrate_dl/ul`, `dest_ip` |
| | VoLTE / FTP / RTSP / HTTP / SMS / PING / EXTERNAL | ⬜ | not yet in the matrix |
| **Settings** | Logging profile → `log_options`; test name → `log_filename` | ✅ | |
| **Power-cycle** | profile (loop/attach) | ⚙️ | section created & accepted; per-field diff pending |
| **Mobility** | profile (trip/fading) | ⚙️ | created; **no PUT** (box rejects update) |
| **RRC establishment** | attachType / ueInitiatedEvents | ⚙️ | config accepted; behaviour needs callbox |
| **Band sweep** | NR / LTE / CATM / NBIoT, every band (master table) | ✅ | 95 bands, real ARFCNs — see §3 |
| **Network slicing** | NSSAI | ➖ | NAS-signaled, **not** a static `ue.cfg` field (see §4) |
| **Unified Access Control** | access classes / identities | ⬜ | not ue.cfg-observable; needs functional test |
| **Supplementary Uplink** | SUL | ⬜ | not currently exercised |

**Bottom line:** the full **cell + subscriber + user-plane(data) + settings** parameter set is validated
end-to-end and honoured in `ue.cfg` across LTE and NR-SA, including a **band sweep over all 95 bands**.

---

## 2. Box behaviours encoded so the tool never mis-reports (handled, not bugs)

These are real box rules; the generator now respects them (so we don't flag correct behaviour as a fail):
`bandwidth` is a string · NR `rxToTxLatency ≥ 2` · LTE UL antenna = 1 · LTE bandwidth ∈ {3,5,10,15,20}
(no 1.4) · NBIoT bandwidth = 1.4 + `ueCategory ∈ {nb1,nb2}` · subscriber `startingIMSI` numeric · `opc`
32-hex-or-omitted · NR FDD UL-ARFCN omitted (box derives) · section order cells→subscribers→user-plane→
power-cycle→mobility→settings · test-case names limited to `[A-Za-z0-9_-]`.

---

## 3. Findings worth dev attention (genuine, from the live runs)

1. **NR per-band bandwidth inconsistency (real).** Bands **n5, n8, n14, n25, n65, n66, n70, n71, n50, n79**
   reject the standard `bandwidth` field and demand explicit `bandwidthType`/`bandwidthDL`/`bandwidthUL`,
   while n1/n2/n3/n7/n12/n13 accept `bandwidth`. The box even returns the values it expects (e.g. n5:
   DL "25", UL "20"). Inconsistent create-validation across bands. *(testcase.json captured per failure.)*
2. **Network slicing not reflected in `ue.cfg`.** Setting `networkSlicing: enable` + `nssaiObject`
   produces no NSSAI/slice field in `ue.cfg` — because slicing is signaled via NAS/registration, not the
   static UE config. **Implication:** slicing fidelity cannot be validated from `ue.cfg`; it needs a
   functional (with-core) test. Not a `ue.cfg` defect.
3. **Mobility has no working PUT** ("section 'mobilityConfig' cannot be updated").

Per failed case the tool stores `testcase.json` + `ue.cfg` + `diff.json` under
`data/cf-report/<runId>/failures/<id>/` for retrieval.

---

## 4. Feature criticality — and the open question for the team

Most parameters are **critical** (cell RF, subscriber identity/security, UE count, data plane) and are
**validated**. Three features are **not validatable from `ue.cfg`** and their **customer usage is unconfirmed** —
flagging them for classification (per @Pankaj):

| Feature | ue.cfg-observable? | Used by customers? | Suggested handling |
|---|---|---|---|
| **Supplementary Uplink (SUL)** | partial (RF) | ❓ **confirm** | classify; if used, add to band/cell matrix |
| **Unified Access Control (UAC)** | ➖ (NAS) | ❓ **confirm** | functional test w/ core; informational in fidelity |
| **Network Slicing** | ➖ (NAS) | ❓ **confirm** | functional test w/ core; informational in fidelity |

**Recommendation:** if these are not used by customers, mark them non-critical for the fidelity matrix
(and encourage adoption); if they are used, they need a **functional pass with a callbox/core** (they cannot
be proven from `ue.cfg` alone).

---

## 5. Ownership (proposed)

- **Nikhil** — owns the config-fidelity automation (this tool) + review; closes the "valid `ue.cfg`" gap.
- **Jai** — key protocol scenarios **functionally** with a callbox (handover, RRC establishment) — the
  live-behaviour complement to this `ue.cfg`-level coverage.
- **Sirisha** — UE count, loop count, traffic distribution (covered here at config level + functional spot-checks).
- **Pankaj** — classify the three features above against real customer usage (feeds the criticality table).

---

*Live results: `data/cf-report/<runId>/report.html` (Test ID · Testcase Name · RAT · Traffic · Bandwidth ·
Antennas · UE Count · Verdict · honoured/mismatch/missing). Latest run id in `data/cf-report/LATEST.txt`.*
