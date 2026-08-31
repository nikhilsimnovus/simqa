// GET /api/jobs/container-health?host=192.168.1.102
//
// Which containers the installed build is running on a station, and whether
// any of them is down. The Job Tracker's build view polls this so "the build
// installed" can be backed by evidence rather than an installer exit code.

import { NextResponse } from 'next/server';
import { fetchContainerHealth } from '@/lib/jobTracker/containerHealth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const host = new URL(req.url).searchParams.get('host');
  if (!host) return NextResponse.json({ ok: false, error: 'host is required' }, { status: 400 });
  const health = await fetchContainerHealth(host);
  return NextResponse.json({ ok: true, health });
}
