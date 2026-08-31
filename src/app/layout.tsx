import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { loadInventory, isUesimLike } from '@/lib/inventory';
import { getSimqaVersion } from '@/lib/version';
import { currentUser } from '@/lib/identity';

export const metadata: Metadata = {
  title: 'SimQA',
  description: 'SimQA — automated QA tooling for Simnovator UESIM.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The login page renders bare — no sidebar, no lab data behind it. The
  // pathname comes from middleware (server components can't read it directly).
  const pathname = (await headers()).get('x-simqa-pathname') ?? '';
  if (pathname === '/login' || pathname === '/signup') {
    return <html lang="en"><body>{children}</body></html>;
  }

  const inv = loadInventory();
  const uesim = inv.systems.find(isUesimLike);
  // Discover version on the server so the sidebar gets the right string
  // before first paint (no flicker, no client-side fetch). See
  // src/lib/version.ts for discovery rules.
  const ver = getSimqaVersion();
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        {/* Two independently scrolling panes. The shell is pinned to the
            viewport (h-screen + overflow-hidden) so the page itself never
            scrolls; the sidebar scrolls inside its own nav and the content
            column scrolls here. Scrolling one no longer moves the other. */}
        <div className="h-screen overflow-hidden flex">
          <Sidebar version={ver.version} versionSource={ver.source} user={user} />
          <div
            className="flex-1 flex flex-col min-w-0 min-h-0 overflow-y-auto"
            data-uesim-host={uesim?.host ?? ''}
          >
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
