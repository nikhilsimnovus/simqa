// Dashboard. Server-rendered: pulls live from the UESIM box on each request.

import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle, Stat, Badge } from '@/components/ui';
import { loadInventory, uesimApiOptsFromInventory } from '@/lib/inventory';
import { listTestcases, listSimulators } from '@/lib/uesimClient';
import { listRuns } from '@/lib/runStore';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

export default async function DashboardPage() {
  const inv = loadInventory();
  const apiOpts = uesimApiOptsFromInventory(inv);

  const [tcs, sims, runs] = await Promise.all([
    apiOpts ? safe(() => listTestcases(apiOpts, 1, 0), { items: [], total: 0 }) : Promise.resolve({ items: [], total: 0 }),
    apiOpts ? safe(() => listSimulators(apiOpts), { items: [] as any[] }) : Promise.resolve({ items: [] as any[] }),
    Promise.resolve(listRuns(5)),
  ]);

  const reachable = !!apiOpts && (sims.items?.length ?? 0) > 0;

  return (
    <>
      <Header
        title="Dashboard"
        subtitle="Overview of the test environment and recent activity"
        uesimHost={apiOpts?.host}
      />
      <main className="p-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="UESIM"      value={apiOpts?.host ?? '—'}     hint={reachable ? 'reachable' : 'not configured'} />
          <Stat label="Testcases"  value={tcs.total ?? '—'}          hint={apiOpts ? 'on the box' : 'add a UESIM in Inventory'} />
          <Stat label="Simulators" value={sims.items?.length ?? 0}  hint="registered slots" />
          <Stat label="Inventory"  value={inv.systems.length}        hint={`${inv.profiles.length} topology profile${inv.profiles.length === 1 ? '' : 's'}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle>Recent runs</CardTitle>
              <Link href="/runs" className="text-xs text-primary-700 hover:underline">View all</Link>
            </CardHeader>
            <CardBody className="p-0">
              {runs.length === 0 ? (
                <div className="p-5 text-sm text-slate-500">No runs yet. Trigger one from the Test Cases page.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <Link href={`/runs/${r.id}`} className="block px-5 py-3 hover:bg-slate-50">
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
              {(!apiOpts || (sims.items?.length ?? 0) === 0) ? (
                <div className="p-5 text-sm text-slate-500">{apiOpts ? 'No simulators registered on the box.' : 'Add a UESIM system to inventory.yaml.'}</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {sims.items.map((s: any) => (
                    <li key={s.id} className="px-5 py-3">
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
              )}
            </CardBody>
          </Card>
        </div>
      </main>
    </>
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
