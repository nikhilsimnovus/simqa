import { Header } from '@/components/Header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui';

export default function SettingsPage() {
  return (
    <>
      <Header title="Settings" subtitle="Workspace settings" />
      <main className="p-6">
        <Card>
          <CardHeader><CardTitle>Coming up</CardTitle></CardHeader>
          <CardBody>
            <ul className="text-sm text-slate-700 space-y-2 list-disc list-inside">
              <li>Per-user workspace (multi-user lab support)</li>
              <li>Run notifications (email / Slack hook on run finish)</li>
              <li>Default polling and timeout knobs</li>
              <li>Theme (dark mode for this matches Simnovator's dark UI)</li>
            </ul>
          </CardBody>
        </Card>
      </main>
    </>
  );
}
