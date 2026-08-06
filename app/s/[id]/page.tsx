/**
 * /s/[id] — the SHORT form of a shared trade link. Resolves the id to its recipe token
 * (Upstash-backed, see lib/server/share-store) and renders the same landing as the long
 * /t/[token] link. Pretty, shareable, and it unfurls with the same OG card.
 */
import type { Metadata } from 'next';
import { decodeRecipe } from '@/lib/share/trade-link';
import { resolveShortLink } from '@/lib/server/share-store';
import { SharedTradeLanding, sharedTradeMetadata } from '@/app/_components/v2/share/shared-trade-landing';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

async function recipeForId(id: string) {
  const token = await resolveShortLink(id);
  return token ? decodeRecipe(token) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return sharedTradeMetadata(await recipeForId((await params).id));
}

export default async function ShortSharePage({ params }: Params) {
  return <SharedTradeLanding recipe={await recipeForId((await params).id)} />;
}
