/**
 * lib/sui/dapp-kit.ts — single dApp Kit instance (v2, gRPC).
 *
 * Uses @mysten/dapp-kit-react (NOT the deprecated bare @mysten/dapp-kit) and a
 * SuiGrpcClient per the current SDK. Network + endpoints come from config/predict.ts
 * so a mainnet swap stays a one-place change.
 */
import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { ACTIVE_NETWORK, type SuiNetwork } from '@/config/predict';
import { resolveGrpcUrl } from '@/lib/sui/grpc';

const NETWORKS: SuiNetwork[] = ['testnet', 'mainnet'];

export const dAppKit = createDAppKit({
  networks: NETWORKS,
  defaultNetwork: ACTIVE_NETWORK,
  // `resolveGrpcUrl` returns the last-known-good endpoint, so the wallet/tx client
  // lands on a synced node if the primary fullnode is stalled at load time, and
  // returns to the primary on a later load once it has recovered (see lib/sui/grpc.ts).
  createClient: (network: SuiNetwork) =>
    new SuiGrpcClient({ network, baseUrl: resolveGrpcUrl(network) }),
  // Slush web wallet (in-browser, no extension) is the recommended target — it
  // fully supports `sui:testnet`. Phantom's Sui support is mainnet-oriented and
  // fails to dry-run testnet transactions (the wallet executes on the chain the
  // dApp requests, not our read client), so prefer Slush for the demo.
  slushWalletConfig: { appName: 'Predict Surface Terminal' },
});

// React hook type augmentation — hooks infer the instance without passing it explicitly.
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
