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
//
// Cloud share URLs (SharePoint / OneDrive / Dropbox / Google Drive) are
// rewritten transparently — see src/lib/shareUrls.ts. The response includes
// a `rewrittenTo` field so the UI can show "we fetched a slightly different
// URL than you typed".

import { NextResponse } from 'next/server';
import { rewriteShareUrl, shareFetchHeaders, isShareUrl } from '@/lib/shareUrls';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const urlRaw = new URL(req.url).searchParams.get('url')?.trim();
  if (!urlRaw) return NextResponse.json({ ok: false, error: 'missing ?url=' }, { status: 400 });
  if (!/^https?:\/\//i.test(urlRaw)) {
    return NextResponse.json({ ok: false, error: 'url must start with http:// or https://' }, { status: 400 });
  }

  // Transparently rewrite SharePoint/OneDrive/Dropbox/GDrive share URLs to
  // their direct-download forms before probing.
  const rew = rewriteShareUrl(urlRaw);
  const fetchUrl = rew.url;
  const shareHeaders = shareFetchHeaders(fetchUrl);

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    // HEAD first — cheapest. Share-host servers (SharePoint) sometimes 405
    // HEAD on the rewritten URL, so we fall through to a 1-byte Range GET.
    let res = await fetch(fetchUrl, { method: 'HEAD', redirect: 'follow', signal: ac.signal, headers: shareHeaders });
    let bytes: number | undefined;
    let usedRangeGet = false;
    if (res.ok) {
      const cl = res.headers.get('content-length');
      bytes = cl ? Number(cl) : undefined;
    } else if (res.status === 405 || res.status === 404 || isShareUrl(fetchUrl)) {
      // HEAD not allowed, or share host: do a Range GET that asks for just
      // the first byte. Servers honour this much more consistently.
      usedRangeGet = true;
      res = await fetch(fetchUrl, {
        method: 'GET',
        headers: { ...shareHeaders, Range: 'bytes=0-0' },
        signal: ac.signal,
        redirect: 'follow',
      });
      const cr = res.headers.get('content-range'); // bytes 0-0/<total>
      const m = cr?.match(/\/(\d+)$/);
      if (m) bytes = Number(m[1]);
      try { await res.arrayBuffer(); } catch { /* drain */ }
    }

    if (!res.ok) {
      // Friendly hints. With share-URL rewrite now handled upstream, a 401/403
      // here means the user hasn't set the share to "Anyone with the link".
      const host = (() => { try { return new URL(fetchUrl).host; } catch { return ''; } })();
      const isMsShare = /sharepoint\.com|onedrive\.live\.com|1drv\.ms/.test(host);
      const isGShare  = /drive\.google\.com|docs\.google\.com/.test(host);
      const isDbx     = /dropbox\.com/.test(host);
      let hint = `${res.status} ${res.statusText}`;
      if (res.status === 401 || res.status === 403) {
        if (isMsShare)      hint = `${res.status} ${res.statusText} — SharePoint/OneDrive denied access. Share the file as "Anyone with the link" (right-click → Manage access → Anyone with the link → Save). The download=1 trick only bypasses the viewer page; the underlying share permission still has to be public-link.`;
        else if (isGShare)  hint = `${res.status} ${res.statusText} — Google Drive denied access. Set sharing to "Anyone with the link". Large files (>~100MB) need the manual confirm-token step that wget cannot handle.`;
        else if (isDbx)     hint = `${res.status} ${res.statusText} — Dropbox denied access. Verify the share link is set to public and contains ?dl=1.`;
        else                hint = `${res.status} ${res.statusText} — server requires authentication. wget on the VM won't be able to log in.`;
      } else if (res.status === 404) {
        hint = '404 Not Found — the URL is wrong or the build is no longer published.';
      } else if (res.status >= 500) {
        hint = `${res.status} ${res.statusText} — build server is unhealthy. Try again in a moment.`;
      }
      return NextResponse.json({
        ok: false, status: res.status, error: hint,
        rewrittenTo: rew.rewritten ? rew.url : undefined,
        rewriteNote: rew.rewritten ? rew.note : undefined,
        usedRangeGet,
      });
    }

    // Sanity: SharePoint will sometimes 200-OK an HTML viewer page even with
    // download=1 if the file is missing. Check Content-Type — if it looks
    // like HTML and we got <50 KB, flag it. Real tarballs are MB-sized
    // application/x-gzip or application/octet-stream.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (rew.isShareHost && /\btext\/html\b/.test(ct) && (bytes === undefined || bytes < 50_000)) {
      return NextResponse.json({
        ok: false, status: res.status,
        error: 'Share host returned HTML, not a tarball. The link probably requires sign-in or the file was removed. Verify the share permission is "Anyone with the link".',
        rewrittenTo: rew.rewritten ? rew.url : undefined,
        rewriteNote: rew.rewritten ? rew.note : undefined,
        contentType: ct,
        usedRangeGet,
      });
    }

    return NextResponse.json({
      ok: true, status: res.status, bytes, url: fetchUrl,
      rewrittenTo: rew.rewritten ? rew.url : undefined,
      rewriteNote: rew.rewritten ? rew.note : undefined,
      contentType: ct || undefined,
      usedRangeGet,
    });
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? 'timed out after 10s' : (e?.message ?? String(e));
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  } finally {
    clearTimeout(t);
  }
}
