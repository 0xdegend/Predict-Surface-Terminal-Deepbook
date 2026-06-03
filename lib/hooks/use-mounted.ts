'use client';

import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/**
 * Returns false on the server and during the first client render (hydration),
 * then true once mounted. Use to gate wallet/account-dependent UI so SSR and the
 * first client paint match — the connected-account value is only known on the
 * client, so rendering it during SSR causes a hydration mismatch.
 *
 * Implemented with useSyncExternalStore (server snapshot = false) so there's no
 * setState-in-effect and the switch happens cleanly right after hydration.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
