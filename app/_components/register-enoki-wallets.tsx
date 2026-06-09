'use client';

/**
 * RegisterEnokiWallets — registers Enoki zkLogin wallets ("Sign in with Google")
 * into the Wallet Standard registry, so they show up in the SAME `useWallets()`
 * list the WalletBar already renders — no bespoke connect UI required.
 *
 * Enoki takes the active dApp Kit client + network. Our client is a
 * `SuiGrpcClient`, which implements the `ClientWithCoreApi` Enoki expects, so it
 * passes through directly (no separate JSON-RPC client). We only register on
 * Enoki-supported networks (testnet/mainnet) and only when the public keys are
 * configured. Returns the SDK's `unregister` on cleanup so HMR / network switches
 * don't leave duplicate wallets behind.
 *
 * Gasless: once the Predict move-targets are allowlisted + a budget is set in the
 * Enoki portal, the registered wallet sponsors `signAndExecuteTransaction`
 * automatically — the existing mint/redeem PTBs need no change.
 */
import { useEffect } from 'react';
import { useCurrentClient, useCurrentNetwork } from '@mysten/dapp-kit-react';
import { registerEnokiWallets, isEnokiNetwork } from '@mysten/enoki';
import { enokiConfig, enokiEnabled } from '@/config/enoki';

export function RegisterEnokiWallets() {
  const client = useCurrentClient();
  const network = useCurrentNetwork();

  useEffect(() => {
    if (!enokiEnabled || !isEnokiNetwork(network)) return;

    const { unregister } = registerEnokiWallets({
      apiKey: enokiConfig.apiKey,
      providers: {
        google: {
          clientId: enokiConfig.googleClientId,
          // OAuth popup returns to the lightweight /auth callback (NOT the heavy
          // home page, which renders blank in a popup and stalls the handshake).
          // Authorize this EXACT url in Google (Authorized redirect URIs) +
          // the Enoki portal: e.g. http://localhost:3000/auth and <prod>/auth.
          redirectUrl:
            typeof window !== 'undefined' ? `${window.location.origin}/auth` : undefined,
        },
      },
      client,
      network,
    });

    return unregister;
  }, [client, network]);

  return null;
}
