import { describe, it, expect } from 'vitest';
import { parseIntent } from './intents';
import { respondToIntent, type CopilotContext } from './respond';

const NOW = 1_700_000_000_000;

type Wallet = NonNullable<CopilotContext['wallet']>;
const wallet = (over: Partial<Wallet> = {}): Wallet => ({
  connected: true,
  hasAccount: true,
  accountBase: 0n,
  walletBase: 0n,
  grantEligible: false,
  ...over,
});

const ctx = (w: Wallet | null): CopilotContext => ({
  insights: null,
  candidates: [],
  now: NOW,
  spot: 65_000,
  wallet: w,
});

describe('onboarding — intent parsing', () => {
  it('routes create-account / get-tokens / get-started phrases', () => {
    expect(parseIntent('create my trading account').kind).toBe('create_account');
    expect(parseIntent('set up my account').kind).toBe('create_account'); // survives the "set up" strip (matched on raw)
    expect(parseIntent('open an account for me').kind).toBe('create_account');
    expect(parseIntent('get test tokens').kind).toBe('get_tokens');
    expect(parseIntent('can I get an airdrop?').kind).toBe('get_tokens');
    expect(parseIntent('fund my account').kind).toBe('get_tokens');
    expect(parseIntent('give me some dusdc').kind).toBe('get_tokens');
    expect(parseIntent('how do I get started?').kind).toBe('onboarding');
    expect(parseIntent("I'm new here").kind).toBe('onboarding');
  });

  it('does NOT hijack the existing balance / explain / trade intents', () => {
    expect(parseIntent('how much dusdc do I have').kind).toBe('balance');
    expect(parseIntent('check my funds').kind).toBe('balance');
    expect(parseIntent('what is dusdc')).toMatchObject({ kind: 'explain', topic: 'funds' });
    expect(parseIntent('set up a trade').kind).toBe('start_trade');
    expect(parseIntent('strike 66000, 2x, 6 dusdc').kind).toBe('start_trade');
  });
});

describe('onboarding — state-aware replies', () => {
  it('not signed in: reassures you can still ask, no action button', () => {
    const r = respondToIntent({ kind: 'onboarding' }, ctx(null));
    expect(r.text.join(' ')).toMatch(/don't need to sign in/i);
    expect(r.action).toBeUndefined();
  });

  it('not signed in: also handles an explicit "get tokens" gracefully', () => {
    const r = respondToIntent({ kind: 'get_tokens' }, ctx(wallet({ connected: false, hasAccount: false })));
    expect(r.text.join(' ')).toMatch(/Connect/i);
    expect(r.action).toBeUndefined();
  });

  it('brand-new empty wallet (grant eligible): offers test tokens FIRST', () => {
    const r = respondToIntent({ kind: 'onboarding' }, ctx(wallet({ hasAccount: false, grantEligible: true })));
    expect(r.action).toEqual({ kind: 'get_tokens', label: 'Get test tokens' });
  });

  it('signed in + funded but no account: offers to create the account', () => {
    const r = respondToIntent({ kind: 'onboarding' }, ctx(wallet({ hasAccount: false, walletBase: 50_000_000n, grantEligible: false })));
    expect(r.action).toEqual({ kind: 'create_account', label: 'Create trading account' });
  });

  it('has an account but out of tokens (grant NOT eligible): points to the faucet, no airdrop button', () => {
    const r = respondToIntent({ kind: 'onboarding' }, ctx(wallet({ hasAccount: true, accountBase: 0n, walletBase: 0n, grantEligible: false })));
    expect(r.text.join(' ')).toMatch(/faucet/i);
    expect(r.action).toBeUndefined();
  });

  it('signed in, account, funded: all set, no action', () => {
    const r = respondToIntent({ kind: 'onboarding' }, ctx(wallet({ hasAccount: true, walletBase: 50_000_000n })));
    expect(r.text.join(' ')).toMatch(/all set/i);
    expect(r.action).toBeUndefined();
  });

  it('explicit create-account with an account already: says you are ready', () => {
    const r = respondToIntent({ kind: 'create_account' }, ctx(wallet({ hasAccount: true })));
    expect(r.text.join(' ')).toMatch(/already got a trading account/i);
    expect(r.action).toBeUndefined();
  });

  it('explicit get-tokens, grant eligible: offers the airdrop button', () => {
    const r = respondToIntent({ kind: 'get_tokens' }, ctx(wallet({ hasAccount: false, grantEligible: true })));
    expect(r.action).toEqual({ kind: 'get_tokens', label: 'Get test tokens' });
  });

  it('explicit get-tokens, NOT eligible + already funded: no button, says you are set', () => {
    const r = respondToIntent({ kind: 'get_tokens' }, ctx(wallet({ hasAccount: true, walletBase: 50_000_000n, grantEligible: false })));
    expect(r.action).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/already got test tokens/i);
  });

  it('explicit get-tokens, NOT eligible + returning empty wallet: no button, points to faucet', () => {
    const r = respondToIntent({ kind: 'get_tokens' }, ctx(wallet({ hasAccount: true, walletBase: 0n, grantEligible: false })));
    expect(r.action).toBeUndefined();
    expect(r.text.join(' ')).toMatch(/faucet/i);
  });
});
