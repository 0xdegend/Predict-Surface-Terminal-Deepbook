/**
 * The experience prompt asks a visitor to choose between two screens and then routes
 * them to one. If the simple screen is switched off while the prompt is on, every
 * visitor who answers "I'm new to this" is sent to a route that redirects straight back
 * to the terminal — the worst possible first impression, and invisible in review because
 * it only shows up in one env combination.
 *
 * So the flags are hard-ANDed in config, and this pins that: there is NO combination of
 * environment variables that puts the prompt in front of someone it cannot serve.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

async function flags(simple: string | undefined, prompt: string | undefined) {
  vi.resetModules();
  if (simple === undefined) vi.stubEnv('NEXT_PUBLIC_SIMPLE_MODE', '');
  else vi.stubEnv('NEXT_PUBLIC_SIMPLE_MODE', simple);
  if (prompt === undefined) vi.stubEnv('NEXT_PUBLIC_EXPERIENCE_PROMPT', '');
  else vi.stubEnv('NEXT_PUBLIC_EXPERIENCE_PROMPT', prompt);
  const mod = await import('@/config/predict');
  return { simple: mod.V2_SIMPLE_ENABLED, prompt: mod.V2_EXPERIENCE_PROMPT_ENABLED };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('experience prompt flags', () => {
  it('is on only when BOTH are set', async () => {
    expect(await flags('1', '1')).toEqual({ simple: true, prompt: true });
  });

  it('cannot be on without the simple screen it routes to', async () => {
    // The dangerous combination: someone turns simple mode off after a bad deploy and
    // forgets the prompt. Answering "beginner" would bounce off the route redirect.
    expect((await flags('0', '1')).prompt).toBe(false);
    expect((await flags(undefined, '1')).prompt).toBe(false);
  });

  it('stays off until explicitly turned on, so simple mode alone never starts prompting', async () => {
    expect((await flags('1', '0')).prompt).toBe(false);
    expect((await flags('1', undefined)).prompt).toBe(false);
  });

  it('treats anything other than "1" as off, so a stray "true" cannot ship it', async () => {
    expect((await flags('1', 'true')).prompt).toBe(false);
    expect((await flags('true', '1')).simple).toBe(false);
  });
});
