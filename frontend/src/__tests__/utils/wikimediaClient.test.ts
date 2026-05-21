/**
 * Issues #218 / #219 / #220 (tg12 external audit) + Round 7a:
 *
 * Every browser-direct call to Wikipedia or Wikidata must send the
 * `Api-User-Agent` header that Wikimedia's UA policy asks for, AND must
 * embed the per-install operator handle so Wikimedia can rate-limit /
 * contact the specific operator instead of treating "Shadowbroker" as
 * one giant entity.
 *
 * These tests pin both requirements on the shared `lib/wikimediaClient`
 * helper that WikiImage, NewsFeed, and useRegionDossier all route
 * through. A future refactor that drops either the header OR the
 * per-operator handle gets a loud test failure rather than a silent
 * ToS / privacy regression.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWikimediaUserAgent,
  fetchWikipediaSummary,
  fetchWikidataSparql,
  _resetWikimediaClientCacheForTests,
} from '@/lib/wikimediaClient';

const originalFetch = globalThis.fetch;

// Helper: stub fetch so calls to /api/settings/operator-handle return a
// known handle, and everything else proxies to whatever the test set up.
function withHandle(handle: string, otherFetch: typeof globalThis.fetch) {
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/settings/operator-handle')) {
      return new Response(JSON.stringify({ handle }), { status: 200 });
    }
    return otherFetch(input, init);
  });
}

describe('lib/wikimediaClient', () => {
  beforeEach(() => {
    _resetWikimediaClientCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds a stable per-operator Api-User-Agent with contact path', async () => {
    globalThis.fetch = withHandle(
      'operator-abc123',
      vi.fn(async () => new Response('{}', { status: 200 })) as any,
    ) as any;
    const ua = await buildWikimediaUserAgent('wikipedia-summary');
    expect(ua).toContain('Shadowbroker');
    expect(ua.toLowerCase()).toContain('github.com');
    expect(ua.toLowerCase()).toContain('issues');
    expect(ua).toContain('operator: operator-abc123');
    expect(ua).toContain('purpose: wikipedia-summary');
  });

  it('falls back to "operator-offline" when handle endpoint is unreachable', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/api/settings/operator-handle')) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
    const ua = await buildWikimediaUserAgent('test');
    expect(ua).toContain('operator: operator-offline');
  });

  it('sends per-operator Api-User-Agent on Wikipedia summary fetch', async () => {
    const wikiCalls: Array<{ url: string; init?: RequestInit }> = [];
    const baseFetch = vi.fn(async (url: any, init?: RequestInit) => {
      wikiCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          type: 'standard',
          title: 'Boeing 747',
          description: 'aircraft',
          extract: 'long extract',
          thumbnail: { source: 'https://example.org/thumb.jpg' },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = withHandle('operator-test01', baseFetch as any) as any;

    const summary = await fetchWikipediaSummary('Boeing 747');
    expect(summary?.thumbnail).toBe('https://example.org/thumb.jpg');
    // wikiCalls only captures calls to non-handle URLs.
    expect(wikiCalls).toHaveLength(1);
    const headers = (wikiCalls[0].init?.headers || {}) as Record<string, string>;
    expect(headers['Api-User-Agent']).toContain('operator: operator-test01');
    expect(headers['Api-User-Agent']).toContain('purpose: wikipedia-summary');
  });

  it('sends per-operator Api-User-Agent on Wikidata SPARQL fetch', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const baseFetch = vi.fn(async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          results: { bindings: [{ leaderLabel: { value: 'Test Leader' } }] },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = withHandle('operator-sparql', baseFetch as any) as any;

    const bindings = await fetchWikidataSparql('SELECT * WHERE { ?s ?p ?o }');
    expect(bindings).toHaveLength(1);
    const headers = (calls[0].init?.headers || {}) as Record<string, string>;
    expect(headers['Api-User-Agent']).toContain('operator: operator-sparql');
    expect(headers['Api-User-Agent']).toContain('purpose: wikidata-sparql');
    expect(headers['Accept']).toBe('application/sparql-results+json');
  });

  it('handle endpoint is queried only ONCE across many wiki fetches', async () => {
    let handleCalls = 0;
    let wikiCalls = 0;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/api/settings/operator-handle')) {
        handleCalls++;
        return new Response(JSON.stringify({ handle: 'operator-cache' }), { status: 200 });
      }
      wikiCalls++;
      return new Response(
        JSON.stringify({
          type: 'standard',
          title: 'X',
          description: '',
          extract: '',
          thumbnail: { source: 'https://example.org/x.jpg' },
        }),
        { status: 200 },
      );
    }) as any;

    await fetchWikipediaSummary('Eiffel Tower');
    await fetchWikipediaSummary('Mount Fuji');
    await fetchWikipediaSummary('Statue of Liberty');
    expect(handleCalls).toBe(1);
    expect(wikiCalls).toBe(3);
  });

  it('shares cache across consecutive callers for the same Wikipedia title', async () => {
    let fetchCount = 0;
    const baseFetch = vi.fn(async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          type: 'standard',
          title: 'Eiffel Tower',
          description: 'iron lattice tower',
          extract: '...',
          thumbnail: { source: 'https://example.org/eiffel.jpg' },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = withHandle('operator-cache', baseFetch as any) as any;

    const a = await fetchWikipediaSummary('Eiffel Tower');
    const b = await fetchWikipediaSummary('Eiffel Tower');
    expect(fetchCount).toBe(1);
    expect(a?.thumbnail).toBe(b?.thumbnail);
  });

  it('deduplicates concurrent in-flight requests for the same title', async () => {
    let fetchCount = 0;
    const baseFetch = vi.fn(async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(
        JSON.stringify({
          type: 'standard',
          title: 'Mount Fuji',
          description: 'stratovolcano',
          extract: '...',
          thumbnail: { source: 'https://example.org/fuji.jpg' },
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = withHandle('operator-cache', baseFetch as any) as any;

    const [a, b, c] = await Promise.all([
      fetchWikipediaSummary('Mount Fuji'),
      fetchWikipediaSummary('Mount Fuji'),
      fetchWikipediaSummary('Mount Fuji'),
    ]);
    expect(fetchCount).toBe(1);
    expect(a?.thumbnail).toBe('https://example.org/fuji.jpg');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('returns null on disambiguation pages without throwing', async () => {
    globalThis.fetch = withHandle(
      'operator-cache',
      vi.fn(async () =>
        new Response(JSON.stringify({ type: 'disambiguation' }), { status: 200 }),
      ) as any,
    ) as any;
    const summary = await fetchWikipediaSummary('Mercury');
    expect(summary).toBeNull();
  });

  it('returns null on HTTP error without throwing', async () => {
    globalThis.fetch = withHandle(
      'operator-cache',
      vi.fn(async () => new Response('not found', { status: 404 })) as any,
    ) as any;
    const summary = await fetchWikipediaSummary('Nonexistent Article 12345');
    expect(summary).toBeNull();
  });

  it('returns null on network error without throwing', async () => {
    globalThis.fetch = withHandle(
      'operator-cache',
      vi.fn(async () => {
        throw new Error('network down');
      }) as any,
    ) as any;
    const summary = await fetchWikipediaSummary('Anything');
    expect(summary).toBeNull();
  });

  it('returns null on empty input without fetching anything', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as any;
    expect(await fetchWikipediaSummary('')).toBeNull();
    expect(await fetchWikipediaSummary('   ')).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
