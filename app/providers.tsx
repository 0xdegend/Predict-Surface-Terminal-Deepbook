'use client';

import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { dAppKit } from '@/lib/sui/dapp-kit';
import { Toaster } from './_components/toaster';
import { RegisterEnokiWallets } from './_components/register-enoki-wallets';

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

  return (
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        {/* Registers "Sign in with Google" (Enoki zkLogin) into the wallet list. */}
        <RegisterEnokiWallets />
        {children}
        <Toaster />
      </DAppKitProvider>
    </QueryClientProvider>
  );
}
