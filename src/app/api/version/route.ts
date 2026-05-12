// GET /api/version — returns the build version of THIS simqa install so you
// can confirm from curl/the page whether the running app is on the tarball
// you just deployed (without having to grep node processes or extracted dirs).
//
// Sample:
//   curl -s http://localhost:8080/api/version
//   {"version":"20260512-d391445","sha":"d391445","date":"20260512","source":"cwd"}

import { NextResponse } from 'next/server';
import { getSimqaVersion } from '@/lib/version';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getSimqaVersion(), { headers: { 'Cache-Control': 'no-store' } });
}
