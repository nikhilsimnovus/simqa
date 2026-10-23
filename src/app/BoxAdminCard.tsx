'use client';

// What the box's administrator sees — and what admin is FOR.
//
// admin is not an operator. It creates the users and the simulators, it is
// shown everybody's, and the Simnovator does not execute test cases as it.
// The dashboard used to show an "admin" tile beside the operators, which read
// as a person who happened never to be running anything.
//
// So admin gets its own view, of the things only admin can see: how the box
// is installed (regular or container), the product version, every login with
// the role it holds and the simulators assigned to it, and every simulator
// with its connectivity and the RF cards it holds.
//
// Read-only, and loaded on demand: it is four calls to the box and nobody
// needs them until they open it.

import React, { useState } from 'react';
import { Card, CardBody, CardHeader, CardTitle, Badge } from '@/components/ui';

interface AdminView {
  ok: boolean;
  host?: string;
  haveAdmin?: boolean;
  note?: string;
  error?: string;
  usersReadable?: boolean;
  version?: { version?: string; build?: string } | null;
  installMode?: 'regular' | 'container' | 'mixed' | null;
  installLine?: string;
  users?: Array<{ username: string; roles: string[]; isAdmin: boolean; canExecute: boolean; simulators: Array<{ id: string; name?: string }> }>;
  executing?: string[];
  simulators?: Array<{
    id: string; name?: string; availability?: string; connectivity?: string;
    cards: number[]; assignedTo: string[]; cardHolders: number[];
  }>;
  hosts?: Array<{ name: string; rfAllocation?: string; nodes: Array<{ host: string; mode?: string; agentConnected?: boolean; os?: string }> }>;
}

export default function BoxAdminCard({ systemId, host }: { systemId: string; host: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AdminView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/stations/box-admin?systemId=${encodeURIComponent(systemId)}`);
      setData(await r.json());
    } catch (e: any) {
      setData({ ok: false, error: String(e?.message ?? e) });
    } finally { setBusy(false); }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !busy) void load();
  };

  return (
    <Card className="shrink-0">
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <span>Box administration</span>
          <span className="text-[11px] font-normal text-slate-500">
            {host} · what the admin login can see
          </span>
        </CardTitle>
        <button onClick={toggle}
          className="rounded-md border border-slate-300 hover:bg-slate-50 text-xs px-3 py-1">
          {open ? 'Hide' : busy ? 'Reading…' : 'Show'}
        </button>
      </CardHeader>

      {open && (
        <CardBody className="p-3 space-y-3">
          {busy && !data && <p className="text-xs text-slate-500">Reading the box…</p>}
          {data && data.ok === false && (
            <p className="text-xs text-rose-700">{data.error ?? 'the box could not be read'}</p>
          )}
          {data?.ok && data.haveAdmin === false && (
            <p className="text-xs text-slate-600">{data.note}</p>
          )}

          {data?.ok && data.haveAdmin && (
            <>
              {/* How the box is installed. A simulator whose mode is not the
                  box's own is left over from an earlier install — which is
                  exactly the shape that produces one nothing can run on. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={data.installMode === 'mixed' ? 'warning' : 'info'}>
                  {data.installMode ?? 'mode unknown'}
                </Badge>
                <span className="text-slate-600">{data.installLine}</span>
                {data.version?.version && (
                  <span className="text-slate-400">
                    · Simnovator {data.version.version}{data.version.build ? ` (${data.version.build})` : ''}
                  </span>
                )}
              </div>

              {/* Who exists, what they hold, and who may execute. */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Users on the box
                </p>
                {data.usersReadable === false ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    This build answers 403 for the user list — user management is switched off on it.
                  </p>
                ) : (
                  <table className="mt-1 w-full text-[11px]">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left font-medium py-0.5">Login</th>
                        <th className="text-left font-medium py-0.5">Role</th>
                        <th className="text-left font-medium py-0.5">Simulators</th>
                        <th className="text-left font-medium py-0.5">Executes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(data.users ?? []).map((u) => (
                        <tr key={u.username}>
                          <td className="py-0.5 font-medium text-slate-800">{u.username}</td>
                          <td className="py-0.5 text-slate-600">{u.roles.join(', ') || '—'}</td>
                          <td className="py-0.5 font-mono text-slate-600">
                            {u.simulators.map((s) => s.name ?? s.id).join(', ') || '—'}
                          </td>
                          <td className="py-0.5">
                            {u.canExecute
                              ? <span className="text-emerald-700">yes</span>
                              : <span className="text-slate-500" title="admin manages the box; the Simnovator does not execute test cases as admin">
                                  no — administrator
                                </span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-1 text-[10px] text-slate-500">
                  admin is the box&rsquo;s main account and holds every right on it — creating users and
                  simulators, assigning RF — but it is not an operator: test cases run as a user login.
                  A suite set to run as admin is refused before it touches anything.
                </p>
              </div>

              {/* The simulators themselves, with who owns them and what they hold. */}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Simulators
                </p>
                <table className="mt-1 w-full text-[11px]">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="text-left font-medium py-0.5">Name</th>
                      <th className="text-left font-medium py-0.5">State</th>
                      <th className="text-left font-medium py-0.5">Assigned to</th>
                      <th className="text-left font-medium py-0.5">RF cards</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data.simulators ?? []).map((s) => {
                      const down = String(s.connectivity ?? '').toUpperCase() === 'DISCONNECTED';
                      return (
                        <tr key={s.id}>
                          <td className="py-0.5 font-medium text-slate-800">{s.name ?? s.id}</td>
                          <td className={`py-0.5 ${down ? 'text-rose-700' : 'text-slate-600'}`}>
                            {s.connectivity ?? '—'} · {s.availability ?? '—'}
                            {down ? ' — nothing can execute on it' : ''}
                          </td>
                          <td className="py-0.5 text-slate-600">{s.assignedTo.join(', ') || '—'}</td>
                          <td className="py-0.5 font-mono text-slate-600">
                            {(s.cardHolders.length ? s.cardHolders : s.cards).join(', ') || '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}
