import Link from 'next/link';
import { WalletBar } from './wallet-bar';
import { LiveTape } from './live-tape';
import type { PriceEvent } from '@/lib/api/types';

/**
 * Persistent terminal chrome shared by the surface and risk screens (§10.5):
 * title, screen nav, live spot tape, wallet. Server component; client leaves
 * (WalletBar, LiveTape) isolate browser-only state.
 */
export function TopChrome({
  phase,
  active,
  tape,
}: {
  phase: string;
  active: 'surface' | 'risk' | 'portfolio';
  tape?: { oracleId: string; underlying: string; initial: PriceEvent | null } | null;
}) {
  return (
    <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3">
      <div className="flex items-center gap-5">
        <span className="text-[13px] font-medium tracking-tight text-[#E6E8EB]">
          Predict Surface Terminal
        </span>
        <nav className="flex items-center gap-1">
          <NavLink href="/" label="Surface" active={active === 'surface'} />
          <NavLink href="/portfolio" label="Portfolio" active={active === 'portfolio'} />
          <NavLink href="/risk" label="PLP Risk" active={active === 'risk'} />
        </nav>
        <span className="hidden text-[11px] uppercase tracking-wider text-[#5A5F66] sm:inline">
          {phase}
        </span>
      </div>
      <div className="flex items-center gap-5">
        {tape?.initial && (
          <div className="hidden md:block">
            <LiveTape oracleId={tape.oracleId} underlying={tape.underlying} initial={tape.initial} />
          </div>
        )}
        <WalletBar />
      </div>
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-md border px-2.5 py-1 text-[12px] tracking-tight transition-colors ${
        active
          ? 'border-white/10 bg-white/[0.04] text-[#E6E8EB]'
          : 'border-transparent text-[#8B9099] hover:text-[#E6E8EB]'
      }`}
    >
      {label}
    </Link>
  );
}
