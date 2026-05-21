/**
 * wikimediaClient — single fetch surface for Wikipedia / Wikidata.
 *
 * Issues #218, #219, #220 (tg12 external audit) + Round 7a:
 *
 * Wikimedia's User-Agent policy asks API clients to identify themselves
 * via `Api-User-Agent` when calling from browser JavaScript (because the
 * browser does not let JS set `User-Agent` directly). Three independent
 * components used to issue anonymous browser fetches against Wikipedia /
 * Wikidata:
 *
 *   - useRegionDossier  (Wikidata SPARQL + Wikipedia REST summary)
 *   - WikiImage          (Wikipedia REST summary)
 *   - NewsFeed           (Wikipedia REST summary)
 *
 * PR #284 collapsed them into this shared helper with one stable
 * `Api-User-Agent`. That fixed compliance but introduced a new problem:
 * the `Api-User-Agent` was project-wide, so from Wikimedia's perspective
 * every Shadowbroker install looked like one giant scraper. If one
 * install misbehaved, Wikimedia's only recourse was to block the project
 * as a whole.
 *
 * Round 7a fixes that. The frontend fetches the per-install operator
 * handle from `GET /api/settings/operator-handle` once on first use and
 * embeds it in the `Api-User-Agent`. Wikimedia can now rate-limit /
 * contact the specific install instead of the project. The handle is
 * auto-generated on the backend (`shadow-XXXXXX`) or operator-chosen via
 * the `OPERATOR_HANDLE` setting.
 *
 * UX impact: zero. Same thumbnails, same summaries, same load behavior.
 * The only observable change is the value of the outgoing
 * `Api-User-Agent` header.
 */

// Module-level cache shared by WikiImage, NewsFeed, and useRegionDossier.
// Keyed by Wikipedia article title (NOT slug — we keep the human-readable
// form so debugging the cache is easier). Values track in-flight state
// so concurrent callers for the same title share one network request.
export interface WikipediaSummary {
  title: string;
  description: string;
  extract: string;
  thumbnail: string;
  type: string; // 'standard' | 'disambiguation' | etc.
}

interface CacheEntry {
  summary: WikipediaSummary | null;
  inflight: Promise<WikipediaSummary | null> | null;
  loaded: boolean;
}

const _summaryCache: Map<string, CacheEntry> = new Map();
const SUMMARY_CACHE_MAX = 512;

function evictIfOverCap() {
  if (_summaryCache.size <= SUMMARY_CACHE_MAX) return;
  const oldest = _summaryCache.keys().next().value;
  if (oldest) _summaryCache.delete(oldest);
}

// ─── Per-operator handle (Round 7a) ────────────────────────────────────────

// Fetched once from the backend on first need and cached for the page
// lifetime. The handle is NOT a secret — Wikimedia will see it on every
// Wikipedia / Wikidata request we make — but caching it locally avoids a
// round-trip on every Wikipedia fetch and lets the offline / no-backend
// case still produce a stable UA (the fallback handle).
let _handlePromise: Promise<string> | null = null;
let _cachedHandle: string | null = null;

const FALLBACK_HANDLE = 'operator-offline';
const HANDLE_ENDPOINT = '/api/settings/operator-handle';

async function fetchOperatorHandle(): Promise<string> {
  try {
    const res = await fetch(HANDLE_ENDPOINT, {
      // Use the standard relative-path proxy so the Next.js admin-key
      // injection (same-origin) flows naturally for legitimate browser
      // sessions. A cross-origin scanner will be blocked by the proxy
      // before this even leaves their browser.
      credentials: 'same-origin',
    });
    if (!res.ok) return FALLBACK_HANDLE;
    const data = await res.json();
    const h = (data && typeof data.handle === 'string' && data.handle.trim()) || '';
    return h || FALLBACK_HANDLE;
  } catch {
    return FALLBACK_HANDLE;
  }
}

async function getOperatorHandle(): Promise<string> {
  if (_cachedHandle) return _cachedHandle;
  if (!_handlePromise) {
    _handlePromise = fetchOperatorHandle().then((h) => {
      _cachedHandle = h;
      return h;
    });
  }
  return _handlePromise;
}

/** Build the Wikimedia Api-User-Agent for this install.
 *
 * Includes the per-install operator handle so Wikimedia can rate-limit /
 * contact the specific operator instead of the project as a whole.
 * Exported for tests; production callers should let
 * `fetchWikipediaSummary` / `fetchWikidataSparql` build it implicitly.
 */
export async function buildWikimediaUserAgent(purpose: string): Promise<string> {
  const handle = await getOperatorHandle();
  const safePurpose = (purpose || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  return (
    `Shadowbroker/1.0 (operator: ${handle}; purpose: ${safePurpose}; ` +
    '+https://github.com/BigBodyCobain/Shadowbroker; report issues at /issues)'
  );
}

// ─── Wikipedia summary fetch ───────────────────────────────────────────────

/** Fetch a Wikipedia article summary (titles, NOT URLs).
 *
 * Empty / invalid input resolves to `null`. Network errors and disambig
 * pages also resolve to `null` so callers can render a fallback without
 * a try/catch. Per the audit's "fail forward, not loud" rule.
 */
export async function fetchWikipediaSummary(
  title: string,
): Promise<WikipediaSummary | null> {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;

  const cached = _summaryCache.get(trimmed);
  if (cached?.loaded) return cached.summary;
  if (cached?.inflight) return cached.inflight;

  const slug = encodeURIComponent(trimmed.replace(/ /g, '_'));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;

  const promise = (async (): Promise<WikipediaSummary | null> => {
    try {
      const ua = await buildWikimediaUserAgent('wikipedia-summary');
      const r = await fetch(url, { headers: { 'Api-User-Agent': ua } });
      if (!r.ok) return null;
      const d = await r.json();
      if (d?.type === 'disambiguation') return null;
      return {
        title: trimmed,
        description: d?.description || '',
        extract: d?.extract || '',
        thumbnail: d?.thumbnail?.source || d?.originalimage?.source || '',
        type: d?.type || 'standard',
      };
    } catch {
      return null;
    }
  })().then((summary) => {
    _summaryCache.set(trimmed, { summary, inflight: null, loaded: true });
    evictIfOverCap();
    return summary;
  });

  _summaryCache.set(trimmed, { summary: null, inflight: promise, loaded: false });
  evictIfOverCap();
  return promise;
}

// ─── Wikidata SPARQL ───────────────────────────────────────────────────────

/** Fetch a Wikidata SPARQL query result.
 *
 * Returns the parsed JSON `results.bindings` array on success; `null`
 * (not throwing) on any failure so callers can render fallbacks
 * silently. Per-install operator handle threaded through `Api-User-Agent`
 * (Round 7a).
 */
export async function fetchWikidataSparql<T = Record<string, { value: string }>>(
  sparql: string,
): Promise<T[] | null> {
  const trimmed = (sparql || '').trim();
  if (!trimmed) return null;
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(
    trimmed,
  )}&format=json`;
  try {
    const ua = await buildWikimediaUserAgent('wikidata-sparql');
    const res = await fetch(url, {
      headers: {
        'Api-User-Agent': ua,
        Accept: 'application/sparql-results+json',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const bindings = json?.results?.bindings;
    return Array.isArray(bindings) ? (bindings as T[]) : null;
  } catch {
    return null;
  }
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Internal: clear the shared cache + the handle cache. Exposed for tests only. */
export function _resetWikimediaClientCacheForTests() {
  _summaryCache.clear();
  _handlePromise = null;
  _cachedHandle = null;
}
