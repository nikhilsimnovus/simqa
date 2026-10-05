// POST /api/automation/testcases/import
// Body: { systemId, boxUserId?, pack }
//
// Put a testcase JSON onto a Simnovator, so a test case someone exported — from
// the box's own GUI, or from another lab — can be uploaded here and used in a
// suite without being rebuilt by hand.
//
// `pack` is the box's own export format, which is what the Export button gives
// you:
//
//   { test_case_details: [ { Test_Id, Test_Name, Config_File: { config }, … } ] }
//
// A single testcase object is accepted too and wrapped, because that is what a
// file saved from a GET /v2/testcases/{id} looks like and telling someone
// their file is "the wrong kind of testcase JSON" helps nobody.
//
// The import runs as the chosen box login, so the testcase lands in THAT
// operator's catalogue — the only place they can see it.

import { NextResponse } from 'next/server';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import { toImportPack } from '@/lib/automation/importPack';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any = {};
  try { body = await req.json(); } catch { /* reported below */ }

  const systemId = String(body?.systemId ?? '').trim();
  if (!systemId) return NextResponse.json({ ok: false, error: 'choose a Simnovator first' }, { status: 400 });

  const { pack, error, names } = toImportPack(body?.pack);
  if (!pack) return NextResponse.json({ ok: false, error }, { status: 400 });

  const inv = loadInventory();
  const opts = uesimApiOptsForSystem(inv, systemId, body?.boxUserId ? String(body.boxUserId) : undefined);
  if (!opts) return NextResponse.json({ ok: false, error: `system "${systemId}" not testable` }, { status: 404 });

  try {
    const loginR = await fetch(`http://${opts.host}/v2/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!loginR.ok) return NextResponse.json({ ok: false, error: `the box refused the login (${loginR.status})` }, { status: 502 });
    const loginD: any = await loginR.json();
    const token: string = loginD.access_token ?? loginD.token;

    // multipart, not a JSON body: the endpoint reads the pack out of an
    // uploaded FILE. Posting the same JSON as the body returns
    // 400 "Failed to get file from request".
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(pack)], { type: 'application/json' }), 'testcase.json');
    const r = await fetch(`http://${opts.host}/v2/testcases/import`, {
      method: 'POST',
      // No Content-Type: fetch sets it, with the boundary, from the FormData.
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let d: any; try { d = JSON.parse(text); } catch { d = undefined; }
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `the box rejected the import (${r.status}): ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }

    // The box answers with what it created. Names can come back changed — it
    // renames on collision — so report what it says rather than what was sent.
    const created = (d?.testCases ?? d?.test_cases ?? []).map((t: any) => ({
      id: String(t?.id ?? t?.Test_Id ?? ''),
      name: String(t?.name ?? t?.Test_Name ?? ''),
    })).filter((t: any) => t.id || t.name);

    return NextResponse.json({
      ok: true,
      host: opts.host,
      boxUser: opts.username,
      importedCount: d?.importedCount ?? created.length ?? names.length,
      testcases: created.length ? created : names.map((n) => ({ id: '', name: n })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 502 });
  }
}
