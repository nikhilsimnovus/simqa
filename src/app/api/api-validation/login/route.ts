// POST /api/api-validation/login
//
// Log in to the Simnovator once so the run can reuse the token — and so a
// wrong address or password is reported here rather than forty APIs later.

import { NextResponse } from 'next/server';
import { activeSpec } from '@/lib/apiValidation/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  for (const k of ['host', 'username', 'password']) {
    if (!String(body[k] ?? '').trim()) {
      return NextResponse.json(
        { ok: false, message: 'server address, username and password are required' },
        { status: 400 },
      );
    }
  }
  const host = String(body.host).trim().replace(/\/$/, '');
  const base = (host.includes('://') ? host : `http://${host}`) + activeSpec().basePath;
  const url = `${base}/login`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: body.username, password: body.password }),
      signal: ac.signal,
    });
    const text = await r.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* a non-JSON answer is quoted below */ }
    if (r.status !== 200 || !data.access_token) {
      return NextResponse.json({
        ok: false,
        message: `HTTP ${r.status}: ${data.message ?? data.code ?? text.slice(0, 200)}`,
      });
    }
    return NextResponse.json({
      ok: true, token: data.access_token, roles: data.roles ?? [], expires_in: data.expires_in,
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      message: `cannot reach ${url}: ${e?.name ?? 'Error'}: ${e?.message ?? e}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
