'use client';

/**
 * V2VaultQueue — the LP queue, read live from the PoolVault.
 *
 * Deposits and withdrawals don't settle inline: they escrow and wait for the
 * keeper's next flush, which fills them at NAV. Before this table there was no way
 * to see that your money was parked — the vault only showed a "1 · 0" count — and no
 * way to get it back, because `Remove` burns PLP shares and a queued deposit hasn't
 * become shares yet. Your own rows get a Cancel that calls
 * `cancel_supply_request` / `cancel_withdraw_request` and returns the escrow to
 * your trading account immediately, without waiting for a flush.
 *
 * Amounts are NOT summable across sides: a supply escrows DUSDC, a withdraw escrows
 * PLP shares. The column is labelled per row for that reason.
 */
import { LuClock, LuArrowDownToLine, LuArrowUpFromLine } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useLpQueue } from '@/lib/hooks/use-lp-queue';
import { useMounted } from '@/lib/hooks/use-mounted';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import type { LpQueueEntry } from '@/lib/sui/v2/lp-queue';

type Row = { side: 'supply' | 'withdraw'; entry: LpQueueEntry };

export function V2VaultQueue() {
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  const { queues, isLoading, error } = useLpQueue(acct.accountId);

  const sym = predictV2Config.quote.symbol;
  const rows: Row[] = queues
    ? [
        ...queues.supply.entries.map((entry) => ({ side: 'supply' as const, entry })),
        ...queues.withdraw.entries.map((entry) => ({ side: 'withdraw' as const, entry })),
      ]
    : [];

  const busy = acct.busy === 'cancel';

  async function cancel(r: Row) {
    if (r.side === 'supply') await acct.cancelSupply(r.entry.index);
    else await acct.cancelWithdraw(r.entry.index);
  }

  return (
    <div className="glass-card flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2.5">
        <IconChip icon={LuClock} color={HUE.amber} size={26} />
        <div className="flex flex-col">
          <h3 className="text-[14px] font-semibold tracking-tight text-text-1">In the queue</h3>
          <span className="text-[10px] text-text-3">
            waiting for the next vault update · escrowed, not yet filled
          </span>
        </div>
      </div>

      {error ? (
        <p className="text-[11.5px] leading-relaxed text-down">
          Couldn&apos;t read the queue from the vault. It&apos;s safe to retry — nothing is lost;
          your funds stay escrowed on-chain either way.
        </p>
      ) : isLoading ? (
        <span className="font-mono text-[12px] text-text-3">loading…</span>
      ) : rows.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-text-2">
          Nothing queued. Deposits and withdrawals land here while they wait for the next vault
          update, and you can cancel them from here until they fill.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] font-mono text-[12px] tabular-nums">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-text-3">
                <Th>Request</Th>
                <Th>Account</Th>
                <Th right>Escrowed</Th>
                <Th right>Queue #</Th>
                <Th right>{/* action */}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSupply = r.side === 'supply';
                // Only the connected account can cancel its own request — the chain
                // enforces it too (the Auth is bound to the account), so this is
                // just not offering a button that would abort.
                const mine = mounted && !!acct.accountId && r.entry.accountId === acct.accountId;
                return (
                  <tr
                    key={`${r.side}-${r.entry.index}`}
                    className="border-b border-line/60 last:border-0"
                  >
                    <Td>
                      <span
                        className="inline-flex items-center gap-1.5"
                        style={{ color: isSupply ? 'var(--up)' : 'var(--down)' }}
                      >
                        {isSupply ? <LuArrowDownToLine size={12} /> : <LuArrowUpFromLine size={12} />}
                        {isSupply ? 'Deposit' : 'Withdraw'}
                      </span>
                    </Td>
                    <Td>
                      <span className="text-text-2">{shortId(r.entry.accountId)}</span>
                      {mine && (
                        <span className="ml-2 rounded-full bg-(--accent-soft) px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-up">
                          You
                        </span>
                      )}
                    </Td>
                    {/* A supply escrows DUSDC; a withdraw escrows PLP shares. */}
                    <Td right>
                      <span className="text-text-1">{fmtQuote(fromQuote(r.entry.amount))}</span>{' '}
                      <span className="text-text-3">{isSupply ? sym : 'PLP'}</span>
                    </Td>
                    <Td right>
                      <span className="text-text-3">#{String(r.entry.index)}</span>
                    </Td>
                    <Td right>
                      {mine ? (
                        <button
                          onClick={() => cancel(r)}
                          disabled={busy}
                          className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1 disabled:opacity-50"
                        >
                          {busy ? 'cancelling…' : 'Cancel'}
                        </button>
                      ) : (
                        <span className="text-text-3">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {acct.error && <span className="text-[11px] leading-relaxed text-down">{acct.error}</span>}
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 font-normal ${right ? 'text-right' : ''}`}>{children}</th>;
}

function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`py-2.5 ${right ? 'text-right' : ''}`}>{children}</td>;
}
