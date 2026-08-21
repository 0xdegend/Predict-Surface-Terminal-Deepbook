'use client';

/**
 * lib/sui/grpc.ts — the React-facing barrel over [[lib/sui/grpc-core]].
 *
 * Everything about endpoint selection and failover lives in the core module, which is
 * deliberately framework-free so SERVER code can share the same endpoint choice. This
 * file adds the one piece that cannot cross that line: a hook that re-renders a caller
 * when the endpoint fails over, so a live query picks up the healthy node on its next
 * poll rather than at the next reload.
 *
 * Re-exports the core surface so the ~20 existing client-side imports are unchanged.
 */
import { useSyncExternalStore } from 'react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { subscribe, activeGrpcUrl, v2ReadClient } from './grpc-core';

export {
  activeGrpcUrl,
  resolveGrpcUrl,
  v2ReadClient,
  grpcRead,
  startGrpcHealthMonitor,
  subscribe,
} from './grpc-core';

/** React hook: the current read client, re-rendering the caller when the endpoint
 *  fails over so the live query picks up the healthy node on its next poll. */
export function useV2ReadClient(): SuiGrpcClient {
  useSyncExternalStore(subscribe, activeGrpcUrl, activeGrpcUrl);
  return v2ReadClient();
}
