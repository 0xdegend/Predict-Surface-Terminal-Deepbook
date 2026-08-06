/**
 * lib/share/og-card.tsx — the shared Open Graph card renderer for a shared trade,
 * used by both /t/[token] and /s/[id] opengraph-image routes.
 *
 * Shows only the STABLE trade shape (asset, direction, level, size, leverage, tenor),
 * never live odds: social platforms cache the first scrape, so a baked-in number would
 * freeze and mislead. Self-contained: pure flexbox + colors, no external images/fonts,
 * so it renders without a runtime fetch (satori requires display:flex on every
 * multi-child node).
 */
import { ImageResponse } from 'next/og';
import type { TradeRecipe } from '@/lib/share/trade-link';
import { CADENCE_LABEL } from '@/lib/markets/v2-discovery';

export const OG_ALT = 'A trade set up for you on Skew';
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

const TEAL = '#4dd6b0';
const CORAL = '#f0796b';
const TEXT = '#E6E8EB';
const DIM = '#8b9099';
const LINE = 'rgba(255,255,255,0.12)';
const BG = '#0A0B0D';

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

function headlineOf(r: TradeRecipe): string {
  if (r.mode === 'range') return `BTC between ${usd(r.lower!)} and ${usd(r.higher!)}`;
  if (r.strike != null) return `BTC ${r.isUp ? 'above' : 'below'} ${usd(r.strike)}`;
  return r.isUp ? 'BTC Up' : 'BTC Down';
}

function chipsOf(r: TradeRecipe): { label: string; color: string }[] {
  const dir =
    r.mode === 'range'
      ? { label: 'Range', color: TEAL }
      : { label: r.isUp ? 'Up ▲' : 'Down ▼', color: r.isUp ? TEAL : CORAL };
  const out = [dir, { label: usd(r.stake), color: TEXT }];
  if (r.lev > 1) out.push({ label: `${r.lev}x`, color: TEXT });
  out.push({ label: CADENCE_LABEL[r.tenor], color: DIM });
  return out;
}

/** Render the OG PNG for a recipe (or a neutral Skew card when the link is bad). */
export function renderTradeOg(recipe: TradeRecipe | null): ImageResponse {
  const who = recipe?.ref ? `${recipe.ref} set up a trade` : 'A trade was set up for you';
  const headline = recipe ? headlineOf(recipe) : 'Trade the shape of volatility';
  const chips = recipe ? chipsOf(recipe) : [];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: BG,
          color: TEXT,
          padding: 60,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -160,
            right: -120,
            width: 620,
            height: 620,
            borderRadius: 620,
            background: 'radial-gradient(circle, rgba(77,214,176,0.18) 0%, rgba(77,214,176,0) 70%)',
            display: 'flex',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: `linear-gradient(135deg, ${TEAL}, #2f9c80)`,
                transform: 'rotate(45deg)',
                display: 'flex',
              }}
            />
            <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>Skew</span>
          </div>
          <span style={{ fontSize: 20, color: DIM }}>{who}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <span style={{ fontSize: 18, color: TEAL, letterSpacing: 3, textTransform: 'uppercase' }}>
            You have a trade waiting
          </span>
          <span style={{ fontSize: 68, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1.05 }}>{headline}</span>
          <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
            {chips.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: '8px 16px',
                  fontSize: 22,
                  color: c.color,
                }}
              >
                {c.label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 22, fontWeight: 600, color: TEAL }}>Open on Skew →</span>
          <span style={{ fontSize: 16, color: DIM }}>Powered by DeepBook Predict</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
