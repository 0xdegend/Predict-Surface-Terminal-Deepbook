import Link from "next/link";
import Image from "next/image";
import { WalletBar } from "./wallet-bar";
import { BottomNav } from "./bottom-nav";
import { MarketChip, type MarketDiagnostics } from "./market-chip";
import type { PriceEvent } from "@/lib/api/types";

/**
 * Persistent terminal chrome shared by the surface and risk screens (§10.5),
 * redesigned as a premium frosted-glass rail (Phase 1). Three zones: brand +
 * nav · the Live Market Chip · wallet. The old second status bar is gone — its
 * diagnostics now live inside the chip's popover. Server component; client
 * leaves (WalletBar, MarketChip) isolate browser-only state.
 */
export function TopChrome({
  active,
  tape,
  diagnostics,
}: {
  active: "surface" | "risk" | "portfolio" | "leaderboard" | "vault";
  tape?: {
    oracleId: string;
    underlying: string;
    initial: PriceEvent | null;
  } | null;
  diagnostics?: MarketDiagnostics | null;
}) {
  return (
    <header className="glass sticky top-0 z-40 grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-3 sm:gap-4 sm:px-5">
      {/* Zone 1 — brand + screen nav */}
      <div className="flex items-center gap-3 sm:gap-5">
        <Link href="/" className="group flex items-center gap-2" aria-label="Skew — home">
          <Image
            src="/skew-mark.png"
            alt=""
            width={22}
            height={22}
            priority
            className="h-5.5 w-5.5 transition-transform group-hover:scale-105"
          />
          <span className="text-[15px] font-semibold tracking-tight text-text-1">Skew</span>
        </Link>
        <nav className="hidden items-center gap-1 lg:flex">
          <NavLink href="/" label="Trade" active={active === "surface"} />
          <NavLink
            href="/portfolio"
            label="Portfolio"
            active={active === "portfolio"}
          />
          <NavLink href="/vault" label="Hedge Vault" active={active === "vault"} />
          <NavLink
            href="/leaderboard"
            label="Leaderboard"
            active={active === "leaderboard"}
          />
          <NavLink href="/risk" label="Vault Risk" active={active === "risk"} />
        </nav>
      </div>

      {/* Zone 2 — the Live Market Chip (centerpiece) */}
      <div className="flex justify-center">
        {tape?.initial && diagnostics ? (
          <MarketChip
            oracleId={tape.oracleId}
            underlying={tape.underlying}
            initial={tape.initial}
            diagnostics={diagnostics}
          />
        ) : null}
      </div>

      {/* Zone 3 — wallet */}
      <div className="flex items-center justify-end">
        <WalletBar />
      </div>

      {/* Mobile dock — the inline nav above collapses here below lg. */}
      <BottomNav />
    </header>
  );
}

function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
        active
          ? "bg-[var(--accent-soft)] text-text-1"
          : "text-text-2 hover:bg-white/[0.04] hover:text-text-1"
      }`}
    >
      {label}
    </Link>
  );
}
