// Send anyone without a session to /login first.
//
// This is a redirect convenience, not the security boundary. Middleware runs on
// the Edge runtime and cannot use node:crypto, so it only checks that a session
// cookie is PRESENT — it does not verify the signature. Every server component
// and route handler that actually uses the identity verifies it properly via
// identity.ts, so a forged cookie gets you a redirect-free page that still sees
// you as signed out.
//
// API routes are deliberately NOT gated: background runners, the self-update
// poller and curl-based lab tooling all call them without a browser cookie, and
// breaking those to enforce sign-in would trade real function for bookkeeping.

import { NextResponse, type NextRequest } from 'next/server';

/** Kept in sync with SESSION_COOKIE in src/lib/identity.ts — not imported,
 *  because that module pulls in node:crypto which the Edge runtime rejects. */
const SESSION_COOKIE = 'simqa-session';

/** Pages reachable without a session. */
const PUBLIC_PATHS = new Set(['/login', '/signup']);

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // The root layout needs the pathname to decide whether to draw the app shell
  // (login and signup render bare). Server components can't read it, so pass it
  // down as a header.
  const withPath = () => {
    const h = new Headers(req.headers);
    h.set('x-simqa-pathname', pathname);
    return NextResponse.next({ request: { headers: h } });
  };

  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) {
    // Already signed in — don't leave them sitting on login/signup.
    if (PUBLIC_PATHS.has(pathname)) {
      const to = req.nextUrl.clone();
      to.pathname = '/';
      to.search = '';
      return NextResponse.redirect(to);
    }
    return withPath();
  }

  if (PUBLIC_PATHS.has(pathname)) return withPath();

  const to = req.nextUrl.clone();
  to.pathname = '/login';
  // Come back to where they were aiming once they've signed in.
  to.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(to);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  //
  // The exclusion is `api/` WITH the slash. Without it the negative lookahead
  // matched any path merely STARTING with "api", so the /api-tests page fell
  // outside the matcher entirely and rendered to anyone with no session at all.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
