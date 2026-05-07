// Build URL probe. The /validate "Test URL" button hits this endpoint with
// a candidate build URL (e.g. http://192.168.0.19/builds/.../foo.tar.gz),
// and the server fetches a single byte (Range: bytes=0-0) to check that:
//
//   1. The URL is reachable from THIS machine (which is the same network as
//      the Simnovator VM that will eventually wget it).
//   2. The Content-Length looks like a tarball (at least non-zero).
//
// Doing the probe server-side bypasses the Chrome "Insecure download blocked"
// warning the user otherwise hits when their browser sees an http:// .tar.gz
// from an https:// referrer. The Simnovator VM downloads the file with wget
// (per the install plan), not the user's browser.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get('url')?.trim();
  if (!url) return NextResponse.json({ ok: false, error: 'missing ?url=' }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: 'url must start with http:// or https://' }, { status: 400 });
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000); // 10s
  try {
    // HEAD first — most build servers support it and it's the cheapest probe.
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
    let bytes: number | undefined;
    if (res.ok) {
      const cl = res.headers.get('content-length');
      bytes = cl ? Number(cl) : undefined;
    } else if (res.status === 405 || res.status === 404) {
      // Some static fileservers don't allow HEAD; fall back to a Range GET of 1 byte.
      res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      const cr = res.headers.get('content-range'); // bytes 0-0/<total>
      const m = cr?.match(/\/(\d+)$/);
      if (m) bytes = Number(m[1]);
      // drain the 1 byte body so the connection can close cleanly
      try { await res.arrayBuffer(); } catch { /* ignore */ }
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, status: res.status, error: `${res.status} ${res.statusText}` });
    }
    return NextResponse.json({ ok: true, status: res.status, bytes, url });
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timed out after 10s' : (e?.message ?? String(e));
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}
