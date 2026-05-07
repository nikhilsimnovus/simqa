import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { loadInventory, isUesimLike } from '@/lib/inventory';

export const metadata: Metadata = {
  title: 'QA Ka BAAP',
  description: 'QA Ka BAAP — Father of QA. Automated QA tooling for Simnovator UESIM.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const inv = loadInventory();
  const uesim = inv.systems.find(isUesimLike);
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex">
          <Sidebar />
          <div className="flex-1 flex flex-col" data-uesim-host={uesim?.host ?? ''}>
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
