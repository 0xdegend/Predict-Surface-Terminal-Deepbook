/**
 * Dynamic Open Graph card for a long shared trade link. Next auto-wires this to
 * og:image / twitter:image for /t/[token]. Rendering lives in lib/share/og-card (shared
 * with the short /s/[id] route).
 */
import { decodeRecipe } from '@/lib/share/trade-link';
import { renderTradeOg, OG_ALT, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/share/og-card';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  return renderTradeOg(decodeRecipe((await params).token));
}
