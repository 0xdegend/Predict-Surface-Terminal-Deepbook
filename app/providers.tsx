'use client';

import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { startGrpcHealthMonitor } from '@/lib/sui/grpc';
import { Toaster } from './_components/toaster';
import { KellyDock } from './_components/v2/copilot/kelly-dock';
import { RegisterEnokiWallets } from './_components/register-enoki-wallets';
import { WalletTracker } from './_components/wallet-tracker';
import { TourLauncher } from './_components/tour/tour-launcher';
import { TourOverlay } from './_components/tour/tour-overlay';

export function Providers({ children }: { children: React.ReactNode }) {
  // One QueryClient per app lifetime. useState avoids re-creating on re-render
  // and keeps it client-side (no SSR cache leakage across requests).
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  // Watch fullnode health and fail the gRPC endpoint over to a synced node when the
  // primary stalls, returning to it automatically once it recovers (lib/sui/grpc.ts).
  useEffect(() => {
    startGrpcHealthMonitor();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        {/* Registers "Sign in with Google" (Enoki zkLogin) into the wallet list. */}
        <RegisterEnokiWallets />
        {/* Silent beacon: records the connected wallet's sign-in category (Google /
            Slush / Other) for the admin wallet-mix card. Renders nothing. */}
        <WalletTracker />
        {children}
        {/* Always-present "Ask Kelly" launcher + chat drawer (self-hides on the
            full co-pilot page and the auth popup). */}
        <KellyDock />
        <Toaster />
        {/* Guided tour for the Latest (v2) Trade screen. TourLauncher auto-opens
            it once per browser on first landing at /v2 (it self-gates by route);
            TourOverlay renders nothing until the tour is active, so mounting both
            globally here is safe. Replay is the "?" TourButton in the v2 chrome. */}
        <TourLauncher />
        <TourOverlay />
      </DAppKitProvider>
    </QueryClientProvider>
  );
}
