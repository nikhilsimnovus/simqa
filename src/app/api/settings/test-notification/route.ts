// POST — send a test payload to the configured webhook so the user can
// verify the URL before trusting it with real run results. Uses the SAVED
// settings deliberately: what we test is what the runner will actually use.
import { NextResponse } from 'next/server';
import { getSettings } from '@/lib/settings';
import { notifyRunFinished } from '@/lib/notify';

export const dynamic = 'force-dynamic';

export async function POST() {
  const s = getSettings();
  if (!s.notifyWebhookUrl) {
    return NextResponse.json({ ok: false, error: 'no webhook URL saved — save one first' }, { status: 400 });
  }
  const attempted = await notifyRunFinished({
    surface: 'settings',
    runId: 'test-notification',
    ok: false, // "failure" so it fires regardless of the notifyOnSuccess flag
    title: 'Test notification from simqa',
    detail: 'if you can read this, the webhook works',
  });
  return NextResponse.json({ ok: attempted });
}
