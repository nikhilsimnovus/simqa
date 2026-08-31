'use client';

// Same sign-out action the sidebar footer offers — repeated here because
// Account is where a user expects to find it on a Settings page, not just
// tucked in the sidebar.

import { useState } from 'react';
import { LogOut } from 'lucide-react';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
        window.location.href = '/login';
      }}
      disabled={busy}
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
    >
      <LogOut className="h-3.5 w-3.5" />
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
