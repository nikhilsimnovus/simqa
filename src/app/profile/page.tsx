// /profile — your account and its security.
//
// Behind the normal session check like every other page: middleware sends a
// signed-out visitor to /login, and the API this page calls verifies the
// session again on every request rather than trusting that it got here.

import { ProfileClient } from './ProfileClient';

export const metadata = { title: 'Profile — SimQA' };
export const dynamic = 'force-dynamic';

export default function ProfilePage() {
  return <ProfileClient />;
}
