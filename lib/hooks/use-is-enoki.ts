import { useWalletConnection } from '@mysten/dapp-kit-react';
import { isEnokiWallet } from '@mysten/enoki';

/**
 * True when the connected wallet is an Enoki (Google / zkLogin) account. These
 * accounts mint gaslessly with a sponsored transaction and **no wallet pop-up**,
 * so the usual "review and sign" moment is missing. Flows that commit funds
 * (mint, mint-range) use this to insert an explicit in-app confirm step instead —
 * the same safety gate the cash-out flow already applies for zkLogin users.
 */
export function useIsEnokiWallet(): boolean {
  const conn = useWalletConnection();
  return !!conn.isConnected && !!conn.wallet && isEnokiWallet(conn.wallet);
}
