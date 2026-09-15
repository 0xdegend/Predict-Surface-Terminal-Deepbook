'use client';

/**
 * useQuestProgress — where the connected trader stands on every quest.
 *
 * The quests page used to render eight hardcoded percentages. This makes them real, off
 * the trader's own on-chain record, without adding a single fetch the app was not already
 * making: every query below is keyed exactly as the Portfolio, Trade history and trader
 * style card key theirs, so TanStack serves one shared result. On a cold visit straight to
 * Quests it is one account scan; on a visit from anywhere else it is free.
 *
 * Three layers, kept apart on purpose:
 *   this hook          reads (wallet, order log, carried-over history)
 *   lib/quests/from-activity   folds reads into measured numbers  (pure)
 *   lib/quests/evaluate        turns numbers into progress        (pure)
 *
 * The two pure layers are the ones that will matter later. Points are unclaimable today,
 * so a client-side read is honest: nothing here grants anything. When claiming opens, the
 * server has to be the authority (a browser saying "I finished it" is not evidence), and
 * because the fold and the evaluator take plain data and no React, the server can run the
 * very same functions over the very same events and get the very same answer.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAccountOrders, qkV2 } from '@/lib/api/v2/client';
import { fetchLegacyHistory } from '@/lib/portfolio/legacy-history';
import { sourcesFromActivity } from '@/lib/quests/from-activity';
import { evaluateAll, earnedPoints, type QuestProgress } from '@/lib/quests/evaluate';
import { usePredictAccountV2 } from './use-predict-account-v2';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { PastPrediction } from '@/lib/portfolio/history';

export interface UseQuestProgress {
  /** True when a wallet is connected, so the rows below are that trader's own record. */
  tracking: boolean;
  /** True while the first read is still in flight. Rows are already renderable. */
  isLoading: boolean;
  /** One row per quest, in catalog order. All `unavailable` when nobody is connected. */
  rows: QuestProgress[];
  /** Points from the quests currently complete. Earned, not paid: nothing claims yet. */
  earned: number;
  completed: number;
}

export function useQuestProgress(): UseQuestProgress {
  const acct = usePredictAccountV2();
  const { owner, accountId } = acct;

  // The account's order event log: mints and redeems, the append-only record everything
  // below is folded from. Same key as useV2History and useV2TraderStyle.
  const ordersQ = useQuery<V2OrderEvent[]>({
    queryKey: qkV2.accountOrders(accountId ?? ''),
    queryFn: () => getAccountOrders(accountId!, owner),
    enabled: !!accountId,
    refetchInterval: 30_000,
  });

  // Trades carried over from retired deployments. Without these, a trader who has been
  // here since the 6-24 deployment is told they have never made a prediction. Cached hard:
  // a snapshot is a static file that cannot change between renders.
  const legacyQ = useQuery<PastPrediction[]>({
    queryKey: ['v2', 'legacy-history', owner?.toLowerCase() ?? ''],
    queryFn: ({ signal }) => fetchLegacyHistory(owner, signal),
    enabled: !!owner,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  /**
   * Evidence the Predict account has been funded. `wrapperKnown` rather than the bare
   * `wrapperExists`, because that boolean is false both for "no account" and for "the read
   * has not come back", and treating a slow RPC as "never funded" is exactly the bug the
   * account hook warns about. Undecided stays undecided.
   */
  const account = useMemo(
    () => ({ known: acct.wrapperKnown, funded: acct.wrapperExists && acct.balanceBase > 0n }),
    [acct.wrapperKnown, acct.wrapperExists, acct.balanceBase],
  );

  /**
   * A page-load clock, read once. The only thing time decides here is which Monday the
   * weekly quest counts from, so a ticking clock would re-fold the whole order log every
   * second to answer a question whose answer changes once a week. A session left open
   * across a Monday midnight UTC keeps the old week until the next navigation, which is
   * the right trade for a progress bar.
   */
  const [nowMs] = useState(() => Date.now());

  const rows = useMemo(() => {
    // Nobody connected: no sources, so every quest reports unmeasured. The panel reads
    // `tracking` and says "connect to track" rather than "coming soon".
    if (!owner) return evaluateAll([]);
    const sources = sourcesFromActivity({
      orders: ordersQ.data ?? [],
      legacy: legacyQ.data ?? [],
      account,
      nowMs,
    });
    return evaluateAll(sources);
  }, [owner, ordersQ.data, legacyQ.data, account, nowMs]);

  return {
    tracking: !!owner,
    // An account that does not exist yet has no orders to wait for, so a brand-new wallet
    // lands on a finished page at zero rather than on a spinner that never resolves.
    isLoading: !!owner && (acct.isLoading || (!!accountId && ordersQ.isLoading) || legacyQ.isLoading),
    rows,
    earned: earnedPoints(rows),
    completed: rows.filter((r) => r.state === 'complete').length,
  };
}
