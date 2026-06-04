import { NextResponse } from 'next/server';
import { generateMatrix, generateBandSweep, type MatrixRequest } from '@/lib/configFidelity/paramSpace';
import { fetchBaseConfig, generateVariationSweep, type TrafficKind } from '@/lib/configFidelity/variationSweep';
import { loadInventory, uesimApiOptsForSystem } from '@/lib/inventory';
import type { BandRat } from '@/lib/configFidelity/bandTable';

export const dynamic = 'force-dynamic';

/** POST a request -> case count + lightweight case list (no execution). Supports
 *  matrix, band sweep ({bandSweep}), and variation ({variationOf}). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as MatrixRequest & {
    bandSweep?: boolean; bandRats?: BandRat[]; bandDataType?: 'no_data' | 'udp' | 'tcp';
    variationOf?: string; traffic?: TrafficKind[]; fading?: string[]; tripTypes?: string[]; targetSystemId?: string;
  };
  try {
    let cases;
    if (body?.variationOf) {
      const api = uesimApiOptsForSystem(loadInventory(), body.targetSystemId);
      if (!api) return NextResponse.json({ error: 'no target system in inventory' }, { status: 400 });
      const base = await fetchBaseConfig({ host: api.host, username: api.username, password: api.password }, body.variationOf);
      cases = generateVariationSweep({ base, traffic: body.traffic, fading: body.fading, tripTypes: body.tripTypes, mode: body.mode, cap: body.cap });
    } else if (body?.bandSweep) {
      cases = generateBandSweep({ rats: body.bandRats, dataType: body.bandDataType, cap: body.cap });
    } else {
      cases = generateMatrix(body ?? ({} as MatrixRequest));
    }
    return NextResponse.json({ count: cases.length, cases: cases.map((c) => ({ id: c.id, rat: c.rat, tags: c.tags })) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 400 });
  }
}
