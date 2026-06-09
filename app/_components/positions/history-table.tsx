'use client';

/**
 * Trade history — the trader's settled past predictions as a dense table, styled
 * to match the active-oracle table (glass shell, sticky header, faded row
 * dividers, mono tabular figures). Each row is one decided market: the bet, when
 * it settled, won/lost, size, cost, and realized PnL. The last cell links the
 * oracle out to the explorer. Newest first.
 */
import { useState } from 'react';
import { LuArrowUp, LuArrowDown, LuCalendarRange, LuExternalLink, LuShare2 } from 'react-icons/lu';
import { price, dateUTC, quote as fmtQuote, signed, shortId } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { usePositionSpark } from '@/lib/hooks/use-position-spark';
import { ShareCardModal } from './share-card-modal';
import type { ShareCardData } from './share-card-canvas';
import type { PastPrediction } from '@/lib/portfolio/history';

const ORACLE_EXPLORER = (id: string) =>
  `https://suiscan.xyz/${predictConfig.network}/object/${id}`;

export function HistoryTable({ history }: { history: PastPrediction[] }) {
  // The row being shared (if any). One spark query runs only while the modal is open.
  const [sharing, setSharing] = useState<PastPrediction | null>(null);

  return (
    <div className="glass-card overflow-hidden">
      <div className="scroll-quiet max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="head-divider sticky top-0 z-10 text-left text-[10px] uppercase tracking-wider text-text-3 [&>th]:bg-[color-mix(in_srgb,var(--bg-1)_82%,transparent)] [&>th]:backdrop-blur-xl">
              <Th>Market</Th>
              <Th>Result</Th>
              <Th className="text-right">Size</Th>
              <Th className="text-right">Cost</Th>
              <Th className="text-right">PnL</Th>
              <Th className="text-right">ROI</Th>
              <Th className="text-right">Settled</Th>
              <Th className="text-right">Oracle</Th>
              <Th className="text-right">Share</Th>
            </tr>
          </thead>
          <tbody className="row-divider">
            {history.map((h) => {
              const won = h.result === 'won';
              return (
                <tr key={h.key} className="group transition-colors hover:bg-white/[0.035]">
                  <Td className="text-text-1">
                    <span className="relative inline-flex items-center gap-2.5 pl-2.5">
                      {/* result-tinted rail */}
                      <span
                        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full ${
                          won ? 'bg-up' : 'bg-down'
                        }`}
                      />
                      {h.band ? (
                        <>
                          <span className="inline-flex h-4 w-4 flex-none items-center justify-center text-text-2">
                            <LuCalendarRange size={13} />
                          </span>
                          <span className="font-medium">{h.underlying}</span>
                          <span className="text-text-2">
                            ${price(h.band.lower)}–${price(h.band.higher)}
                          </span>
                        </>
                      ) : (
                        <>
                          <span
                            className={`inline-flex h-4 w-4 flex-none items-center justify-center rounded ${
                              h.up ? 'text-up' : 'text-down'
                            }`}
                          >
                            {h.up ? <LuArrowUp size={13} /> : <LuArrowDown size={13} />}
                          </span>
                          <span className="font-medium">{h.underlying}</span>
                          <span className="text-text-3">{h.up ? '≥' : '≤'}</span>
                          <span className="text-text-2">${price(h.strike)}</span>
                        </>
                      )}
                    </span>
                  </Td>
                  <Td>
                    <ResultChip won={won} />
                  </Td>
                  <Td className="text-right text-text-2">{fmtQuote(h.contracts)}</Td>
                  <Td className="text-right text-text-2">{fmtQuote(h.cost)}</Td>
                  <Td className={`text-right ${won ? 'text-up' : 'text-down'}`}>{signed(h.pnl)}</Td>
                  <Td className={`text-right ${h.roi >= 0 ? 'text-up' : 'text-down'}`}>
                    {signed(h.roi * 100, 1)}%
                  </Td>
                  <Td className="text-right text-text-3">{dateUTC(h.settledAt)}</Td>
                  <Td className="text-right">
                    <a
                      href={ORACLE_EXPLORER(h.oracleId)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-text-3 transition-colors hover:text-text-2"
                    >
                      {shortId(h.oracleId)}
                      <LuExternalLink size={11} />
                    </a>
                  </Td>
                  <Td className="text-right">
                    <button
                      onClick={() => setSharing(h)}
                      aria-label="Share this trade as an image"
                      className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2"
                    >
                      <LuShare2 size={13} />
                    </button>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mounted only while a row is selected — keeps the spark query scoped to one. */}
      {sharing &&
        (sharing.band ? (
          <RangeHistoryShareModal prediction={sharing} onClose={() => setSharing(null)} />
        ) : (
          <HistoryShareModal prediction={sharing} onClose={() => setSharing(null)} />
        ))}
    </div>
  );
}

/** Range rows have no single-strike spark; share the band card directly. */
function RangeHistoryShareModal({
  prediction: h,
  onClose,
}: {
  prediction: PastPrediction;
  onClose: () => void;
}) {
  const data: ShareCardData = {
    underlying: h.underlying,
    up: true,
    strike: 0,
    expiry: h.expiry,
    result: h.result,
    decided: true,
    pnl: h.pnl,
    pnlPct: h.roi,
    cost: h.cost,
    contracts: h.contracts,
    entryPrice: h.entryPrice,
    markPrice: h.result === 'won' ? 1 : 0,
    spark: [],
    band: h.band,
  };
  return <ShareCardModal open onClose={onClose} data={data} />;
}

/**
 * Bridges a closed history row to the shared image card. Lives in its own
 * component so `usePositionSpark` runs for exactly the selected position (and
 * only while open), keeping the table itself free of per-row queries.
 */
function HistoryShareModal({
  prediction: h,
  onClose,
}: {
  prediction: PastPrediction;
  onClose: () => void;
}) {
  const spark = usePositionSpark(h.source!); // binary rows always carry a source
  const data: ShareCardData = {
    underlying: h.underlying,
    up: h.up,
    strike: h.strike,
    expiry: h.expiry,
    result: h.result,
    decided: true,
    pnl: h.pnl,
    pnlPct: h.roi,
    cost: h.cost,
    contracts: h.contracts,
    entryPrice: h.entryPrice,
    markPrice: h.result === 'won' ? 1 : 0, // settled mark: ITM = 1.0, OTM = 0.0
    spark,
  };
  return <ShareCardModal open onClose={onClose} data={data} />;
}

function ResultChip({ won }: { won: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        won ? 'bg-(--accent-soft) text-up' : 'bg-(--down-soft) text-down'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${won ? 'bg-accent' : 'bg-down'}`} />
      {won ? 'Won' : 'Lost'}
    </span>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3.5 py-3 font-normal ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3.5 py-3 ${className}`}>{children}</td>;
}
