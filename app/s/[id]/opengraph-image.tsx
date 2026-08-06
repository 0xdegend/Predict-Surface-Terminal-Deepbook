/**
 * OG card for a short shared trade link. Resolves the id to its recipe token and
 * renders the shared card (lib/share/og-card), so /s/[id] unfurls exactly like /t.
 */
import { decodeRecipe } from '@/lib/share/trade-link';
import { resolveShortLink } from '@/lib/server/share-store';
import { renderTradeOg, OG_ALT, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/share/og-card';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const token = await resolveShortLink((await params).id);
  return renderTradeOg(token ? decodeRecipe(token) : null);
}
