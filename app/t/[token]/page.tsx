/**
 * /t/[token] — the recipient landing for a shared trade link (the long form; /s/[id]
 * is the short form). Decodes the recipe from the URL and renders the shared landing.
 *
 * The recipe lives entirely in the URL, so the link is durable: a reload re-decodes
 * it, and because sign-in is a popup (see /auth) the trader's session is established
 * without ever navigating away from the pre-filled ticket. Nothing here signs.
 */
import type { Metadata } from 'next';
import { decodeRecipe } from '@/lib/share/trade-link';
import { SharedTradeLanding, sharedTradeMetadata } from '@/app/_components/v2/share/shared-trade-landing';

type Params = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return sharedTradeMetadata(decodeRecipe((await params).token));
}

export default async function SharedTradePage({ params }: Params) {
  return <SharedTradeLanding recipe={decodeRecipe((await params).token)} />;
}
