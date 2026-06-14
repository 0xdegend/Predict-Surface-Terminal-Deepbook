import Link from "next/link";
import Image from "next/image";
import { WalletBar } from "./wallet-bar";
import { BottomNav } from "./bottom-nav";
import { NavMore } from "./nav-more";
import { MarketChip, type MarketDiagnostics } from "./market-chip";
import { TourButton } from "./tour/tour-button";
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
  active: "surface" | "risk" | "portfolio" | "leaderboard" | "vault" | "admin";
  tape?: {
    oracleId: string;
    underlying: string;
    initial: PriceEvent | null;
  } | null;
  diagnostics?: MarketDiagnostics | null;
}) {
  return (
    <>
    <header className="glass sticky top-0 z-40 grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 sm:gap-4 sm:px-5 lg:grid-cols-[1fr_auto_1fr]">
      {/* Zone 1 — brand + screen nav. shrink-0 so the chip can never squeeze it. */}
      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
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
          <NavLink
            href="/leaderboard"
            label="Leaderboard"
            active={active === "leaderboard"}
          />
          {/* Hedge Vault + Vault Risk grouped under one dropdown to free header
              space for the wallet (route-aware, self-highlighting). */}
          <NavMore />
        </nav>
      </div>

      {/* Zone 2 — the Live Market Chip (centerpiece). min-w-0 lets it shrink
          instead of pushing the wallet off-screen on narrow phones. */}
      <div data-tour="chip" className="flex min-w-0 justify-center">
        {tape?.initial && diagnostics ? (
          <MarketChip
            oracleId={tape.oracleId}
            underlying={tape.underlying}
            initial={tape.initial}
            diagnostics={diagnostics}
          />
        ) : null}
      </div>

      {/* Zone 3 — wallet. shrink-0 so the Connect/account control is always
          fully visible, even when the chip is wide. */}
      <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
        <TourButton />
        <WalletBar />
      </div>
    </header>

    {/* Mobile dock — sibling of (not inside) the .glass header on purpose:
        backdrop-filter makes an element the containing block for its
        position:fixed descendants, which would re-anchor this bar to the header
        instead of the viewport. Kept outside so `fixed bottom-0` pins to the
        screen bottom. The inline header nav above collapses into this below lg. */}
    <BottomNav />
    </>
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
