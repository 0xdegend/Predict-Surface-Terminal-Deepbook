/**
 * /api/session-gas — app-run SUI drip that funds a delegated-session key's gas.
 *
 * A delegated session key signs its OWN trades and pays its OWN gas in SUI. That is
 * exactly what lets a session trade skip the wallet popup AND (for Google/zkLogin)
 * the Enoki sponsor round-trips — the lowest-latency submit. But a Google wallet
 * holds no SUI, and we would rather Slush users not spend theirs either, so this
 * route sends a small, fixed amount of SUI from an app-controlled TREASURY wallet
 * straight to the session key when the user turns instant trading on.
 *
 * The session key is a distinct, ephemeral address (not the user's wallet), so this
 * is deliberately SEPARATE from the starter grant: its own `sgas:` ledger namespace and
 * its own daily cap. A session key legitimately needs re-funding whenever its gas runs
 * low, so the gate is BALANCE, not time: as long as the key holds less than the ceiling,
 * it can top up. These are REAL funds, so every drip is gated server-side BEFORE we sign:
 *   1. global daily cap — spend circuit breaker,
 *   2. in-flight lock — kills the concurrent double-drip race,
 *   3. balance ceiling — the PRIMARY gate: skip a key that already holds enough gas
 *      (returns ok, no tx), so a genuinely LOW key can always top up. A just-topped key
 *      sits above the ceiling until it's spent down, which is the real rate limit,
 *   4. short anti-hammer cooldown — only bites a tight drain-and-redrip loop, never a
 *      real low key (which is above the ceiling right after a top-up),
 *   5. treasury reserve — refuse when the treasury's SUI would dip below its own gas.
 *
 * Reuses the starter-grant treasury key (STARTER_GRANT_PRIVATE_KEY) and the shared
 * Redis/in-process store. Enabled only when SESSION_GAS_DRIP_ENABLED=1 AND the
 * treasury key is set; otherwise the client falls back to owner-funded gas (Slush)
 * or keeps sessions off (Google).
 */
import { NextResponse } from 'next/server';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { predictConfig } from '@/config/predict';
import {
  SESSION_GAS_DRIP_BASE_DEFAULT,
  SESSION_GAS_DRIP_CEILING_DEFAULT,
} from '@/config/session-gas';
import {
  acquireGasDripLock,
  releaseGasDripLock,
  recentlyDripped,
  markDripped,
  gasDripDailyCount,
} from '@/lib/server/grant-store';

const envBigInt = (name: string, fallback: bigint): bigint => {
  const v = process.env[name];
  try {
    return v ? BigInt(v) : fallback;
  } catch {
    return fallback;
  }
};

/** SUI put on a session key per drip (MIST, @9dec). Default 0.1 SUI. */
const DRIP_BASE = envBigInt('SESSION_GAS_DRIP_BASE', SESSION_GAS_DRIP_BASE_DEFAULT);
/** Skip a key already holding at least this much SUI (MIST). Default 0.06 SUI. */
const DRIP_CEILING = envBigInt('SESSION_GAS_DRIP_CEILING', SESSION_GAS_DRIP_CEILING_DEFAULT);
/** Keep at least this much SUI in the treasury for its own gas on top of a drip
 *  (MIST). Default 0.1 SUI. */
const TREASURY_RESERVE = envBigInt('SESSION_GAS_TREASURY_RESERVE', 100_000_000n);
/** Max session-gas drips per UTC day across all users (spend circuit breaker). */
const DAILY_CAP = Number(process.env.SESSION_GAS_DAILY_CAP ?? '500');
/** Operator switch — must be =1 AND the treasury key set for the route to pay out. */
const ENABLED = process.env.SESSION_GAS_DRIP_ENABLED === '1';

const SUI = '0x2::sui::SUI';

let treasury: Ed25519Keypair | null | undefined;
function getTreasury(): Ed25519Keypair | null {
  if (treasury !== undefined) return treasury;
  const key = process.env.STARTER_GRANT_PRIVATE_KEY;
  treasury = key ? Ed25519Keypair.fromSecretKey(key) : null;
  return treasury;
}

const client = new SuiGrpcClient({
  network: predictConfig.network,
  baseUrl: process.env.STARTER_GRANT_RPC_URL ?? predictConfig.grpcUrl,
});

async function suiBalance(owner: string): Promise<bigint> {
  const r = await client.core.getBalance({ owner, coinType: SUI });
  return BigInt(r.balance.balance);
}

export async function POST(req: Request) {
  const signer = ENABLED ? getTreasury() : null;
  if (!signer) {
    return NextResponse.json(
      { error: 'Session gas drip not configured', code: 'not_configured' },
      { status: 503 },
    );
  }

  let address: string | undefined;
  try {
    ({ address } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'bad_request' }, { status: 400 });
  }
  if (!address || !isValidSuiAddress(address)) {
    return NextResponse.json({ error: 'Invalid address', code: 'bad_request' }, { status: 400 });
  }

  // 1) global daily cap — the spend circuit breaker (cheap, global).
  if ((await gasDripDailyCount()) >= DAILY_CAP) {
    return NextResponse.json(
      { error: 'Daily session-gas limit reached', code: 'rate_limited' },
      { status: 429 },
    );
  }

  // 2) in-flight lock — refuse a concurrent drip for the same key. The balance read +
  //    payout below run under it, so two clicks can't both fund the same key.
  if (!(await acquireGasDripLock(address))) {
    return NextResponse.json(
      { error: 'A drip for this session key is already in progress', code: 'in_progress' },
      { status: 409 },
    );
  }

  try {
    const balance = await suiBalance(address);

    // 3) balance ceiling — the PRIMARY gate. A key that already holds enough gas needs
    //    nothing (report success, no tx). This is what lets a genuinely LOW key top up
    //    whenever it needs to: we gate on how much gas the key holds, not on when it last
    //    topped up. It's also the real rate limit — a just-topped key jumps above the
    //    ceiling and can't be re-dripped until it's spent back down.
    if (balance >= DRIP_CEILING) {
      return NextResponse.json({ digest: null, suiAmount: '0', alreadyFunded: true });
    }

    // 4) short anti-hammer — the key IS low (below the ceiling), so it's eligible; this
    //    only stops a tight drain-and-redrip loop. A real user who just topped up is now
    //    above the ceiling and already returned at step 3, so this never blocks them.
    if (await recentlyDripped(address)) {
      return NextResponse.json(
        { error: 'Just topped up — give it a few seconds and try again', code: 'cooldown' },
        { status: 429 },
      );
    }

    // 5) treasury reserve — never spend the treasury below its own gas floor.
    const treasuryAddr = signer.toSuiAddress();
    if ((await suiBalance(treasuryAddr)) < DRIP_BASE + TREASURY_RESERVE) {
      return NextResponse.json(
        { error: 'Treasury is low on SUI', code: 'treasury_empty' },
        { status: 503 },
      );
    }

    // Split the drip off the treasury's own gas coin — treasury pays its own gas.
    const tx = new Transaction();
    tx.setSender(treasuryAddr);
    const [drip] = tx.splitCoins(tx.gas, [DRIP_BASE]);
    tx.transferObjects([drip], tx.pure.address(address));

    const res = await client.core.signAndExecuteTransaction({ signer, transaction: tx });
    if (res.$kind === 'FailedTransaction') {
      throw new Error(res.FailedTransaction.status?.error?.message ?? 'Drip failed on-chain');
    }
    const digest = res.Transaction.digest;
    await client.core.waitForTransaction({ digest });

    // Start the cooldown + bump the daily count only after a confirmed payout.
    await markDripped(address);
    return NextResponse.json({ digest, suiAmount: DRIP_BASE.toString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Drip failed';
    return NextResponse.json({ error: msg, code: 'error' }, { status: 502 });
  } finally {
    await releaseGasDripLock(address);
  }
}
