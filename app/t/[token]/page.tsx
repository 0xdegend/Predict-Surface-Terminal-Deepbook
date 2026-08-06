/**
 * /t/[token] — the recipient landing for a shared trade link. Decodes the recipe
 * from the URL (server-side) and shows a "someone set up a trade for you" card with
 * the trade's shape, then hands off to the client OpenSharedTrade button, which
 * re-resolves it onto a live market and opens the pre-filled ticket on /v2.
 *
 * The recipe lives entirely in the URL, so the link is durable: a reload re-decodes
 * it, and because sign-in is a popup (see /auth) the trader's session is established
 * without ever navigating away from the pre-filled ticket. Nothing here signs or
 * spends; it only sets up the ticket.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { decodeRecipe, recipeLabel, type TradeRecipe } from '@/lib/share/trade-link';
import { CADENCE_LABEL } from '@/lib/markets/v2-discovery';
import { OpenSharedTrade } from './open-trade';

type Params = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const recipe = decodeRecipe((await params).token);
  if (!recipe) return { title: 'Trade link · Skew' };
  const label = recipeLabel(recipe);
  const who = recipe.ref ? `${recipe.ref} set up a trade` : 'A trade was set up for you';
  return {
    title: `${label} · Skew`,
    description: `${who} on Skew: ${label}. Open it and place it in a tap.`,
  };
}

/** Direction / range chip label for the shape. */
function directionLabel(recipe: TradeRecipe): string {
  if (recipe.mode === 'range') return 'Range';
  return recipe.isUp ? 'Up ▲' : 'Down ▼';
}

export default async function SharedTradePage({ params }: Params) {
  const recipe = decodeRecipe((await params).token);

  if (!recipe) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-0 px-6">
        <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-8 text-center">
          <p className="font-mono text-[11px] uppercase tracking-wider text-text-3">Skew</p>
          <h1 className="mt-3 font-sans text-[18px] font-semibold text-text-1">This trade link is not valid</h1>
          <p className="mt-2 font-sans text-[13px] text-text-2">
            It may have been mistyped, or the link format has since changed.
          </p>
          <Link
            href="/v2"
            className="mt-6 inline-block w-full rounded-lg bg-up py-3 text-[13px] font-semibold text-bg-0 transition-opacity hover:opacity-90"
          >
            Go to Skew
          </Link>
        </div>
      </main>
    );
  }

  const who = recipe.ref ? `${recipe.ref} set up a trade for you` : 'Someone set up a trade for you';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg-0 px-6 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-bg-1 p-8">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/skew-mark.png" alt="Skew" width={28} height={28} className="h-7 w-7" />
          <span className="font-sans text-[15px] font-semibold text-text-1">Skew</span>
        </div>

        <p className="mt-7 font-mono text-[11px] uppercase tracking-wider text-up">You have a trade waiting</p>
        <h1 className="mt-2 font-sans text-[19px] font-semibold leading-snug text-text-1">{who}</h1>

        {/* The shape, as a compact receipt. */}
        <div className="mt-5 rounded-xl border border-line bg-bg-0 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-text-1">
              {directionLabel(recipe)}
            </span>
            <span className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-text-2">
              {CADENCE_LABEL[recipe.tenor]}
            </span>
            {recipe.lev > 1 && (
              <span className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-text-2">
                {recipe.lev}x
              </span>
            )}
          </div>
          <p className="mt-3 font-mono text-[15px] tabular-nums text-text-1">{recipeLabel(recipe)}</p>
        </div>

        <div className="mt-6">
          <OpenSharedTrade recipe={recipe} />
        </div>

        <p className="mt-3 text-center font-sans text-[11px] text-text-3">
          You will see the live price before you place anything. Nothing is signed until you confirm.
        </p>
      </div>
    </main>
  );
}
