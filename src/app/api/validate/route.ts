import { NextResponse } from 'next/server';
import { runValidationPlan, type ValidationPlanRequest } from '@/lib/validator';
import { loadInventory } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json()) as ValidationPlanRequest;
  const inv = loadInventory();
  // Synchronous: validation finishes in <60s for the standard checks. If
  // the request includes a build install or a sample-execution, it can
  // run longer; the client uses a higher fetch timeout for that path.
  const result = await runValidationPlan(inv, body ?? {});
  return NextResponse.json(result);
}
