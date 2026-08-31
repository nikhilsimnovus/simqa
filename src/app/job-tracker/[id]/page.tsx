// One job: its configuration, step outcomes, testcase verdicts and full log.

import { notFound } from 'next/navigation';
import { Header } from '@/components/Header';
import { getJob, readLog } from '@/lib/jobTracker/store';
import { JobDetail } from './JobDetail';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `${id} — Job Tracker — SimQA` };
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) notFound();

  const { entries } = readLog(job.key, 8000);

  return (
    <>
      <Header
        title={job.id}
        subtitle={`${job.playlistName ?? 'No playlist'} · ${job.setupHost}`}
      />
      <main className="p-6">
        <JobDetail initialJob={job} initialEntries={entries} />
      </main>
    </>
  );
}
