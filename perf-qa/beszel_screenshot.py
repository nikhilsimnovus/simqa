#!/usr/bin/env python3
"""Capture a Beszel system dashboard screenshot via headless Chromium.

Designed to be called from collect_perf_data.sh as the "auto" path for the
Beszel section. Logs into the PocketBase backend with credentials, finds the
system whose host matches the target IP, then opens its dashboard page in a
headless browser and saves a PNG. The browser receives the PocketBase auth
JWT injected into localStorage so no form fill is needed.

Usage:
    beszel_screenshot.py --hub URL --user EMAIL --password PASS \\
                         --match-host IP [--range 1h|24h|30d] \\
                         --out PATH [--width 1600 --height 1200]

Exit non-zero on any failure (auth, network, system not found, render error).
Prints a single-line status to stdout suitable for inclusion in the script's
MANIFEST.txt.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path


def auth(hub: str, user: str, password: str) -> tuple[str, dict]:
    """POST to /api/collections/users/auth-with-password, return (token, user_record)."""
    url = f"{hub.rstrip('/')}/api/collections/users/auth-with-password"
    body = json.dumps({"identity": user, "password": password}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        d = json.loads(resp.read().decode("utf-8"))
    return d["token"], d["record"]


def find_system(hub: str, token: str, match_host: str) -> dict | None:
    """Find a system whose `host` field matches `match_host`. Returns the record or None."""
    url = f"{hub.rstrip('/')}/api/collections/systems/records?perPage=200"
    req = urllib.request.Request(url, headers={"Authorization": token})
    with urllib.request.urlopen(req, timeout=10) as resp:
        d = json.loads(resp.read().decode("utf-8"))
    for s in d.get("items", []):
        if s.get("host") == match_host:
            return s
    return None


def capture(hub: str, system_id: str, token: str, user_record: dict,
            out_path: Path, time_range: str, width: int, height: int) -> None:
    """Open Beszel /system/<id> in headless Chromium, save PNG."""
    # Import inside the function so callers can `--help` without playwright installed.
    from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]

    auth_payload = json.dumps({"token": token, "record": user_record})
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            ctx = browser.new_context(viewport={"width": width, "height": height},
                                      device_scale_factor=1.0)
            page = ctx.new_page()
            # 1) Hit / once so the SPA origin's localStorage exists.
            page.goto(f"{hub.rstrip('/')}/", wait_until="domcontentloaded", timeout=15_000)
            # 2) Inject PocketBase auth + chart range; reload to bypass login.
            #    Using addInitScript would run on every navigation, but the
            #    SPA reads localStorage at boot — so set then reload.
            #    page.evaluate takes a SINGLE arg; pack both values.
            page.evaluate(
                "(args) => {"
                "  localStorage.setItem('pocketbase_auth', args.auth);"
                "  localStorage.setItem('chartTime', args.range);"
                "}",
                {"auth": auth_payload, "range": time_range},
            )
            # 3) Navigate to the system detail page.
            # Beszel keeps a realtime WebSocket open, so `networkidle` never
            # settles — use `load` and rely on a fixed delay for charts to
            # animate in (recharts ~600ms enter + extra data fetches).
            page.goto(f"{hub.rstrip('/')}/system/{system_id}",
                      wait_until="load", timeout=20_000)
            # 5s covers the top charts (CPU/Mem/Disk/Bandwidth/Swap); 10s
            # gives the slower Load Average aggregate a chance to render.
            # Bump via BESZEL_WAIT_MS env if a system is exceptionally slow.
            import os as _os
            page.wait_for_timeout(int(_os.environ.get("BESZEL_WAIT_MS", "10000")))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(out_path), full_page=True)
        finally:
            browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hub", required=True, help="Beszel hub URL, e.g. http://<beszel-host>:8090")
    ap.add_argument("--user", required=True, help="Beszel login email")
    ap.add_argument("--password", required=True, help="Beszel login password")
    ap.add_argument("--match-host", required=True,
                    help="IP address of the system to capture (matches Beszel's host field)")
    ap.add_argument("--range", default="1h", choices=["1h", "12h", "24h", "1w", "30d"],
                    help="chartTime preset (Beszel's built-in ranges)")
    ap.add_argument("--out", required=True, type=Path, help="Output PNG path")
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1200)
    args = ap.parse_args()

    try:
        token, user_record = auth(args.hub, args.user, args.password)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED beszel auth: {exc}", file=sys.stderr)
        return 2

    try:
        system = find_system(args.hub, token, args.match_host)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED beszel systems list: {exc}", file=sys.stderr)
        return 3
    if not system:
        print(f"SKIPPED beszel: no system found with host={args.match_host} "
              f"(check that {args.user} has access; see Confluence Beszel page)",
              file=sys.stderr)
        return 4

    try:
        capture(args.hub, system["id"], token, user_record,
                args.out, args.range, args.width, args.height)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED beszel screenshot: {exc}", file=sys.stderr)
        return 5

    sz = args.out.stat().st_size if args.out.exists() else 0
    print(f"OK beszel screenshot {args.out.name} system={system['name']!r} "
          f"id={system['id']} range={args.range} bytes={sz}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
