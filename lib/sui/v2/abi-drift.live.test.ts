/**
 * abi-drift.live.test.ts — the redeploy safety net.
 *
 * Every Predict republish so far has moved something we hand-wrote: an entry function
 * gained a parameter, a view getter vanished, an event struct grew a field in the MIDDLE.
 * None of that fails to compile, and most of it does not even throw at runtime — a renamed
 * event field read by name is `undefined`, which becomes `Number(undefined ?? 0)` = 0, and
 * a whole leaderboard silently reports every trader as having staked nothing. The 8-21
 * sweep found exactly that (`OrderMinted.net_premium` → `premium`) plus twelve more.
 *
 * So this asks the chain, rather than asking a human to remember. `getPackage` returns the
 * authoritative ABI: parameter lists in order, and datatype fields with explicit positions.
 * We assert the ABI still matches what our builders and decoders were written against.
 *
 * Network-gated (it reads two live packages):
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/abi-drift.live.test.ts
 *
 * To diff a NEW deployment against the one we run on, before writing any code for it:
 *
 *   RUN_LIVE=1 ABI_DIFF=<predict-pkg-id> npx vitest run lib/sui/v2/abi-drift.live.test.ts
 *
 * That prints the full function + struct delta. It is how the 8-21 work list was built,
 * and it is meant to be the FIRST thing run against the next republish.
 */
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, V2_IS_821_PLUS, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1';

/** Sui's MoveFunction.Visibility enum: 1 private, 2 public, 3 package/friend. */
const PUBLIC = 2;

interface AbiFn {
  params: string[];
  visibility: number;
  isEntry: boolean;
}
interface AbiModule {
  fns: Record<string, AbiFn>;
  structs: Record<string, string[]>;
}

/** A parameter rendered so a REORDER is visible, not just a count change. */
function renderType(p: unknown): string {
  const param = p as { reference?: number; body?: { typeName?: string; type?: number } };
  const body = param?.body ?? (param as { typeName?: string; type?: number });
  const name = body?.typeName ? body.typeName.split('::').slice(-2).join('::') : `prim${body?.type}`;
  return (param?.reference ? '&' : '') + name;
}

async function readAbi(packageId: string): Promise<Record<string, AbiModule>> {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
  const res = await client.movePackageService.getPackage({ packageId });
  const modules = res.response?.package?.modules ?? [];
  const out: Record<string, AbiModule> = {};
  for (const m of modules) {
    if (!m.name) continue;
    out[m.name] = {
      fns: Object.fromEntries(
        (m.functions ?? []).map((f) => [
          f.name,
          { params: (f.parameters ?? []).map(renderType), visibility: f.visibility, isEntry: !!f.isEntry },
        ]),
      ),
      structs: Object.fromEntries(
        (m.datatypes ?? []).map((d) => [
          String(d.typeName ?? '').split('::').pop() as string,
          (d.fields ?? [])
            .slice()
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((f) => String(f.name ?? '')),
        ]),
      ),
    };
  }
  return out;
}

/**
 * Every Move function we build a transaction for or simulate, with the argument count we
 * pass (ctx excluded — the runtime supplies it). A mismatch here is a transaction that
 * aborts after signing, so these are asserted rather than merely reported.
 */
const CALLS: Record<string, Record<string, number>> = V2_IS_821_PLUS
  ? {
      expiry_market: {
        load_live_pricer: 7,
        settled_order_payout: 2,
        mint_exact_quantity: 12,
        mint_exact_amount: 12,
        redeem_live: 11,
        redeem_settled: 7,
      },
      predict_account: { set_builder_code: 3, builder_code_id: 1 },
      builder_code: { owner: 1, claimable_builder_fees: 2 },
    }
  : {
      expiry_market: {
        load_live_pricer: 7,
        order_value: 3,
        mint_exact_quantity: 13,
        mint_exact_amount: 13,
        redeem_live: 11,
        redeem_settled: 8,
      },
      predict_account: { set_builder_code: 3, builder_code_id: 1 },
      builder_code: { owner: 1, claimable_builder_fees: 2 },
    };

/**
 * Calls we KNOW are wrong, recorded so they stay visible instead of quietly passing.
 *
 * `plp::request_supply` and `plp::request_withdraw` each took ONE u64 on 6-24 and took a
 * SECOND one from the 8-06 refresh onward. `buildRequestSupplyTx` / `buildRequestWithdrawTx`
 * still pass one, so the vault deposit and withdraw PTBs abort — on the deployment we are
 * running in production today, not only on 8-21. Found by this test's first run.
 *
 * It is deliberately NOT patched here: the added parameter's meaning is not recoverable from
 * the ABI (both are bare u64), and picking a value for an unknown argument on a path that
 * moves a trader's DUSDC is precisely the guess this file exists to prevent. It needs the
 * Move source or the official SDK to name it first.
 */
const KNOWN_BROKEN: Record<string, Record<string, { weBuild: number; chainWants: number }>> = {
  plp: {
    request_supply: { weBuild: 7, chainWants: 8 },
    request_withdraw: { weBuild: 7, chainWants: 8 },
  },
};

/**
 * Struct field ORDER for everything we decode positionally (BCS) — where an inserted
 * field silently shifts every value after it. Name-keyed reads survive a reorder, so only
 * the positional decoders are pinned here.
 */
const BCS_STRUCTS: Record<string, string[]> = {
  Pricer: [
    'expiry_market_id',
    'forward',
    'svi',
    'pyth_spot_source_timestamp_ms',
    'block_scholes_spot_source_timestamp_ms',
    'block_scholes_forward_source_timestamp_ms',
    'block_scholes_svi_source_timestamp_ms',
  ],
  PricingSVI: ['a_magnitude', 'a_is_negative', 'b', 'rho', 'm', 'sigma'],
};

describe.skipIf(!RUN)(`predict ABI on ${ACTIVE_V2_DEPLOYMENT} (live)`, () => {
  it('still exposes every function we build a transaction for, at the arity we build', async () => {
    const abi = await readAbi(predictV2Config.packages.predict);
    const wrong: string[] = [];
    for (const [mod, fns] of Object.entries(CALLS)) {
      for (const [fn, ourArgs] of Object.entries(fns)) {
        const live = abi[mod]?.fns?.[fn];
        if (!live) {
          wrong.push(`${mod}::${fn} does not exist on chain`);
          continue;
        }
        if (live.visibility !== PUBLIC && !live.isEntry) {
          wrong.push(`${mod}::${fn} is no longer callable from a PTB`);
          continue;
        }
        // The chain counts TxContext; we do not pass it, so the live list is one longer
        // for anything that takes it. Accept either, and only flag a real mismatch.
        const takesCtx = live.params[live.params.length - 1]?.includes('TxContext');
        const expected = takesCtx ? ourArgs + 1 : ourArgs;
        if (live.params.length !== expected) {
          wrong.push(`${mod}::${fn} takes ${live.params.length} params, we build ${ourArgs} (+ctx=${takesCtx})`);
        }
      }
    }
    expect(wrong, `ABI drift on ${ACTIVE_V2_DEPLOYMENT}:\n  ${wrong.join('\n  ')}`).toEqual([]);
  }, 60_000);

  it('holds the known-broken vault calls at exactly the break we recorded', async () => {
    // If one of these starts matching, the bug was fixed and the entry should be deleted.
    // If the gap CHANGES, the vault path drifted again and the recorded note is stale.
    const abi = await readAbi(predictV2Config.packages.predict);
    for (const [mod, fns] of Object.entries(KNOWN_BROKEN)) {
      for (const [fn, rec] of Object.entries(fns)) {
        const live = abi[mod]?.fns?.[fn];
        expect(live, `${mod}::${fn} vanished`).toBeTruthy();
        const takesCtx = live!.params[live!.params.length - 1]?.includes('TxContext');
        const chainWants = live!.params.length - (takesCtx ? 1 : 0);
        expect(chainWants, `${mod}::${fn} arity moved — re-check the recorded break`).toBe(rec.chainWants);
        expect(rec.weBuild, `${mod}::${fn} is FIXED — delete it from KNOWN_BROKEN`).not.toBe(chainWants);
      }
    }
  }, 60_000);

  it('keeps the field order of every struct we decode positionally', async () => {
    const abi = await readAbi(predictV2Config.packages.predict);
    for (const [name, fields] of Object.entries(BCS_STRUCTS)) {
      const live = abi.pricing?.structs?.[name];
      expect(live, `pricing::${name} is gone — the BCS decoder in pricer.ts is dead`).toBeTruthy();
      // Field ORDER is the whole contract for a positional decode: a field inserted in the
      // middle shifts every byte offset after it and the forward/SVI silently misread.
      expect(live, `pricing::${name} field order moved`).toEqual(fields);
    }
  }, 60_000);
});

/**
 * The exploration mode: not an assertion, a report. Prints what a candidate deployment
 * changed relative to the one we are configured for, so the migration work list is read
 * off the chain instead of guessed from a changelog.
 */
describe.skipIf(!RUN || !process.env.ABI_DIFF)('ABI diff against a candidate deployment', () => {
  it('reports every function and struct that moved', async () => {
    const ours = await readAbi(predictV2Config.packages.predict);
    const theirs = await readAbi(process.env.ABI_DIFF as string);
    const lines: string[] = [];

    for (const [mod, m] of Object.entries(ours)) {
      const other = theirs[mod];
      if (!other) {
        lines.push(`MODULE GONE: ${mod}`);
        continue;
      }
      for (const [fn, f] of Object.entries(m.fns)) {
        if (f.visibility !== PUBLIC && !f.isEntry) continue;
        const g = other.fns[fn];
        if (!g) lines.push(`fn GONE:      ${mod}::${fn}`);
        else if (JSON.stringify(f.params) !== JSON.stringify(g.params))
          lines.push(`fn CHANGED:   ${mod}::${fn}\n    ours   ${f.params.join(', ')}\n    theirs ${g.params.join(', ')}`);
      }
      for (const [name, fields] of Object.entries(m.structs)) {
        const g = other.structs[name];
        if (!g) lines.push(`struct GONE:  ${mod}::${name}`);
        else if (JSON.stringify(fields) !== JSON.stringify(g))
          lines.push(`struct MOVED: ${mod}::${name}\n    ours   ${fields.join(', ')}\n    theirs ${g.join(', ')}`);
      }
      for (const name of Object.keys(other.structs)) if (!(name in m.structs)) lines.push(`struct NEW:   ${mod}::${name}`);
    }
    for (const mod of Object.keys(theirs)) if (!(mod in ours)) lines.push(`MODULE NEW:   ${mod}`);

    console.log(`\n${lines.length} differences vs ${process.env.ABI_DIFF}\n${lines.join('\n')}`);
    expect(lines.length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
