import type { Metadata } from 'next';
import { LuKeyRound } from 'react-icons/lu';
import { BuilderCodePanel, AdminStatus } from '@/app/_components/admin/builder-code-panel';

// Founder-only. Access is enforced on-chain — `claim_all_builder_fees` asserts the
// caller IS the BuilderCode's owner — and gated in the UI; keep it out of search
// indexes regardless. The legacy v1 router fee lives at /admin.
export const metadata: Metadata = {
  title: 'Builder Fees',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function V2AdminRoute() {
  return (
    <main className="flex flex-1 flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {/* Console header — identity on the left, live network/wallet on the right. */}
        <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.02] text-accent">
              <LuKeyRound size={16} />
            </span>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-semibold tracking-tight text-text-1">Builder fees</h1>
                <span className="rounded border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-3">
                  Founder only
                </span>
              </div>
              <p className="max-w-xl text-[12px] leading-relaxed text-text-3">
                The protocol pays an add-on builder fee on every open and early close made by an
                account attributed to Skew. It accrues on-chain until you sweep it.
              </p>
            </div>
          </div>
          <AdminStatus />
        </header>

        <div className="pt-6">
          <BuilderCodePanel />
        </div>
      </div>
    </main>
  );
}
