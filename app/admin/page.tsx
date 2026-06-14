import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { AdminPanel } from '../_components/admin/admin-panel';

// Founder-only fee controls. Access is enforced on-chain (AdminCap) + gated in the
// UI; keep it out of search indexes regardless.
export const metadata: Metadata = {
  title: 'Fee Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function AdminRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="admin" />
      <main className="flex flex-1 flex-col">
        <AdminPanel />
      </main>
    </div>
  );
}
