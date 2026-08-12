# Founding Traders reward — operator runbook

A one-time **50 DUSDC** gift to the **57 founding traders** (everyone who placed at
least one bet through Skew, excluding team and the venue bot). Funded from our
builder-fee earnings. Eligible traders claim it through a full-screen 3D gift moment;
the payout lands in their wallet and a one-tap gasless deposit moves it into their
trading account.

This doc is how to fund it, switch it on, and watch it. The live view is the
**Founding Traders reward** card in `/v2/admin`.

---

## How the money moves

The on-chain deposit into a trading account is owner-gated (a foreign deposit aborts
in `account::assert_owner` — verified), so the treasury can only reach the trader's
**wallet**. The claim is therefore two steps, presented as one:

1. Server: reward treasury sends 50 DUSDC to the trader's wallet (plus a tiny SUI
   drip for external/Slush wallets so they can sign the next step). Google/Enoki is
   gasless and needs no drip.
2. Client: the trader signs a gasless deposit wallet → trading account.

If step 2 is declined, the 50 DUSDC is safe in the wallet and the first trade
auto-deposits it. **A claim can never lose funds.**

Every payout is gated server-side before signing: eligibility (frozen allowlist),
one claim per wallet (durable marker = the payout digest), an in-flight lock, and a
treasury floor.

---

## Environment

| Variable | What it does | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_REWARD_ENABLED` | `1` shows the banner + gift and allows real claims. Off = fully dark. | off |
| `NEXT_PUBLIC_REWARD_PREVIEW` | `1` shows the experience for **any** connected wallet and plays the claim as a **no-op simulation** (no send, no signing, no ledger write). For reviewing the UI. **Never set in production.** | off |
| `REWARD_TREASURY_PRIVATE_KEY` | The treasury that sends the reward. Falls back to `STARTER_GRANT_PRIVATE_KEY` if unset. | starter-grant key |
| `REWARD_TREASURY_FLOOR` | Keep at least this much DUSDC (base units, 6 dp) beyond each payout. | `0` |
| `REWARD_SUI_BASE` | SUI dripped to a near-empty external wallet so it can sign the deposit (MIST). | `50000000` (0.05) |
| `REWARD_SUI_CEILING` | Only drip to wallets below this SUI (MIST). | `10000000` (0.01) |
| `REWARD_SUI_RESERVE` | Keep this much SUI in the treasury beyond a drip (MIST). | `100000000` (0.1) |
| `REWARD_RPC_URL` | Override the gRPC endpoint for the reward routes. | `predictV2Config.grpcUrl` |

`NEXT_PUBLIC_*` are inlined into the client bundle at dev/build start — after changing
them, **restart the app** (a hot reload will not pick them up).

---

## Fund the treasury

The treasury address is shown on the admin card (it is the deployer/treasury wallet,
already excluded from eligibility so it can't claim its own gift).

1. **DUSDC.** Send DUSDC to the treasury until it covers what's left. To cover all 57
   from scratch that is **2,850 DUSDC** (57 × 50). The source is our builder-fee
   earnings — sweep them with `claim_all_builder_fees` into the treasury, or transfer
   DUSDC you already hold.
2. **SUI.** Keep a little SUI in the treasury for its own gas and the small external
   drips (~0.05 SUI each). A couple of faucet pulls covers a long run. Testnet SUI is
   free: `sui client faucet`, https://faucet.sui.io, or
   `POST https://faucet.testnet.sui.io/v2/gas`.

The card's **covers what's left / top up needed** badge reads the treasury live, so
you can see at a glance whether it's funded enough for the remaining claims.

---

## Go live

1. Fund the treasury (above). Confirm the admin card shows **covers what's left**.
2. Set `NEXT_PUBLIC_REWARD_ENABLED=1` and restart the app.
3. Smoke test: connect an eligible wallet (any of the 57), confirm the banner appears
   and a claim pays out. The founder wallet is eligible if you want to self-test with
   real funds; otherwise use `NEXT_PUBLIC_REWARD_PREVIEW=1` first to review the UI with
   no funds moved.
4. Announce.

To pause, unset `NEXT_PUBLIC_REWARD_ENABLED` (or set it to anything but `1`) and
restart. Claims already paid stay recorded; nothing is re-paid.

---

## Monitor

The admin card shows: claimed / 57, DUSDC paid, remaining count and DUSDC still to
pay, live treasury DUSDC + SUI, whether it covers the rest, and recent claim digests.
It reads aggregate + public on-chain data only — the allowlist never leaves the
server.

---

## A future campaign

Everything is namespaced by `campaign`, so a second airdrop is a clean slate:

1. Generate a new snapshot at `lib/rewards/reward-snapshot.json` with a fresh
   `campaign` id, the new allowlist, and the per-claim amount.
2. Point `NEXT_PUBLIC_REWARD_CAMPAIGN` at it (the claim ledger keys off this).
3. Fund the treasury, flip the flag, announce.

The claim markers, banner dismissal, and admin card all key off the campaign id, so
the new run starts with zero claims and doesn't touch the old one.
