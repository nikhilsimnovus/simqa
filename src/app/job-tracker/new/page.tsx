// Create New Job — the four-step wizard.
//
// Setups and playlists are resolved on the server so the first paint already
// shows which UE/app server each Simnovator maps to; the wizard itself is a
// client component because every step is interactive.

import { Header } from '@/components/Header';
import { listSetups, previewInstallCommand } from '@/lib/jobTracker/setups';
import { listPlaylists } from '@/lib/jobTracker/playlists';
import { Wizard } from './Wizard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Create Job — SimQA' };

export default async function NewJobPage() {
  const setups = listSetups().map((s) => ({
    systemId: s.systemId,
    name: s.name,
    host: s.host,
    profileId: s.profileId,
    profileName: s.profileName,
    ue: s.ue ? { host: s.ue.host, user: s.ue.user, name: s.ue.name } : undefined,
    app: s.app ? { host: s.app.host, user: s.app.user, name: s.app.name } : undefined,
    installable: s.installable,
    problem: s.problem,
    cockpitUrl: s.cockpitUrl,
    installPreview: previewInstallCommand(s),
  }));
  const playlists = listPlaylists();

  return (
    <>
      {/* The one-line version of what a job is. The full paragraph was removed
          from the landing page; repeating it here would just be the same wall
          of text in a second place. */}
      <Header
        title="Create New Job"
        subtitle="Build → playlist / test case → resource set → review & submit. Nothing is created until you submit."
      />
      <main className="p-6">
        {setups.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-slate-700">
            No Simnovator systems in inventory. Add one in{' '}
            <span className="font-medium">Systems Management</span> before creating a job.
          </div>
        ) : (
          <Wizard setups={setups} playlists={playlists} />
        )}
      </main>
    </>
  );
}
