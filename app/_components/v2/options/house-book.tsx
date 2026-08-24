'use client';

/**
 * HouseBook — who is on the other side of your bet, and whether they can pay.
 *
 * Every other options venue keeps this private. The market maker's inventory on
 * Deribit is a secret people pay firms to guess at. Here the counterparty is the PLP
 * vault, and its balance sheet is a public object on chain: how big it is, how much of
 * it is committed, and the worst case it is standing behind. So this panel is not a
 * vault advert, it is the one read on this page that genuinely cannot be had anywhere
 * else, and it belongs next to the odds rather than on a separate risk route.
 *
 * The maths is `lib/risk/v2.ts` (already unit-tested for the risk page) folded through
 * `buildHouseBook` into the trader's framing. Coverage is deliberately described as a
 * multiple that would survive every open bet winning at once, never as a guarantee:
 * it is a conservative floor by construction, and overstating it here would be the
 * one dishonest number on an otherwise honest page.
 */
import { compact } from '@/lib/format';
import { type HouseBook as HouseBookRead } from '@/lib/insights';
import { Term } from './vocab';

export function HouseBook({ house, isLoading }: { house: HouseBookRead | null; isLoading?: boolean }) {
  if (isLoading && !house) {
    return (
      <div className="glass rounded-lg p-4">
        <div className="h-24 animate-pulse rounded bg-white/5" />
      </div>
    );
  }
  if (!house) {
    return (
      <div className="glass rounded-lg p-4 text-[12.5px] leading-relaxed text-text-3">
        The pool backing these markets is not reporting right now.
      </div>
    );
  }

  const atWorkPct = house.atWork * 100;
  const tone =
    house.standing === 'stretched' ? 'text-down' : house.standing === 'strong' ? 'text-up' : 'text-text-1';

  return (
    <div className="glass rounded-lg p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Cell label={<Term plain="Money backing these bets" pro="Pool NAV" />}>
          <div className="font-mono text-[21px] tabular-nums text-text-1">${compact(house.poolUsd)}</div>
          <Sub>
            <Term plain="The pool that pays the winners." pro="Idle plus capital deployed to open markets." />
          </Sub>
        </Cell>

        <Cell label={<Term plain="How much is committed" pro="Utilization" />}>
          <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
            <span className="bg-accent/70" style={{ width: `${atWorkPct.toFixed(2)}%` }} />
          </div>
          <div className="flex justify-between font-mono text-[10.5px]">
            <span className="text-accent">{atWorkPct.toFixed(0)}% at work</span>
            <span className="text-text-3">${compact(house.idleUsd)} free</span>
          </div>
        </Cell>

        <Cell label={<Term plain="If every bet won at once" pro="Coverage floor" />}>
          <div className={`font-mono text-[21px] tabular-nums ${tone}`}>
            {Number.isFinite(house.coverage)
              ? `${house.coverage < 10 ? house.coverage.toFixed(1) : Math.round(house.coverage)}×`
              : '—'}
          </div>
          <Sub>
            <Term
              plain="The pool still covers it this many times."
              pro="Conservative: ignores premiums already paid in, so true coverage is higher."
            />
          </Sub>
        </Cell>

        <Cell label={<Term plain="Riding on this expiry" pro="Exposure here" />}>
          {house.here ? (
            <>
              <div className="font-mono text-[21px] tabular-nums text-text-1">${compact(house.here.atRiskUsd)}</div>
              <Sub>
                {Math.round(house.here.share * 100)}% of everything open, across {house.here.orders}{' '}
                {house.here.orders === 1 ? 'bet' : 'bets'}
              </Sub>
            </>
          ) : (
            <>
              <div className="font-mono text-[21px] tabular-nums text-text-3">—</div>
              <Sub>Nothing open on this expiry yet.</Sub>
            </>
          )}
        </Cell>
      </div>

      <p className="glass-divider-top mt-4 pt-3 text-[12.5px] leading-relaxed text-text-1">{house.summary}</p>
    </div>
  );
}

function Cell({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass-inset flex flex-col gap-2 p-3.5">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3">{label}</div>
      {children}
    </div>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-auto text-[11px] leading-snug text-text-3">{children}</div>;
}
