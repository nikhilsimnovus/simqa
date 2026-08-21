// Dashboard.
//
// Performance shape matters here: this page talks to the UESIM box, which in
// a lab is routinely switched off. It used to `await` those calls before
// returning any HTML, so an unreachable box held the whole page hostage for
// the length of a TCP connect timeout.
//
// Now the shell renders immediately and each live section streams in under
// its own <Suspense>. Local data (run history, inventory counts) is on disk
// and renders in the first flush; only the network-dependent cards show a
// skeleton. Worst case on a dead box is a slightly delayed card, never a
// delayed page.

import { Suspense, cache } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Stat, Badge, Kicker } from '@/components/ui';
import { loadInventory, uesimApiOptsFromInventory } from '@/lib/inventory';
import { listTestcases, listSimulators } from '@/lib/uesimClient';
import { listRuns } from '@/lib/runStore';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

/**
 * One network round to the box per request, shared by every card that needs
 * it. React's `cache` dedupes across components in the same render, so the
 * stats row and the simulators card don't each pay for a login.
 */
const getLive = cache(async () => {
  const inv = loadInventory();
  const apiOpts = uesimApiOptsFromInventory(inv);
  if (!apiOpts) return { apiOpts: null, tcs: { items: [], total: 0 }, sims: { items: [] as any[] } };
  const [tcs, sims] = await Promise.all([
    safe(() => listTestcases(apiOpts, 1, 0), { items: [], total: 0 }),
    safe(() => listSimulators(apiOpts), { items: [] as any[] }),
  ]);
  return { apiOpts, tcs, sims };
});

export default function DashboardPage() {
  // Disk-only — cheap enough to do in the synchronous shell.
  const inv = loadInventory();
  const apiOpts = uesimApiOptsFromInventory(inv);
  const runs = listRuns(5);

  return (
    <>
      <Header
        title="Dashboard"
        subtitle="Overview of the test environment and recent activity"
        uesimHost={apiOpts?.host}
      />
      <main className="p-5 space-y-4">
        <Suspense fallback={<StatsSkeleton host={apiOpts?.host} inv={inv} />}>
          <StatsRow inv={inv} />
        </Suspense>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Local data — no skeleton needed, it is in the first flush. */}
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Recent runs</CardTitle>
              <Link href="/runs" className="text-xs text-primary-700 hover:underline">View all</Link>
            </CardHeader>
            <CardBody className="p-0">
              {runs.length === 0 ? (
                <div className="p-4 text-[13px] text-slate-500">No runs yet. Trigger one from the Test Cases page.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <Link href={`/runs/${r.id}`} className="block px-4 py-2.5 hover:bg-slate-50">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">{r.testcaseId}</div>
                            <div className="text-xs text-slate-500 truncate">{new Date(r.startedAt).toLocaleString()} · {r.id}</div>
                          </div>
                          <RunStatusBadge status={r.status} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Simulators</CardTitle>
              <Link href="/inventory" className="text-xs text-primary-700 hover:underline">Manage inventory</Link>
            </CardHeader>
            <CardBody className="p-0">
              <Suspense fallback={<div className="p-4 text-[13px] text-slate-500">Checking the box…</div>}>
                <SimulatorList />
              </Suspense>
            </CardBody>
          </Card>
        </div>
      </main>
    </>
  );
}

// ───────────────────── Live (streamed) sections ─────────────────────

async function StatsRow({ inv }: { inv: ReturnType<typeof loadInventory> }) {
  const { apiOpts, tcs, sims } = await getLive();
  const reachable = !!apiOpts && (sims.items?.length ?? 0) > 0;
  return (
    <StatsGrid>
      <Stat label="UESIM"      value={apiOpts?.host ?? '—'}    hint={reachable ? 'reachable' : 'not reachable'} />
      <Stat label="Testcases"  value={tcs.total ?? '—'}         hint={apiOpts ? 'on the box' : 'add a UESIM in Systems'} />
      <Stat label="Simulators" value={sims.items?.length ?? 0} hint="registered slots" />
      <Stat label="Inventory"  value={inv.systems.length}       hint={`${inv.profiles.length} topology profile${inv.profiles.length === 1 ? '' : 's'}`} />
    </StatsGrid>
  );
}

async function SimulatorList() {
  const { apiOpts, sims } = await getLive();
  if (!apiOpts || (sims.items?.length ?? 0) === 0) {
    return (
      <div className="p-4 text-[13px] text-slate-500">
        {apiOpts ? 'No simulators registered on the box.' : 'Add a UESIM system in Systems Management.'}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {sims.items.map((s: any) => (
        <li key={s.id} className="px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-900">{s.name}</div>
              <div className="text-xs text-slate-500">id={s.id} · type={s.type} · {(s as any).nodes?.ipaddress ?? ''}</div>
            </div>
            <SimulatorBadge connectivity={s.connectivity} stability={s.stability} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────── Shell bits ─────────────────────

function StatsGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>;
}

/** Same geometry as the real row, so streaming in causes no layout shift. */
function StatsSkeleton({ host, inv }: { host?: string; inv: ReturnType<typeof loadInventory> }) {
  return (
    <StatsGrid>
      <Stat label="UESIM"      value={host ?? '—'} hint="checking…" />
      <PendingStat label="Testcases"  hint="on the box" />
      <PendingStat label="Simulators" hint="registered slots" />
      {/* Local — known without the network, so show the real number now. */}
      <Stat label="Inventory" value={inv.systems.length} hint={`${inv.profiles.length} topology profile${inv.profiles.length === 1 ? '' : 's'}`} />
    </StatsGrid>
  );
}

function PendingStat({ label, hint }: { label: string; hint: string }) {
  return (
    <Card accent>
      <CardBody>
        <Kicker>{label}</Kicker>
        <div className="num mt-1.5 text-lg font-bold leading-tight text-slate-300">—</div>
        <div className="mt-1 text-[11px] font-light text-slate-500">{hint}</div>
      </CardBody>
    </Card>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  if (status === 'passed')   return <Badge tone="success">passed</Badge>;
  if (status === 'failed')   return <Badge tone="danger">failed</Badge>;
  if (status === 'running')  return <Badge tone="info">running</Badge>;
  if (status === 'queued')   return <Badge tone="warning">queued</Badge>;
  return <Badge>{status}</Badge>;
}

function SimulatorBadge({ connectivity, stability }: { connectivity?: string; stability?: string }) {
  if (connectivity === 'CONNECTED' && stability === 'STABLE') return <Badge tone="success">connected</Badge>;
  if (connectivity === 'DISCONNECTED') return <Badge tone="danger">disconnected</Badge>;
  return <Badge tone="warning">{connectivity ?? '—'}</Badge>;
}
