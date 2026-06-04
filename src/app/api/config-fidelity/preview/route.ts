import { NextResponse } from 'next/server';
import { generateMatrix, generateBandSweep, type MatrixRequest } from '@/lib/configFidelity/paramSpace';
import type { BandRat } from '@/lib/configFidelity/bandTable';

export const dynamic = 'force-dynamic';

/** POST a MatrixRequest (or {bandSweep:true,...}) -> case count + list (no execution). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as MatrixRequest & { bandSweep?: boolean; bandRats?: BandRat[]; bandDataType?: 'no_data' | 'udp' | 'tcp' };
  const cases = body?.bandSweep
    ? generateBandSweep({ rats: body.bandRats, dataType: body.bandDataType, cap: body.cap })
    : generateMatrix(body ?? ({} as MatrixRequest));
  return NextResponse.json({
    count: cases.length,
    cases: cases.map((c) => ({ id: c.id, rat: c.rat, tags: c.tags })),
  });
}
