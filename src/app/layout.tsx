import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { loadInventory, isUesimLike } from '@/lib/inventory';
import { getSimqaVersion } from '@/lib/version';

export const metadata: Metadata = {
  title: 'QA Ka BAAP',
  description: 'QA Ka BAAP — Father of QA. Automated QA tooling for Simnovator UESIM.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const inv = loadInventory();
  const uesim = inv.systems.find(isUesimLike);
  // Discover version on the server so the sidebar gets the right string
  // before first paint (no flicker, no client-side fetch). See
  // src/lib/version.ts for discovery rules.
  const ver = getSimqaVersion();
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex">
          <Sidebar version={ver.version} versionSource={ver.source} />
          <div className="flex-1 flex flex-col" data-uesim-host={uesim?.host ?? ''}>
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
