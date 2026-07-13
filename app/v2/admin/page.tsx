import type { Metadata } from 'next';
import { LuKeyRound } from 'react-icons/lu';
import { BuilderCodePanel } from '@/app/_components/admin/builder-code-panel';

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
      <div className="mx-auto w-full max-w-lg px-4 py-8 sm:py-12">
        <div className="mb-1.5 flex items-center gap-2">
          <LuKeyRound size={18} className="text-accent" />
          <h1 className="text-[15px] font-semibold tracking-tight text-text-1">Builder fees</h1>
        </div>
        <p className="mb-5 text-[12px] leading-relaxed text-text-3">
          The protocol pays an add-on builder fee on every open and early close made by an
          account attributed to Skew. It accrues on-chain until you sweep it.
        </p>
        <BuilderCodePanel />
      </div>
    </main>
  );
}
