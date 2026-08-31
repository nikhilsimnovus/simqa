// Job Tracker — landing page.
//
// The description, the Create New Job button, and the history of everything
// that has been created. Server-rendered so the table is populated on first
// paint; JobHistory takes over and polls only while something is live.

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';
import { listJobs } from '@/lib/jobTracker/store';
import { JobHistory } from './JobHistory';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Job Tracker — SimQA' };

export default async function JobTrackerPage() {
  const jobs = listJobs();

  return (
    <>
      {/* The primary action lives in the header's top-right, where every other
          page in SimQA puts its actions. The long description that used to sit
          above the table is gone — the subtitle says the same thing in one
          line, and the table is what people come here for. */}
      <Header
        title="Job Tracker"
        subtitle="Create, monitor and manage Simnovator jobs from one place"
        right={
          <Link
            href="/job-tracker/new"
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white px-4 h-9 text-sm font-semibold transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create New Job
          </Link>
        }
      />
      <main className="p-6 flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Job History</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            <JobHistory initialJobs={jobs} />
          </CardBody>
        </Card>
      </main>
    </>
  );
}
