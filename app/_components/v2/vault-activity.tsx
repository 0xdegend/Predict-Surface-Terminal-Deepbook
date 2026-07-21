'use client';

/**
 * V2VaultActivity — recent EXECUTED LP flows across all LPs (deposits filled into
 * shares, withdrawals filled back to DUSDC), from the indexer's supply/withdraw
 * fill feeds. It's the read-side history of the pool's money moving, and the
 * complement to V2VaultQueue (which shows the connected user's still-pending,
 * cancellable on-chain queue). Server data — renders for any visitor.
 */
import { useState } from 'react';
import { LuArrowRightLeft, LuArrowDownToLine, LuArrowUpFromLine } from 'react-icons/lu';
import { useVaultActivity } from '@/lib/hooks/use-vault-activity';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useNow } from '@/lib/hooks/use-now';
import { quote as fmtQuote, num, signed, shortId, ago } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';

/** Rows shown before the table asks you to expand it — keeps the page short. */
const COLLAPSED_ROWS = 5;

export function V2VaultActivity() {
  const { rows, netFlow, loading } = useVaultActivity();
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  const now = useNow(0);
  const sym = predictV2Config.quote.symbol;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <div className="glass-card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <IconChip icon={LuArrowRightLeft} color={HUE.blue} size={26} />
          <div className="flex flex-col">
            <h3 className="text-[14px] font-semibold tracking-tight text-text-1">Recent LP activity</h3>
            <span className="text-[10px] text-text-3">deposits &amp; withdrawals filled at NAV</span>
          </div>
        </div>
        {!loading && rows.length > 0 && (
          <div className="flex flex-col items-end gap-0.5">
            <span className="eyebrow">Net flow</span>
            <span
              className="font-mono text-[13px] leading-none tabular-nums"
              style={{ color: netFlow >= 0 ? 'var(--up)' : 'var(--down)' }}
            >
              {signed(netFlow, 2)} {sym}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <span className="font-mono text-[12px] text-text-3">loading…</span>
      ) : rows.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-text-2">
          No deposits or withdrawals have filled yet. LP flows land here once the keeper&apos;s next
          vault update settles them at NAV.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-text-3">
                <Th>Action</Th>
                <Th>Account</Th>
                <Th right>Amount</Th>
                <Th right>Price / share</Th>
                <Th right>When</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isDeposit = r.side === 'deposit';
                const mine = mounted && !!acct.accountId && r.accountId === acct.accountId;
                return (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <Td>
                      <span
                        className="inline-flex items-center gap-1.5"
                        style={{ color: isDeposit ? 'var(--up)' : 'var(--down)' }}
                      >
                        {isDeposit ? <LuArrowDownToLine size={12} /> : <LuArrowUpFromLine size={12} />}
                        {isDeposit ? 'Deposit' : 'Withdraw'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-text-2">{shortId(r.accountId)}</span>
                      {mine && (
                        <span className="ml-2 rounded-full bg-(--accent-soft) px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-up">
                          You
                        </span>
                      )}
                    </Td>
                    <Td right>
                      <span className="text-text-1">{fmtQuote(r.dusdc)}</span>{' '}
                      <span className="text-text-3">{sym}</span>
                    </Td>
                    <Td right>
                      <span className="text-text-3">{r.pricePerShare > 0 ? num(r.pricePerShare, 4) : '—'}</span>
                    </Td>
                    <Td right>
                      <span className="text-text-3">{now ? ago(r.ts, now) : ''}</span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > COLLAPSED_ROWS && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 w-full rounded-lg py-2 text-center text-[11px] font-medium text-text-3 transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {showAll ? 'Show less' : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 font-normal ${right ? 'text-right' : ''}`}>{children}</th>;
}

function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`py-2.5 ${right ? 'text-right' : ''}`}>{children}</td>;
}
