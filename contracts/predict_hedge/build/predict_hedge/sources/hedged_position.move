// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// predict_hedge::hedged_position — a thin, trustless composition router over
/// DeepBook Predict that opens a "PLP yield minus crash insurance" position in
/// ONE atomic call:
///
///   1. deposit a hedge budget into the caller's own PredictManager,
///   2. mint an out-of-the-money hedge binary (the crash insurance), and
///   3. supply the remainder into the PLP vault, returning the LP shares.
///
/// Everything runs as the CALLER (sender-gated `mint`/`deposit` require the
/// caller to own `manager`), so there is no operator, no custody, and no trust:
/// the user signs, the user keeps the PLP and the hedge. This is the atomic,
/// service-free phase-1 of the Hedge Vault.
///
/// Roadmap (documented, not built here): a pooled version that issues a fungible
/// `Coin<VAULT_SHARE>` over PLP, then a keeper-run hedge sleeve — both require a
/// capability-gated manager API the protocol does not yet expose (mint is
/// hard-gated to `ctx.sender() == manager.owner`). See README.
module predict_hedge::hedged_position;

use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::market_key;
use deepbook_predict::plp::PLP;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;

// === Errors ===
const EZeroSupply: u64 = 0;
const EZeroHedge: u64 = 1;

// === Events ===

/// Emitted once per opened hedged position (drives the UI / analytics).
public struct HedgedPositionOpened has copy, drop {
    sender: address,
    manager_id: ID,
    oracle_id: ID,
    hedge_strike: u64,
    hedge_is_up: bool,
    hedge_quantity: u64,
    supplied: u64,
    plp_received: u64,
}

// === Public Functions ===

/// Atomically open a hedged PLP position and RETURN the PLP shares to the caller
/// (composable form — the calling PTB decides what to do with the `Coin<PLP>`).
///
/// `manager` must be owned by the signer (Predict's `mint`/`deposit` assert
/// `ctx.sender() == manager.owner`). `oracle` is the live oracle the hedge binary
/// is written against; `hedge_expiry`/`hedge_strike`/`hedge_is_up` define the OTM
/// insurance leg; `hedge_budget` funds that leg (any unspent remainder stays in
/// the manager); `supply_coin` is the amount routed into the PLP vault.
public fun open_hedged<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    hedge_expiry: u64,
    hedge_strike: u64,
    hedge_is_up: bool,
    hedge_quantity: u64,
    hedge_budget: Coin<Quote>,
    supply_coin: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<PLP> {
    assert!(supply_coin.value() > 0, EZeroSupply);
    assert!(hedge_quantity > 0, EZeroHedge);

    let oracle_id = object::id(oracle);
    let manager_id = object::id(manager);
    let supplied = supply_coin.value();

    // 1) Fund the hedge sleeve inside the caller's own manager.
    predict_manager::deposit(manager, hedge_budget, ctx);

    // 2) Buy the OTM hedge binary — its cost is pulled from the manager balance.
    let key = market_key::new(oracle_id, hedge_expiry, hedge_strike, hedge_is_up);
    predict::mint<Quote>(predict, manager, oracle, key, hedge_quantity, clock, ctx);

    // 3) Supply the remainder into the shared PLP vault.
    let plp = predict::supply<Quote>(predict, supply_coin, clock, ctx);
    let plp_received = plp.value();

    event::emit(HedgedPositionOpened {
        sender: ctx.sender(),
        manager_id,
        oracle_id,
        hedge_strike,
        hedge_is_up,
        hedge_quantity,
        supplied,
        plp_received,
    });

    plp
}

/// Convenience entry wrapper: open the hedged position and route the PLP shares
/// straight to the caller's address (for wallet/CLI calls that can't handle a
/// returned value).
entry fun open_hedged_and_keep<Quote>(
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    hedge_expiry: u64,
    hedge_strike: u64,
    hedge_is_up: bool,
    hedge_quantity: u64,
    hedge_budget: Coin<Quote>,
    supply_coin: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let plp = open_hedged<Quote>(
        predict,
        manager,
        oracle,
        hedge_expiry,
        hedge_strike,
        hedge_is_up,
        hedge_quantity,
        hedge_budget,
        supply_coin,
        clock,
        ctx,
    );
    transfer::public_transfer(plp, ctx.sender());
}
