// Settings.
//
// Two honest sections rather than one: what actually works today (Account,
// Build & Version — both real, both read from the same session/version data
// every other page uses), and what does not exist yet. The "Coming soon" list
// was previously the whole page; it is now a clearly-labelled subsection, not
// something a user could mistake for a working control.

import Link from 'next/link';
import { Users, Bell, Timer, Moon, Info, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Card, CardBody } from '@/components/ui';
import { currentUser, SESSION_MAX_AGE_SEC } from '@/lib/identity';
import { getSimqaVersion } from '@/lib/version';
import { SignOutButton } from './SignOutButton';

export const dynamic = 'force-dynamic';

const UPCOMING: Array<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  tone: 'sky' | 'violet' | 'emerald' | 'slate';
}> = [
  {
    icon: Users, tone: 'sky',
    title: 'Per-user Workspace',
    desc: 'Separate saved views and preferences per teammate, for labs more than one person shares.',
  },
  {
    icon: Bell, tone: 'violet',
    title: 'Run Notifications',
    desc: 'An email or Slack ping when a run or job finishes — no more polling the page to see if it’s done.',
  },
  {
    icon: Timer, tone: 'emerald',
    title: 'Default Polling & Timeout',
    desc: 'Set the poll interval and timeout every new run starts with, instead of the current built-in defaults.',
  },
  {
    icon: Moon, tone: 'slate',
    title: 'Theme',
    desc: 'A dark mode to match Simnovator’s own dark UI, for anyone who runs the two side by side.',
  },
];

const TONE_CLASSES: Record<string, { bg: string; text: string; ring: string }> = {
  sky:     { bg: 'bg-sky-50',     text: 'text-sky-600',     ring: 'ring-sky-100' },
  violet:  { bg: 'bg-violet-50',  text: 'text-violet-600',  ring: 'ring-violet-100' },
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', ring: 'ring-emerald-100' },
  slate:   { bg: 'bg-slate-100',  text: 'text-slate-600',   ring: 'ring-slate-200' },
};

function ComingSoonBadge() {
  return (
    <span className="shrink-0 inline-flex items-center rounded-full bg-amber-100 text-amber-800 ring-1 ring-amber-200 px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold">
      Coming soon
    </span>
  );
}

export default async function SettingsPage() {
  const user = await currentUser();
  const ver = getSimqaVersion();
  const sessionDays = Math.round(SESSION_MAX_AGE_SEC / 86400);

  return (
    <>
      <Header title="Settings" subtitle="Workspace settings and preferences" />
      <main className="p-6 flex flex-col gap-8 max-w-4xl">
        {/* ── Available now ──────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            Available now
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardBody className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="h-10 w-10 shrink-0 rounded-full bg-orange-100 text-orange-700 text-sm font-bold flex items-center justify-center">
                      {(user || '?').slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {user || 'Not signed in'}
                      </div>
                      <div className="text-xs text-slate-500">Account</div>
                    </div>
                  </div>
                  <SignOutButton />
                </div>
                <p className="mt-3.5 text-xs text-slate-500 leading-relaxed">
                  This name is attributed to every playlist, testcase and job you create, and to
                  the stations you last used. Sessions last {sessionDays} days before you need to
                  sign in again.
                </p>
              </CardBody>
            </Card>

            <Card>
              <CardBody className="p-5">
                <div className="flex items-center gap-3">
                  <span className="h-10 w-10 shrink-0 rounded-full bg-primary-50 text-primary-700 flex items-center justify-center">
                    <Info className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">Build &amp; Version</div>
                    <div className="text-xs text-slate-500 font-mono truncate">{ver.version}</div>
                  </div>
                </div>
                <Link
                  href="/about"
                  className="mt-3.5 inline-flex items-center gap-1 text-xs font-medium text-primary-700 hover:underline"
                >
                  Full details on the About page
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </CardBody>
            </Card>
          </div>
        </section>

        {/* ── Coming soon ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            Coming soon
          </h2>
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100">
                {UPCOMING.map((f) => {
                  const t = TONE_CLASSES[f.tone];
                  const Icon = f.icon;
                  return (
                    <li key={f.title} className="flex items-start gap-3.5 px-5 py-4">
                      <span className={`h-9 w-9 shrink-0 rounded-lg flex items-center justify-center ring-1 ${t.bg} ${t.text} ${t.ring}`}>
                        <Icon className="h-4.5 w-4.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-900">{f.title}</span>
                          <ComingSoonBadge />
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{f.desc}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        </section>
      </main>
    </>
  );
}
