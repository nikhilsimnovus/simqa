import { NextResponse } from 'next/server';
import { generateMatrix, type MatrixRequest } from '@/lib/configFidelity/paramSpace';

export const dynamic = 'force-dynamic';

/** POST a MatrixRequest -> case count + lightweight case list (no execution). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as MatrixRequest;
  const cases = generateMatrix(body ?? ({} as MatrixRequest));
  return NextResponse.json({
    count: cases.length,
    cases: cases.map((c) => ({ id: c.id, rat: c.rat, tags: c.tags })),
  });
}
