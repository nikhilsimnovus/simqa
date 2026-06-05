#!/usr/bin/env python3
"""Capture Simnovator GUI page screenshots (Global / Cell / UE stats + Logs).

The Simnovator SPA keeps its JWT in-memory only (no localStorage), so we drive
the actual login form in headless Chromium rather than injecting auth state.
After login, we navigate to each stats tab pinned to the resolved iterationId
and save a full-page PNG.

Usage:
    simnovator_screenshot.py --base URL --user U --password P \\
        --iteration-id IID --testcase NAME \\
        [--simulator-name 1] [--testcase-status Completed] \\
        --out-dir DIR [--pages global,cell,ue,logs] [--width 1600 --height 1200]

Exit non-zero on auth or render failure. Prints one OK/SKIPPED/FAILED line
per page to stdout suitable for the script's MANIFEST.
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.parse
from pathlib import Path


# URL templates per page name. {base}, {tc}, {sim}, {status}, {iter} get
# substituted in. Order roughly matches the GUI's left-nav (top-to-bottom).
PAGE_URLS = {
    "global":       "{base}/statistics?tab=global&TestCaseName={tc}&simulatorName={sim}&testCaseStatus={status}&iterationId={iter}",
    "cell":         "{base}/statistics?tab=cell&TestCaseName={tc}&simulatorName={sim}&testCaseStatus={status}&iterationId={iter}",
    "ue":           "{base}/statistics?tab=ue&TestCaseName={tc}&simulatorName={sim}&testCaseStatus={status}&iterationId={iter}",
    "logs":         "{base}/logs?TestCaseName={tc}&simulatorName={sim}&testCaseStatus={status}&iterationId={iter}",
    "health-check": "{base}/tools/health-check",
    "sdr-config":   "{base}/tools/sdr-configuration",
    "simulator-management": "{base}/tools/simulator-management",
}
# Pages where the Settings panel offers a time-range selector. For those we
# click "Since Beginning" + "Apply Changes" before screenshotting so the
# charts show the full test span (not the default last-1h window).
TIME_RANGE_PAGES = {"global", "cell", "ue", "logs"}


def _select_since_beginning(page) -> None:
    """Open the Settings panel and pick the 'Since Beginning' quick range.

    Best-effort: silently no-op if any button is missing (e.g. on a page
    without a Settings panel). All three buttons are queried by visible
    label so we don't depend on CSS-classnames that change per build.
    """
    try:
        page.evaluate(
            "() => {\n"
            "  const open = [...document.querySelectorAll('button')]"
            "    .find(b => b.getAttribute('aria-label')==='Open settings');\n"
            "  if (open) open.click();\n"
            "}"
        )
        page.wait_for_timeout(500)
        page.evaluate(
            "() => {\n"
            "  const sb = [...document.querySelectorAll('button')]"
            "    .find(b => b.textContent.trim()==='Since Beginning');\n"
            "  if (sb) sb.click();\n"
            "}"
        )
        page.wait_for_timeout(300)
        page.evaluate(
            "() => {\n"
            "  const ac = [...document.querySelectorAll('button')]"
            "    .find(b => b.textContent.trim()==='Apply Changes');\n"
            "  if (ac) ac.click();\n"
            "}"
        )
    except Exception:
        pass  # best-effort; the screenshot still happens


def login_and_capture(args) -> int:
    from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = [p.strip() for p in args.pages.split(",") if p.strip()]
    bad = [p for p in pages if p not in PAGE_URLS]
    if bad:
        print(f"FAILED simnovator-screenshot: unknown page(s) {bad}", file=sys.stderr)
        return 2

    wait_ms = int(os.environ.get("SIM_SCREENSHOT_WAIT_MS", "5000"))
    base = args.base.rstrip("/")
    rc = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(
                viewport={"width": args.width, "height": args.height},
                device_scale_factor=1.0,
            )
            page = ctx.new_page()

            # ----- 1) Login via the real form (no persistent auth to inject) -----
            page.goto(f"{base}/", wait_until="load", timeout=20_000)
            # Inputs have placeholders "Enter your username" / "Enter your password".
            page.fill('input[placeholder*="username" i]', args.user, timeout=10_000)
            page.fill('input[placeholder*="password" i]', args.password)
            page.click('button:has-text("Login")')
            # After login the SPA routes to /testcase (My Tests).
            page.wait_for_url("**/testcase**", timeout=15_000)
            print(f"OK simnovator-screenshot: logged in as {args.user}")

            # ----- 2) Capture each requested page -----
            tc_enc = urllib.parse.quote(args.testcase, safe="")
            for pname in pages:
                url = PAGE_URLS[pname].format(
                    base=base, tc=tc_enc, sim=args.simulator_name,
                    status=args.testcase_status, iter=args.iteration_id,
                )
                try:
                    # SPA holds an open WebSocket for live data, so networkidle
                    # never settles. Use `load` and a fixed wait for charts.
                    page.goto(url, wait_until="load", timeout=20_000)
                    page.wait_for_timeout(wait_ms)
                    # For pages with a Settings/time-range panel, drive the
                    # GUI to pick "Since Beginning" so charts show the FULL
                    # test span (default is last 1h which can miss long runs).
                    if pname in TIME_RANGE_PAGES:
                        _select_since_beginning(page)
                        page.wait_for_timeout(2500)  # let charts re-fetch + redraw
                    out = out_dir / f"sim_{pname}.png"
                    page.screenshot(path=str(out), full_page=True)
                    sz = out.stat().st_size
                    print(f"OK simnovator-screenshot: {pname} -> {out.name} bytes={sz}")
                except Exception as exc:  # noqa: BLE001
                    print(f"FAILED simnovator-screenshot: {pname} ({exc})", file=sys.stderr)
                    rc = 1
        finally:
            browser.close()
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base", required=True, help="Simnovator GUI base URL, e.g. http://192.168.1.95")
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--iteration-id", required=True)
    ap.add_argument("--testcase", required=True, help="Test case NAME (not id)")
    ap.add_argument("--simulator-name", default="1")
    ap.add_argument("--testcase-status", default="Completed")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--pages", default="global,cell,ue,logs,health-check",
                    help=("Comma-separated subset of: " + ",".join(PAGE_URLS.keys())))
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1200)
    args = ap.parse_args()
    return login_and_capture(args)


if __name__ == "__main__":
    sys.exit(main())
