/**
 * /v2/kelly — Kelly's hub: Chat, Autopilot and Record under one roof.
 *
 *   /v2/kelly            the chat (the surface and the conversation)
 *   /v2/kelly/autopilot  Kelly trading your rules
 *   /v2/kelly/record     every call she made, signed and scored
 *
 * One live snapshot (active markets + warm pricers) feeds every tab, fetched once here.
 * The three pages this replaced (/v2/copilot, /v2/autopilot, /v2/track-record) redirect
 * here (next.config.ts), so every old link, share card and bookmark still lands.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { KellyHub } from '@/app/_components/v2/kelly/kelly-hub';
import { ErrorState } from '@/app/_components/ui/error-state';
import { loadV2Snapshot } from '@/lib/markets/v2-snapshot';
import { tabFromSegments, tabDef, isTabAvailable } from '@/lib/kelly/hub-tabs';
import { predictV2Config } from '@/config/predict';

export const dynamic = 'force-dynamic';

type Params = Promise<{ tab?: string[] }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const tab = tabFromSegments((await params).tab);
  if (!tab) return {};
  const def = tabDef(tab);
  const base: Metadata = { title: def.title, description: def.description };
  if (tab !== 'chat') return base;
  // The chat keeps the link preview the standalone Kelly page has always had.
  return {
    ...base,
    openGraph: {
      type: 'website',
      title: 'Meet Kelly, the Predict AI Agent that reads the Surface',
      description: def.description,
      images: [{ url: '/ask-kelly-og-card.png', width: 1200, height: 630, alt: 'Kelly, the Skew Predict AI agent, reading the Surface' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Meet Kelly, the Predict AI Agent that reads the Surface',
      description: def.description,
      images: ['/ask-kelly-og-card.png'],
    },
  };
}

export default async function KellyHubPage({ params }: { params: Params }) {
  const tab = tabFromSegments((await params).tab);
  if (!tab || !isTabAvailable(tab)) notFound();

  const result = await loadV2Snapshot();
  if (!result.ok) {
    return (
      <ErrorState
        title="Couldn’t reach the Predict server"
        message={result.error}
        detail={predictV2Config.serverUrl}
        note="Usually a transient network hiccup. Retry in a moment."
      />
    );
  }
  const { markets, now, pricerSeeds } = result.snapshot;
  return <KellyHub initialTab={tab} markets={markets} pricerSeeds={pricerSeeds} serverNow={now} />;
}
