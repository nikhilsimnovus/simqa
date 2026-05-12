// shareUrls.ts — common rewrites for cloud share-link URLs so wget / curl can
// actually fetch the file instead of getting a viewer HTML page.
//
// The user pastes a SharePoint / OneDrive / Dropbox share URL into the Build
// Check page. Naïvely fed to wget, those URLs return:
//   • SharePoint / OneDrive personal: 401 (auth wall) or 200 with HTML viewer
//   • Dropbox: 200 with the in-page HTML preview
//   • Google Drive: 200 with the "you need to sign in" HTML
//
// All four have a simple URL-mangling trick that makes them serve the binary
// directly — provided the share permission is "Anyone with the link" (or
// equivalent public-link in each provider's terminology).
//
// We do the rewrite transparently and tell the UI we did it, so the user can
// see what changed.

export interface ShareRewriteResult {
  /** The URL to actually fetch (may equal `original`). */
  url: string;
  /** True when we rewrote the URL. */
  rewritten: boolean;
  /** True when the host looks like a known share-link provider, regardless of
   *  whether we needed to rewrite. */
  isShareHost: boolean;
  /** Human-readable note about what we did, for the UI to show. */
  note?: string;
}

const SHAREPOINT_RE   = /(^|\.)sharepoint\.com$/i;
const ONEDRIVE_RE     = /(^|\.)(onedrive\.live\.com|1drv\.ms)$/i;
const DROPBOX_RE      = /(^|\.)dropbox\.com$/i;
const GOOGLE_DRIVE_RE = /(^|\.)(drive\.google\.com|docs\.google\.com)$/i;

/** True when the URL hostname matches any cloud share provider we know. */
export function isShareUrl(url: string): boolean {
  try {
    const h = new URL(url).host;
    return SHAREPOINT_RE.test(h) || ONEDRIVE_RE.test(h) || DROPBOX_RE.test(h) || GOOGLE_DRIVE_RE.test(h);
  } catch { return false; }
}

/**
 * Rewrite a share URL to its direct-download form. Idempotent — if the URL is
 * already in the right shape, returns it unchanged with `rewritten: false`.
 *
 * Caller still needs to send a browser-like User-Agent (see `shareFetchHeaders`)
 * because some providers reject the default wget/curl UA.
 */
export function rewriteShareUrl(input: string): ShareRewriteResult {
  if (!input || !/^https?:\/\//i.test(input)) {
    return { url: input, rewritten: false, isShareHost: false };
  }
  let u: URL;
  try { u = new URL(input); } catch {
    return { url: input, rewritten: false, isShareHost: false };
  }
  const host = u.host;

  // ── SharePoint / OneDrive personal: append download=1 ──
  if (SHAREPOINT_RE.test(host) || ONEDRIVE_RE.test(host)) {
    if (u.searchParams.get('download') === '1') {
      return { url: input, rewritten: false, isShareHost: true };
    }
    u.searchParams.set('download', '1');
    return {
      url: u.toString(),
      rewritten: true,
      isShareHost: true,
      note: 'SharePoint/OneDrive — appended ?download=1 so the file is served instead of the viewer page. Share permission must be "Anyone with the link".',
    };
  }

  // ── Dropbox: ?dl=1 forces direct download ──
  if (DROPBOX_RE.test(host)) {
    if (u.searchParams.get('dl') === '1') {
      return { url: input, rewritten: false, isShareHost: true };
    }
    u.searchParams.set('dl', '1');
    return {
      url: u.toString(),
      rewritten: true,
      isShareHost: true,
      note: 'Dropbox — set ?dl=1 to bypass the preview page.',
    };
  }

  // ── Google Drive: rewrite to uc?export=download&id=<fileId> ──
  if (GOOGLE_DRIVE_RE.test(host)) {
    // Common forms:
    //   https://drive.google.com/file/d/<id>/view?usp=sharing
    //   https://drive.google.com/open?id=<id>
    //   https://drive.google.com/uc?export=download&id=<id>  (already correct)
    let id: string | null = null;
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (m) id = m[1];
    else if (u.searchParams.get('id')) id = u.searchParams.get('id');
    if (id) {
      const out = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
      if (out === input) return { url: input, rewritten: false, isShareHost: true };
      return {
        url: out,
        rewritten: true,
        isShareHost: true,
        note: 'Google Drive — rewrote to /uc?export=download. Large files (>~100 MB) will need an extra "confirm" step that wget cannot handle; in that case host the file elsewhere.',
      };
    }
    return { url: input, rewritten: false, isShareHost: true };
  }

  return { url: input, rewritten: false, isShareHost: false };
}

/** Headers to send when fetching from a share-link host. Most providers reject
 *  the default `wget/curl` UA and require a real-browser UA. */
export const SHARE_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export function shareFetchHeaders(url: string): Record<string, string> {
  return isShareUrl(url) ? { 'User-Agent': SHARE_USER_AGENT } : {};
}

/** Build the wget command we'll type into the VM's Cockpit terminal for this
 *  URL. For share-link hosts we save to a stable output filename
 *  ('simqa-share-build.tar.gz') so the caller doesn't have to guess what
 *  filename the Content-Disposition header chose. For plain HTTP/S build
 *  hosts we let wget pick the filename from the URL path as before. The
 *  caller is responsible for shell-quoting any external value but the URL we
 *  control is quoted here. */
export const SHARE_OUTPUT_FILENAME = 'simqa-share-build.tar.gz';

export function wgetCommandFor(url: string, dir: string, quote: (s: string) => string): string {
  const isShare = isShareUrl(url);
  if (isShare) {
    // -O writes to a known name (predictable for the extract step), -U sets
    // a Mozilla UA (SharePoint rejects default wget UA), --no-check-certificate
    // accepts self-signed (matches the HTTP-path behaviour).
    return `mkdir -p ${quote(dir)} && cd ${quote(dir)} && wget --no-check-certificate -q --show-progress -U ${quote(SHARE_USER_AGENT)} -O ${quote(SHARE_OUTPUT_FILENAME)} ${quote(url)}`;
  }
  // -c (continue partial), -q --show-progress (quiet body, progress bar only)
  return `mkdir -p ${quote(dir)} && cd ${quote(dir)} && wget --no-check-certificate -c -q --show-progress ${quote(url)}`;
}
