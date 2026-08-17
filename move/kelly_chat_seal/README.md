# kelly_chat_seal — Seal access policy for Kelly chat encryption

This tiny Move package is the on-chain half of end-to-end encrypting Kelly's chat history with
[Seal](https://github.com/MystenLabs/seal). It defines one function, `seal_approve`, which Seal's
key servers evaluate before releasing a decryption key. The rule is the standard Seal **account
pattern**: a conversation is encrypted to an identity that starts with the owner's 32-byte address,
and `seal_approve` grants a key only when the requester's address prefixes that identity. So only
the wallet that owns a chat can ever decrypt it — the app server never can.

## Why a package at all

Seal has no shared/global policy: the `seal_approve` you deploy *is* the access control. The app
encrypts against this package's id, and every decryption dry-runs this function. Nothing here holds
data or state; it's pure policy.

## Deploy (testnet)

```bash
cd move/kelly_chat_seal
sui move build          # compile + sanity-check the policy first
sui client publish --gas-budget 100000000
```

Copy the published **package id** from the output.

## Wire it into the app

Set these env vars (client-visible, so `NEXT_PUBLIC_`):

```
NEXT_PUBLIC_KELLY_CHAT_SEAL=1
NEXT_PUBLIC_SEAL_PACKAGE_ID=0x<published package id>
NEXT_PUBLIC_SEAL_THRESHOLD=2
NEXT_PUBLIC_SEAL_KEY_SERVERS=<objectId1>,<objectId2>,...
```

`NEXT_PUBLIC_SEAL_KEY_SERVERS` is the comma-separated list of Seal **key-server object ids** for
the network. Get the current testnet set from the Seal docs / `getAllowlistedKeyServers('testnet')`
(the list changes, so it's config, not hard-coded). Use at least `THRESHOLD` of them.

Until all four are set, the app keeps chat history in its current (unencrypted, unlisted) form —
the encryption path is gated behind `sealConfigured()` (see `config/seal.ts`).

## Mainnet

Republish this package on mainnet and swap `NEXT_PUBLIC_SEAL_PACKAGE_ID` + the mainnet key-server
ids. Same one-env-switch cutover story as the rest of the app.
