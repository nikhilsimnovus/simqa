// Finding the OTA messages in a Simnovator execution log.
//
// Written against the real thing, not a guess. A record from
// GET /v2/testcases/executions/{eid}/logs on 192.168.1.102 looks like:
//
//   {"cellId":1,"direction":"DL","executionId":"01a15f34-…","index":4,
//    "layer":"RRC","logData":["BCCH-BCH-NR: MIB\n{\n  message mib: {…"],
//    "simulatorId":"Simulator_test","subLayer":"PSS","sipIndex":-1,
//    "testCaseId":"SA_2cell_Mobility_MultiPDN_automation",
//    "timestamp":1792598688420000,"ueId":61441}
//
// So one OTA message instance is ONE ENTRY of logData, and its first line is
// "<CHANNEL>: <Message Name>" with the ASN.1 decode beneath it. That is the
// message boundary; it is not a text search over the log, which is what the
// requirement means by "identify actual OTA message instances using the
// decoded message structure".
//
// Three things learned from a real execution that shape this:
//
//  1. The names are sentence case with spaces -- "RRC reconfiguration",
//     "RRC setup", "Registration accept" -- NOT the CamelCase of the
//     requirement's examples ("RRCReconfiguration", "RRCSetup"). A rule
//     written either way has to find the same messages, so names are
//     compared with separators and case removed.
//
//  2. "RRC reconfiguration" (6 instances) and "RRC reconfiguration complete"
//     (6 instances) are DIFFERENT messages. A containment match for the
//     first would find 12. So a name match is the WHOLE name, never a
//     substring -- otherwise every count involving a request/response pair
//     is silently doubled.
//
//  3. Not every logData entry is a message. The same execution carries
//     "New state : 5GMM-REGISTERED CM-IDLE", "IP addr=10.10.1.2 APN='…'"
//     and "NR cell change from PCI 500 to 501". Those are events, and a
//     message instance must have a "CHANNEL: Name" first line to count.
//
// Pure, imports nothing, so node --test can load this directly.

/** One record as the logs endpoint serves it. Only the fields used here. */
export interface LogRecord {
  executionId?: string;
  testCaseId?: string;
  layer?: string;
  subLayer?: string;
  direction?: string;
  cellId?: number;
  ueId?: number;
  index?: number;
  timestamp?: number;
  logData?: unknown;
}

/** One decoded OTA message found in the log. */
export interface OtaMessage {
  /** The message name as the log spells it — "RRC reconfiguration". */
  name: string;
  /** The channel or NAS protocol in front of it — "DCCH-NR", "5GMM". */
  channel: string;
  /** Everything under the first line: the ASN.1 decode. */
  body: string;
  layer: string;
  direction: string;
  cellId?: number;
  ueId?: number;
  /** The record's own index, so a result can point back at the log. */
  index?: number;
  timestamp?: number;
}

/** The layers that carry OTA signalling. PHY, MAC, RLC, PDCP and IP records
 *  are in the same log and are not OTA messages. */
export const OTA_LAYERS = ['RRC', 'NAS'];

/**
 * Compare two message names ignoring case and separators.
 *
 * "RRCReconfiguration", "RRC reconfiguration", "rrc_reconfiguration" and
 * "RRC-Reconfiguration" are one message. Without this every rule written
 * from the requirement's own examples would match nothing, because the box
 * spells them with spaces.
 */
export function normaliseName(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The "CHANNEL: Name" head of a decoded message, or undefined when the
 *  entry is an event rather than a message. */
export function splitHead(firstLine: string): { channel: string; name: string } | undefined {
  const line = String(firstLine ?? '').trim();
  if (!line) return undefined;
  // "New state : 5GMM-REGISTERED-INITIATED   CM-IDLE" has a colon but is an
  // event; its left side is prose with a space before the colon.
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*(\S.*)$/.exec(line);
  if (!m) return undefined;
  const channel = m[1].trim();
  const name = m[2].trim();
  // A channel is a short token like DCCH-NR, BCCH-BCH-NR, 5GMM, 5GSM.
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(channel) || channel.length > 16) return undefined;
  // "IP addr=10.10.1.2 APN='…'" -- a name holding '=' is a key/value event.
  if (name.includes('=')) return undefined;
  return { channel, name };
}

/** Every OTA message in these records, in log order. */
export function parseMessages(records: LogRecord[], layers: string[] = OTA_LAYERS): OtaMessage[] {
  const want = new Set(layers.map((l) => l.toUpperCase()));
  const out: OtaMessage[] = [];
  for (const r of records ?? []) {
    const layer = String(r?.layer ?? '').toUpperCase();
    if (!want.has(layer)) continue;
    const data = Array.isArray(r?.logData) ? r.logData : [];
    for (const entry of data) {
      if (typeof entry !== 'string') continue;
      const nl = entry.indexOf('\n');
      const first = nl < 0 ? entry : entry.slice(0, nl);
      const head = splitHead(first);
      if (!head) continue;                       // an event, not a message
      out.push({
        name: head.name,
        channel: head.channel,
        body: nl < 0 ? '' : entry.slice(nl + 1),
        layer,
        direction: String(r?.direction ?? ''),
        cellId: typeof r?.cellId === 'number' ? r.cellId : undefined,
        ueId: typeof r?.ueId === 'number' ? r.ueId : undefined,
        index: typeof r?.index === 'number' ? r.index : undefined,
        timestamp: typeof r?.timestamp === 'number' ? r.timestamp : undefined,
      });
    }
  }
  return out;
}

/**
 * The messages a rule's name selects.
 *
 * Whole-name equality after normalising, for the reason in the header: a
 * containment match for "RRC reconfiguration" would also take every "RRC
 * reconfiguration complete" and double the count.
 */
export function messagesNamed(messages: OtaMessage[], name: string): OtaMessage[] {
  const want = normaliseName(name);
  if (!want) return [];
  return messages.filter((m) => normaliseName(m.name) === want);
}

/** What a log actually contains, for the report and for telling an empty
 *  result from a log that was never fetched. */
export function messageTally(messages: OtaMessage[]): Array<{ name: string; channel: string; count: number }> {
  const by = new Map<string, { name: string; channel: string; count: number }>();
  for (const m of messages) {
    const k = normaliseName(m.name);
    const prev = by.get(k);
    if (prev) prev.count += 1;
    else by.set(k, { name: m.name, channel: m.channel, count: 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Do these records belong to the execution we asked about?
 *
 * The requirement is explicit that logs from another execution must never be
 * processed. Every record carries its own executionId, so this is checkable
 * rather than assumed.
 */
export function recordsBelongTo(records: LogRecord[], executionId: string): {
  ok: boolean; checked: number; foreign: string[];
} {
  const foreign = new Set<string>();
  let checked = 0;
  for (const r of records ?? []) {
    const id = r?.executionId;
    if (typeof id !== 'string' || !id) continue;
    checked += 1;
    if (id !== executionId) foreign.add(id);
  }
  return { ok: foreign.size === 0, checked, foreign: [...foreign] };
}
