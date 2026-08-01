/**
 * lib/sui/v2/builder-code.ts — the protocol's NATIVE builder fee.
 *
 * v2 pays an add-on "builder fee" to whoever is attributed on a trade. Three
 * facts drive this whole module, all verified against source + testnet:
 *
 * 1. The fee is read off the TRADER'S ACCOUNT, not off the transaction — mint
 *    does `predict_account::builder_code_id(account)` and pays that code. So a
 *    trade placed in OUR app pays a COMPETITOR if the account carries their
 *    code. Attribution is sticky on the account; attaching is the whole game.
 * 2. Attaching (`set_builder_code`) consumes the account owner's `Auth`, so the
 *    USER must sign it. But `generate_auth` is a pure, stateless constructor with
 *    no uniqueness guard, so one PTB can mint several — which is why we can ride
 *    the attach along inside their mint and never ask for a second signature.
 * 3. `BuilderCode.owner` is set to `ctx.sender()` at creation and there is NO
 *    setter and no `store` ability (so it can't be transferred either). Whoever
 *    registers the code is the only address that can ever claim from it. Fees
 *    accrue to the code object's own address in the AccumulatorRoot until then.
 *
 * The RATE is protocol-fixed, not ours: min(trade_fee × 10%, quantity × 0.5%).
 * With the live config (base_fee 2%, expiry ramp off) the trade fee peaks at 1%
 * of notional, so the 0.5% cap can never bind and we always net exactly 10% of
 * the trade fee ≈ 0.05–0.10% of notional. It is charged on open and on early
 * close, but NOT on redeeming a settled position.
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { predictV2Config, v2Target, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { addGenerateAuth, simulate, SIM_SENDER, type SimulateCapableClient } from './account';

const c = () => predictV2Config;
const ACC = (module: string, fn: string) => `${c().packages.account}::${module}::${fn}` as const;

/** The registry entry that mints+shares a new BuilderCode. Renamed across
 *  deployments (same args: registry, protocolConfig, index): 6-24 =
 *  `create_builder_code`, 7-29 = `create_and_share_builder_code`. Verified live
 *  against each package's `registry` module ABI. */
const REGISTER_BUILDER_CODE_FN =
  ACTIVE_V2_DEPLOYMENT === '7-29' ? 'create_and_share_builder_code' : 'create_builder_code';

/* ------------------------------- builders -------------------------------- */

/**
 * Append `generate_auth + set_builder_code` to an existing tx, attributing the
 * account to our code. Safe to call alongside a mint in the same PTB (each gated
 * call takes its own Auth). No-op if we have no code registered on this network.
 *
 * Callers must decide WHETHER to attach — see `shouldAttach` in
 * lib/hooks/use-builder-code.ts. We only attach when the slot is EMPTY; we never
 * silently overwrite another builder's attribution.
 */
export function addSetBuilderCode(tx: Transaction, wrapperId: string): void {
  const codeId = c().builderCodeId;
  if (!codeId) return;
  const auth = addGenerateAuth(tx);
  tx.moveCall({
    target: v2Target('predict_account', 'set_builder_code'),
    arguments: [tx.object(wrapperId), auth, tx.object(codeId)],
  });
}

/** Detach our code from the caller's account (user-initiated opt-out). */
export function buildUnsetBuilderCodeTx(wrapperId: string): Transaction {
  const tx = new Transaction();
  const auth = addGenerateAuth(tx);
  tx.moveCall({
    target: v2Target('predict_account', 'unset_builder_code'),
    arguments: [tx.object(wrapperId), auth],
  });
  return tx;
}

/**
 * Register a NEW BuilderCode. The signer becomes its permanent owner — there is
 * no way to reassign it afterwards, and losing that key forfeits all future fees
 * (the only recovery is a new code, which every user would have to re-attach).
 * Sign this from the wallet you intend to own the revenue, ideally a multisig.
 * `index` lets one owner hold several codes; re-using an (owner, index) pair
 * aborts, since the object is derived from exactly that key.
 */
export function buildRegisterBuilderCodeTx(index: bigint = 0n): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: v2Target('registry', REGISTER_BUILDER_CODE_FN),
    arguments: [
      tx.object(c().shared.registry),
      tx.object(c().shared.protocolConfig),
      tx.pure.u64(index),
    ],
  });
  return tx;
}

/**
 * Sweep all accrued builder fees to `recipient`. On-chain this is owner-gated
 * (`assert_owner`), so only the code's owner can sign it — but the DESTINATION is
 * free: the call returns a Coin<DUSDC> and this PTB decides where it lands. That
 * split matters: the claiming KEY is permanent, the treasury address is not.
 */
export function buildClaimBuilderFeesTx(recipient: string): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: v2Target('builder_code', 'claim_all_builder_fees'),
    arguments: [tx.object(c().builderCodeId), tx.object(c().accumulatorRootId)],
  });
  tx.transferObjects([coin], tx.pure.address(recipient));
  return tx;
}

/* -------------------------------- reads ---------------------------------- */

/**
 * The BuilderCode id currently attached to this account, or null if the slot is
 * empty. Free — no signature, no gas. This is the read the mint path branches on,
 * and the one that tells us if a user arrived carrying a rival's code.
 */
export async function readAttachedBuilderCode(
  client: SimulateCapableClient,
  wrapperId: string,
): Promise<string | null> {
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  const account = tx.moveCall({
    target: ACC('account', 'load_account'),
    arguments: [tx.object(wrapperId)],
  });
  tx.moveCall({
    target: v2Target('predict_account', 'builder_code_id'),
    arguments: [account],
  });
  const res = await simulate(client, tx);
  const last = res.commandResults?.at(-1);
  if (!last?.returnValues?.length) throw new Error('readAttachedBuilderCode: no value');
  return bcs.option(bcs.Address).parse(new Uint8Array(last.returnValues[0].bcs)) ?? null;
}

/**
 * Every BuilderCode this wallet has ever registered. There is NO on-chain
 * owner→code lookup (unlike accounts, which expose `derived_wrapper_address`), so
 * we read it back from the `BuilderCodeCreated` event stream — the same GraphQL
 * path the leaderboard uses, since Sui Foundation disabled JSON-RPC on testnet
 * fullnodes (2026-07-08) and gRPC still has no event query.
 */
export interface OwnedBuilderCode {
  codeId: string;
  index: number;
}

const graphqlUrl = () => `https://graphql.${c().network}.sui.io/graphql`;

const CREATED_QUERY = `query BuilderCodes($type: String!) {
  events(last: 50, filter: { type: $type }) {
    nodes { contents { json } }
  }
}`;

interface CreatedJson {
  builder_code_id?: string;
  owner?: string;
  builder_code_index?: string;
}

export async function findBuilderCodesByOwner(
  owner: string,
  signal?: AbortSignal,
): Promise<OwnedBuilderCode[]> {
  const type = `${c().packages.predict}::builder_code_events::BuilderCodeCreated`;
  const res = await fetch(graphqlUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ query: CREATED_QUERY, variables: { type } }),
  });
  if (!res.ok) throw new Error(`builder-code events query ${res.status}`);
  const json = (await res.json()) as {
    data?: { events?: { nodes?: { contents?: { json?: CreatedJson } }[] } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const want = owner.toLowerCase();
  const out: OwnedBuilderCode[] = [];
  for (const n of json.data?.events?.nodes ?? []) {
    const j = n.contents?.json;
    if (!j?.builder_code_id || j.owner?.toLowerCase() !== want) continue;
    out.push({ codeId: j.builder_code_id, index: Number(j.builder_code_index ?? 0) });
  }
  return out;
}

export interface BuilderCodeState {
  /** Permanent owner — the ONLY address that can claim. Cannot be changed. */
  owner: string;
  /** DUSDC (base units) accrued and waiting to be swept. */
  claimable: bigint;
}

/** Owner + unclaimed balance of our registered code. */
export async function readBuilderCodeState(
  client: SimulateCapableClient,
): Promise<BuilderCodeState> {
  const codeId = c().builderCodeId;
  const tx = new Transaction();
  tx.setSender(SIM_SENDER);
  tx.moveCall({ target: v2Target('builder_code', 'owner'), arguments: [tx.object(codeId)] });
  tx.moveCall({
    target: v2Target('builder_code', 'claimable_builder_fees'),
    arguments: [tx.object(c().accumulatorRootId), tx.object(codeId)],
  });
  const res = await simulate(client, tx);
  const cmds = res.commandResults ?? [];
  if (cmds.length < 2) throw new Error('readBuilderCodeState: simulate returned no values');
  return {
    owner: bcs.Address.parse(new Uint8Array(cmds[0].returnValues[0].bcs)),
    claimable: BigInt(bcs.u64().parse(new Uint8Array(cmds[1].returnValues[0].bcs))),
  };
}
