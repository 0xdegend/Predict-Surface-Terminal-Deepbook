/**
 * lib/sui/dapp-kit.ts — single dApp Kit instance (v2, gRPC).
 *
 * Uses @mysten/dapp-kit-react (NOT the deprecated bare @mysten/dapp-kit) and a
 * SuiGrpcClient per the current SDK. Network + endpoints come from config/predict.ts
 * so a mainnet swap stays a one-place change.
 */
import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { ACTIVE_NETWORK, getPredictConfig, type SuiNetwork } from '@/config/predict';

const NETWORKS: SuiNetwork[] = ['testnet', 'mainnet'];

export const dAppKit = createDAppKit({
  networks: NETWORKS,
  defaultNetwork: ACTIVE_NETWORK,
  createClient: (network: SuiNetwork) =>
    new SuiGrpcClient({ network, baseUrl: getPredictConfig(network).grpcUrl }),
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
