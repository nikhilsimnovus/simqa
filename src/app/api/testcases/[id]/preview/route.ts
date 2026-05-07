import { NextResponse } from 'next/server';
import { getTestcase } from '@/lib/uesimClient';
import { generateConfigs, type UesimTestDefinition } from '@/lib/cfgGenerator';
import { uesimApiOptsFromInventory, loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

/** GET /api/testcases/:id/preview -> { files, summary } without persisting. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const inv = loadInventory();
  const opts = uesimApiOptsFromInventory(inv);
  if (!opts) return NextResponse.json({ error: 'no UESIM in inventory' }, { status: 400 });
  try {
    const tc = await getTestcase(opts, id);
    if (!tc.testDefinition) return NextResponse.json({ error: 'no testDefinition' }, { status: 502 });
    const bundle = generateConfigs(tc.testDefinition as UesimTestDefinition, id);
    return NextResponse.json(bundle);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 502 });
  }
}
