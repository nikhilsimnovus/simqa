// Generate src/lib/configFidelity/bandTable.ts from the vetted master CSV.
import * as fs from 'fs';
const CSV = process.argv[2] || 'C:\\Users\\Simnovus-Lab\\Documents\\master-all-rats.csv';
const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const rows = [];
for (const line of lines.slice(1)) {
  // First 13 columns have no embedded commas (cfg_snippet is the last, quoted).
  const f = line.split(',');
  const [rat, band, duplex, bw, scs, ssbScs, dlArfcn, , ssbArfcn, , , status] = f;
  if (!rat || !/^(NR|LTE|CATM|NBIOT)$/.test(rat)) continue;
  if (status && status !== 'ok') continue;
  rows.push({ rat, band: Number(band), duplex, bwMhz: Number(bw), scsKhz: Number(scs), ssbScsKhz: Number(ssbScs), dlArfcn: Number(dlArfcn), ssbArfcn: Number(ssbArfcn) });
}
const out = `// AUTO-GENERATED from master-all-rats.csv by scripts/gen-bandtable.mjs — do not edit by hand.
// Vetted band / ARFCN table for the band-sweep tests. dlArfcn = dl_nr_arfcn (NR)
// or dl_earfcn (LTE/CATM/NBIOT); ssbArfcn applies to NR only.
export type BandRat = 'NR' | 'LTE' | 'CATM' | 'NBIOT';
export interface BandRow {
  rat: BandRat; band: number; duplex: 'FDD' | 'TDD';
  bwMhz: number; scsKhz: number; ssbScsKhz: number; dlArfcn: number; ssbArfcn: number;
}
export const BAND_TABLE: BandRow[] = ${JSON.stringify(rows, null, 0).replace(/\},/g, '},\n  ').replace(/^\[/, '[\n  ').replace(/\]$/, ',\n]')};
`;
fs.writeFileSync('src/lib/configFidelity/bandTable.ts', out);
const byRat = rows.reduce((a, r) => ((a[r.rat] = (a[r.rat] || 0) + 1), a), {});
console.log('wrote', rows.length, 'rows:', JSON.stringify(byRat));
