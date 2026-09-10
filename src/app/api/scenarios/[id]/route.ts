// GET / PUT / DELETE a single scenario.
import { NextResponse } from 'next/server';
import { getScenario, updateScenario, deleteScenario } from '@/lib/scenarios';
import { userFromRequest } from '@/lib/identity';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = getScenario(id);
  if (!s) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, scenario: s });
}

/** Keep only the five known cfg slots, as non-empty strings — the same
 *  filtering POST does, so an edit can't store a shape a run would later feed
 *  to a symlink. `null` means "clear the selection" and is preserved as such;
 *  `undefined` means "leave it alone". */
function normalizeCfg(raw: unknown): Record<string, string> | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const k of ['enb', 'gnb', 'mme', 'mme2', 'ims']) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'body is not valid JSON' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'expected a scenario object' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { ...body };

  // A name that is present must be usable — an edit that blanks it would
  // leave a nameless row.
  if ('name' in patch) {
    const n = String(patch.name ?? '').trim();
    if (!n) return NextResponse.json({ ok: false, error: 'name cannot be empty' }, { status: 400 });
    patch.name = n;
  }
  if ('testcaseId' in patch) {
    const t = String(patch.testcaseId ?? '').trim();
    if (!t) return NextResponse.json({ ok: false, error: 'testcaseId cannot be empty' }, { status: 400 });
    patch.testcaseId = t;
  }

  if ('cfgSelection' in patch) {
    const cfg = normalizeCfg(patch.cfgSelection);
    // undefined would be dropped by the JSON round-trip and silently keep the
    // old value, so a cleared selection is stored as an explicit absence.
    if (cfg === null) patch.cfgSelection = undefined;
    else if (cfg === undefined) delete patch.cfgSelection;
    else patch.cfgSelection = cfg;
  }

  const s = updateScenario(id, patch, userFromRequest(req));
  if (!s) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, scenario: s });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!deleteScenario(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
