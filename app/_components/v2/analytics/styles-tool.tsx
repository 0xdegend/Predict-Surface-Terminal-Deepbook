'use client';

/**
 * V2StylesTool — how traders bet, for the new deployment (legacy StylesTab's
 * twin). A plain-language legend of the archetypes, the distribution across
 * classified traders, then the roster ranked by amount bet. Built on the shared
 * classifier so a trader's archetype matches everywhere; reuses the shared
 * StyleBadge visuals.
 *
 * Presentational only — the roster comes pre-classified from the cached
 * `/api/v2/trader-styles` route, which now reads every trader's COMPLETE betting
 * history from the accumulating style indexer (not a windowed fan-out), via
 * useV2TraderStylesRoster. The roster can be long, so its rows paginate.
 *
 * v2 has no in-app trader profile yet, so roster rows link out to the account on
 * the explorer rather than a /trader page.
 */
import { useState } from 'react';
import { ALL_ARCHETYPES } from '@/lib/analytics/trader-style';
import type { V2TraderStyles } from '@/lib/analytics/v2-trader-style';
import { compact, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { WalletAvatar } from '@/app/_components/leaderboard/wallet-avatar';
import { StyleBadge, ARCH_VIS } from '@/app/_components/analytics/style-badge';

const ACCOUNT_EXPLORER = (addr: string) => `https://suiscan.xyz/${predictV2Config.network}/account/${addr}`;

/** Roster rows per page — the complete roster can run long, so it paginates. */
const ROSTER_PAGE = 10;

export function V2StylesTool({ styles, loading }: { styles: V2TraderStyles; loading: boolean }) {
  const { traders, distribution, total } = styles;
  const maxCount = Math.max(1, ...distribution.map((d) => d.count));

  // Page-clamp derived, not stored: the roster refetches and reorders, so a stored page
  // can point past the end — clamp it in render rather than chase it with an effect.
  const [pageState, setPageState] = useState(0);
  const pageCount = Math.max(1, Math.ceil(traders.length / ROSTER_PAGE));
  const page = Math.min(pageState, pageCount - 1);
  const pageStart = page * ROSTER_PAGE;
  const pageRows = traders.slice(pageStart, pageStart + ROSTER_PAGE);

  return (
    <div className="space-y-4">
      {/* Legend — what the archetypes mean, up top so the rest can reference them. */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">What the styles mean</div>
          <div className="eyebrow mt-0.5 text-text-3">worked out from each trader’s recent bets</div>
        </div>
        <div className="grid gap-x-5 gap-y-3 p-4 sm:grid-cols-2">
          {ALL_ARCHETYPES.map((a) => {
            const vis = ARCH_VIS[a.id];
            const Icon = vis.icon;
            return (
              <div key={a.id} className="flex items-start gap-2.5">
                <span
                  className="mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-md"
                  style={{ color: vis.hue, background: `color-mix(in srgb, ${vis.hue} 14%, transparent)` }}
                >
                  <Icon size={13} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-text-1">{a.label}</div>
                  <div className="text-[11.5px] leading-snug text-text-3">{a.blurb}.</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Distribution */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">Trader styles</div>
          <div className="eyebrow mt-0.5 text-text-3">
            {total > 0 ? `how ${total} traders bet, all-time` : 'from every bet so far'}
          </div>
        </div>
        <div className="p-4">
          {loading ? (
            <BarsSkeleton />
          ) : distribution.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-text-3">No recent bets to chart yet.</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {distribution.map((d) => {
                const vis = ARCH_VIS[d.id];
                const Icon = vis.icon;
                return (
                  <div key={d.id} className="flex items-center gap-3">
                    <span className="flex w-32 flex-none items-center gap-1.5 text-[12px] text-text-2">
                      <Icon size={13} style={{ color: vis.hue }} />
                      {d.label}
                    </span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-bg-3">
                      <span
                        className="block h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${(d.count / maxCount) * 100}%`, background: vis.hue, opacity: 0.7 }}
                      />
                    </span>
                    <span className="w-6 flex-none text-right font-mono text-[12px] tabular-nums text-text-2">{d.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Roster */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">Traders by style</div>
          <div className="eyebrow mt-0.5 text-text-3">ranked by amount bet · tap to view on explorer</div>
        </div>
        {loading ? (
          <RowsSkeleton />
        ) : traders.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-text-3">
            No wallet has placed enough bets to read a style yet.
          </div>
        ) : (
          <>
            <div className="rows-divided">
              {pageRows.map((t) => (
                <a
                  key={t.owner}
                  href={ACCOUNT_EXPLORER(t.owner)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
                >
                  <WalletAvatar addr={t.owner} size={22} ring="rgba(255,255,255,0.10)" />
                  <span className="w-28 flex-none truncate font-mono text-[12px] text-text-2">{shortId(t.owner)}</span>
                  <span className="min-w-0 flex-1">
                    <StyleBadge style={t.style} size="sm" />
                  </span>
                  <span className="flex-none text-right font-mono text-[12px] tabular-nums text-text-2">
                    {compact(t.volume)}
                    <span className="ml-1 text-[10px] text-text-3">DUSDC</span>
                  </span>
                </a>
              ))}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[11px] text-text-3">
                <span className="tabular-nums">
                  {pageStart + 1}–{Math.min(pageStart + ROSTER_PAGE, traders.length)} of {traders.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPageState(page - 1)}
                    disabled={page === 0}
                    className="rounded-lg border border-line px-2.5 py-1 text-text-2 transition-colors hover:bg-white/5 hover:text-text-1 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Prev
                  </button>
                  <span className="px-1 tabular-nums">
                    {page + 1} / {pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPageState(page + 1)}
                    disabled={page >= pageCount - 1}
                    className="rounded-lg border border-line px-2.5 py-1 text-text-2 transition-colors hover:bg-white/5 hover:text-text-1 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BarsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="h-3 w-32 flex-none rounded skeleton" />
          <span className="h-2 flex-1 rounded-full skeleton" />
        </div>
      ))}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <span className="h-5.5 w-5.5 flex-none rounded-full skeleton" />
          <span className="h-3 w-24 flex-none rounded skeleton" />
          <span className="h-5 flex-1 rounded skeleton" />
          <span className="h-3 w-12 flex-none rounded skeleton" />
        </div>
      ))}
    </div>
  );
}
