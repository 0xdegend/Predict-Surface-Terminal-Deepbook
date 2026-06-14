// Copyright (c) 2026.
// SPDX-License-Identifier: Apache-2.0

/// skew_fee::fee_router — a thin, trustless builder-fee router over DeepBook
/// Predict. It lets the Skew front-end charge a small fee ON TOP of a bet, in the
/// same atomic transaction as the mint, with the fee enforced on-chain:
///
///   1. read the chain-authoritative bet cost via `predict::get_trade_amounts`,
///   2. carve the Skew fee (`fee_bps` of that cost) off the caller's payment and
///      send it to the configured `treasury`,
///   3. deposit the remainder into the caller's OWN PredictManager, and
///   4. `predict::mint` (or `mint_range`) — the cost is pulled from the manager.
///
/// Everything runs as the CALLER (Predict's `mint`/`deposit` are sender-gated to
/// `manager.owner`), so there is no custody and no trust: the user signs, keeps
/// the position, and the fee is computed on-chain from the real cost — never a
/// front-end estimate. The fee is taken at MINT only; redeem/close/withdraw are
/// untouched.
///
/// Admin: publishing mints an `AdminCap` to the publisher and shares a
/// `FeeConfig`. The cap holder can retune `fee_bps` (hard-capped at `MAX_FEE_BPS`)
/// and `treasury` with one cheap tx — no package upgrade required.
module skew_fee::fee_router;

use deepbook_predict::predict::{Self, Predict};
use deepbook_predict::predict_manager::{Self, PredictManager};
use deepbook_predict::oracle::OracleSVI;
use deepbook_predict::market_key;
use deepbook_predict::range_key;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

// === Constants ===

/// Hard ceiling on the fee the admin can ever set: 2.00% (200 bps). A safety rail
/// so the `AdminCap` holder can tune within reason but can never set a rug-tier
/// fee. Raising it would require a package upgrade.
const MAX_FEE_BPS: u64 = 200;
const BPS_DENOM: u64 = 10_000;

// === Errors ===
const EInsufficientPayment: u64 = 0;
const EFeeTooHigh: u64 = 1;
const EZeroQuantity: u64 = 2;

// === Objects ===

/// Founder-held capability gating fee/treasury updates. `store` so it can be
/// transferred (e.g. to a multisig) later.
public struct AdminCap has key, store {
    id: UID,
}

/// Shared config the router reads on every mint. Mutable only via `AdminCap`.
public struct FeeConfig has key {
    id: UID,
    /// Builder fee in basis points of the bet cost (100 = 1.00%).
    fee_bps: u64,
    /// Where the Skew fee is sent.
    treasury: address,
}

// === Events ===

/// Emitted once per fee-charged mint (drives analytics / the fee dashboard).
public struct FeeCharged has copy, drop {
    sender: address,
    treasury: address,
    oracle_id: ID,
    fee_bps: u64,
    /// Chain-authoritative cost of the bet (the fee base), base units.
    bet_cost: u64,
    /// Actual fee transferred to the treasury, base units.
    fee_paid: u64,
    is_range: bool,
}

public struct FeeConfigUpdated has copy, drop {
    fee_bps: u64,
    treasury: address,
}

// === Init ===

/// Publish-time: mint the AdminCap to the publisher and share the FeeConfig,
/// defaulting to 1.00% with the publisher as treasury.
fun init(ctx: &mut TxContext) {
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    transfer::share_object(FeeConfig {
        id: object::new(ctx),
        fee_bps: 100,
        treasury: ctx.sender(),
    });
}

// === Admin ===

/// Retune the builder fee (basis points). Reverts above `MAX_FEE_BPS`.
public fun set_fee_bps(_: &AdminCap, config: &mut FeeConfig, fee_bps: u64) {
    assert!(fee_bps <= MAX_FEE_BPS, EFeeTooHigh);
    config.fee_bps = fee_bps;
    event::emit(FeeConfigUpdated { fee_bps, treasury: config.treasury });
}

/// Point the fee at a new treasury address.
public fun set_treasury(_: &AdminCap, config: &mut FeeConfig, treasury: address) {
    config.treasury = treasury;
    event::emit(FeeConfigUpdated { fee_bps: config.fee_bps, treasury });
}

// === Getters (front-end reads) ===

public fun fee_bps(config: &FeeConfig): u64 { config.fee_bps }

public fun treasury(config: &FeeConfig): address { config.treasury }

public fun max_fee_bps(): u64 { MAX_FEE_BPS }

// === Internal ===

/// Carve `fee_bps` of `cost` off `payment` and send it to the treasury. Returns
/// the fee actually taken (0 when `fee_bps` is 0). u128 math avoids overflow.
fun take_fee<Quote>(
    config: &FeeConfig,
    cost: u64,
    payment: &mut Coin<Quote>,
    ctx: &mut TxContext,
): u64 {
    let fee = ((cost as u128) * (config.fee_bps as u128) / (BPS_DENOM as u128)) as u64;
    assert!(payment.value() >= fee, EInsufficientPayment);
    if (fee > 0) {
        let fee_coin = coin::split(payment, fee, ctx);
        transfer::public_transfer(fee_coin, config.treasury);
    };
    fee
}

/// Deposit any non-zero remainder into the caller's manager (it funds the mint);
/// destroy an exact-zero coin so we never deposit dust.
fun fund_manager<Quote>(manager: &mut PredictManager, payment: Coin<Quote>, ctx: &TxContext) {
    if (payment.value() > 0) {
        predict_manager::deposit(manager, payment, ctx);
    } else {
        payment.destroy_zero();
    }
}

// === Entry points ===

/// Mint a binary (up/down) position, charging the Skew fee on top.
///
/// `payment` must cover `fee + (cost − manager free balance)`; the front-end
/// sizes it. `manager` must be owned by the signer.
entry fun mint_with_fee<Quote>(
    config: &FeeConfig,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    expiry: u64,
    strike: u64,
    is_up: bool,
    quantity: u64,
    mut payment: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    let oracle_id = object::id(oracle);

    // 1) chain-authoritative cost → the exact fee base.
    let quote_key = market_key::new(oracle_id, expiry, strike, is_up);
    let (cost, _payout) = predict::get_trade_amounts(predict, oracle, quote_key, quantity, clock);

    // 2) take the fee, 3) fund the manager with the rest.
    let fee = take_fee<Quote>(config, cost, &mut payment, ctx);
    fund_manager<Quote>(manager, payment, ctx);

    // 4) mint — cost is pulled from the manager balance.
    let mint_key = market_key::new(oracle_id, expiry, strike, is_up);
    predict::mint<Quote>(predict, manager, oracle, mint_key, quantity, clock, ctx);

    event::emit(FeeCharged {
        sender: ctx.sender(),
        treasury: config.treasury,
        oracle_id,
        fee_bps: config.fee_bps,
        bet_cost: cost,
        fee_paid: fee,
        is_range: false,
    });
}

/// Mint a vertical-range position, charging the Skew fee on top. Same flow as
/// `mint_with_fee` but for a `(lower, higher]` band.
entry fun mint_range_with_fee<Quote>(
    config: &FeeConfig,
    predict: &mut Predict,
    manager: &mut PredictManager,
    oracle: &OracleSVI,
    expiry: u64,
    lower_strike: u64,
    higher_strike: u64,
    quantity: u64,
    mut payment: Coin<Quote>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quantity > 0, EZeroQuantity);
    let oracle_id = object::id(oracle);

    let quote_key = range_key::new(oracle_id, expiry, lower_strike, higher_strike);
    let (cost, _payout) = predict::get_range_trade_amounts(predict, oracle, quote_key, quantity, clock);

    let fee = take_fee<Quote>(config, cost, &mut payment, ctx);
    fund_manager<Quote>(manager, payment, ctx);

    let mint_key = range_key::new(oracle_id, expiry, lower_strike, higher_strike);
    predict::mint_range<Quote>(predict, manager, oracle, mint_key, quantity, clock, ctx);

    event::emit(FeeCharged {
        sender: ctx.sender(),
        treasury: config.treasury,
        oracle_id,
        fee_bps: config.fee_bps,
        bet_cost: cost,
        fee_paid: fee,
        is_range: true,
    });
}
