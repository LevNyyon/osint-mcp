// Keyless OSINT scrapers. Each source takes { name, domain } and returns a
// flat array of normalized hits. Pure fetch — no DB, no LLM. The caller's
// model decides what matters; this just brings back the raw signal.
//
// Ported from the nyyon command-center OSINT module.

const UA = 'osint-mcp/0.1 (+https://github.com/; contact: set OSINT_CONTACT)';

// ── helpers ──────────────────────────────────────────────────
const enc = new TextEncoder();
async function sha1Hex(str) {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function mentionId(source, url, text = '') {
  return (await sha1Hex(`${source}\0${url || ''}\0${(text || '').slice(0, 500)}`)).slice(0, 16);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Throttle {
  constructor(gap) { this.gap = gap; this.last = 0; }
  async wait() { const s = Date.now() - this.last; if (s < this.gap) await sleep(this.gap - s); this.last = Date.now(); }
}
async function getJson(url, { headers = {}, throttle, timeoutMs = 15000 } = {}) {
  if (throttle) await throttle.wait();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} @ ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getText(url, { headers = {}, throttle, timeoutMs = 15000 } = {}) {
  if (throttle) await throttle.wait();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', ...headers }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`${r.status} @ ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
function isoToMs(input) {
  if (input == null) return null;
  if (typeof input === 'number') return input < 1e12 ? input * 1000 : input;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// Confidence 0..1: 1.0 domain hit, 0.6 name + product cue nearby, 0.4 bare
// name, 0 otherwise. A relevance HINT — not a verdict. The client decides.
const CUES = /\b(app|tool|tools|software|product|saas|platform|company|team|teams|startup|service|integration|api|review|reviews|customer|customers|used|use|tried|using|alternative|vs|launch|release|raises?|funding)\b/i;
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function scoreMention(text, { name, domain }) {
  if (!text) return 0;
  const t = text.toLowerCase();
  if (domain && t.includes(domain.toLowerCase())) return 1.0;
  if (!name) return 0;
  if (!new RegExp(`\\b${esc(name)}\\b`, 'i').test(text)) return 0;
  const idx = t.indexOf(name.toLowerCase());
  const win = text.slice(Math.max(0, idx - 100), idx + name.length + 100);
  return CUES.test(win) ? 0.6 : 0.4;
}
async function makeMention({ source, source_url, text = '', reviewer = null, posted_at = null, confidence = null, raw = null }) {
  return {
    id: await mentionId(source, source_url, text),
    source,
    url: source_url || null,
    reviewer,
    text: (text || '').slice(0, 2000),
    posted_at: isoToMs(posted_at),
    confidence: confidence == null ? null : Number(confidence.toFixed(2)),
    raw: raw || null,
  };
}

// ── sources ──────────────────────────────────────────────────
async function fetchHN({ name, domain }) {
  const throttle = new Throttle(800), out = [];
  for (const term of [name, domain].filter(Boolean)) {
    try {
      const data = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=(story,comment)&hitsPerPage=50`, { throttle });
      for (const hit of (data.hits || [])) {
        const text = [hit.title, hit.story_text, hit.comment_text].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        out.push(await makeMention({
          source: 'hn',
          source_url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          reviewer: hit.author || null, text, posted_at: hit.created_at, confidence: conf,
          raw: { points: hit.points, num_comments: hit.num_comments },
        }));
      }
    } catch { /* per-source non-fatal */ }
  }
  return out;
}

async function fetchReddit({ name, domain }) {
  const throttle = new Throttle(2200), out = [];
  for (const term of [name, domain].filter(Boolean)) {
    try {
      const data = await getJson(`https://www.reddit.com/search.json?q=${encodeURIComponent(`"${term}"`)}&limit=50&sort=relevance&type=link&t=year`, { throttle });
      for (const post of (data?.data?.children || [])) {
        const p = post.data;
        const text = [p.title, p.selftext].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        out.push(await makeMention({
          source: 'reddit', source_url: `https://www.reddit.com${p.permalink}`,
          reviewer: p.author || null, text, posted_at: p.created_utc, confidence: conf,
          raw: { subreddit: p.subreddit, score: p.score, num_comments: p.num_comments },
        }));
      }
    } catch { /* */ }
  }
  return out;
}

async function fetchStackOverflow({ name, domain }) {
  const throttle = new Throttle(800), out = [];
  for (const term of [name, domain].filter(Boolean)) {
    try {
      const data = await getJson(`https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=activity&q=${encodeURIComponent(term)}&site=stackoverflow&pagesize=50`, { throttle });
      for (const item of (data.items || [])) {
        const text = [item.title, item.excerpt].filter(Boolean).join('\n\n').replace(/<[^>]+>/g, ' ').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        out.push(await makeMention({
          source: 'stackoverflow', source_url: `https://stackoverflow.com/q/${item.question_id || ''}`,
          reviewer: item.owner?.display_name || null, text, posted_at: item.last_activity_date, confidence: conf,
          raw: { score: item.score, answer_count: item.answer_count, tags: item.tags },
        }));
      }
    } catch { /* */ }
  }
  return out;
}

async function fetchGitHub({ name, domain }, { githubToken } = {}) {
  const throttle = new Throttle(7000), out = [];
  const headers = githubToken ? { Authorization: `Bearer ${githubToken}` } : {};
  for (const term of [name, domain].filter(Boolean)) {
    try {
      const q = `"${term}"+in:title,body+is:issue`;
      const data = await getJson(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=30`, { headers, throttle });
      for (const item of (data.items || [])) {
        const text = [item.title, item.body].filter(Boolean).join('\n\n').trim();
        if (!text) continue;
        const conf = scoreMention(text, { name, domain });
        if (conf < 0.4) continue;
        out.push(await makeMention({
          source: 'github', source_url: item.html_url,
          reviewer: item.user?.login || null, text, posted_at: item.created_at, confidence: conf,
          raw: { state: item.state, comments: item.comments },
        }));
      }
    } catch { /* */ }
  }
  return out;
}

// DuckDuckGo keyless HTML search — web-wide reach. Hard-throttled (DDG rate-limits).
function ddgStrip(s) {
  return (s || '').replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
function ddgUnwrap(u) {
  try {
    if (u.includes('duckduckgo.com/l/') || u.startsWith('/l/')) {
      const m = u.match(/[?&]uddg=([^&]+)/); if (m) return decodeURIComponent(m[1]);
    }
    return u.startsWith('//') ? 'https:' + u : u;
  } catch { return u; }
}
function ddgParse(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = ddgUnwrap(m[1]), title = ddgStrip(m[2]), snippet = ddgStrip(m[4]);
    if (url && title) out.push({ url, title, snippet });
  }
  return out;
}
async function fetchDuckDuckGo({ name, domain }) {
  const throttle = new Throttle(3500), out = [];
  const terms = [name, domain].filter(Boolean);
  if (!terms.length) return out;
  const TEMPLATES = [(t) => `"${t}"`, (t) => `"${t}" news OR launch OR release`];
  for (const term of terms) {
    for (const tpl of TEMPLATES) {
      try {
        const html = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(tpl(term))}`, { throttle, headers: { Accept: 'text/html' } });
        for (const r of ddgParse(html)) {
          const text = [r.title, r.snippet].filter(Boolean).join(' — ');
          if (!text) continue;
          const conf = scoreMention(text, { name, domain });
          if (conf < 0.4) continue;
          out.push(await makeMention({ source: 'duckduckgo', source_url: r.url, text, confidence: conf }));
        }
      } catch { /* DDG 403/rate-limit non-fatal */ }
    }
  }
  // de-dupe same URL across query variants
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

// Direct site watch via RSS/Atom feed. Give it a target with `url` (a site
// homepage OR a direct feed URL). It finds the feed, parses the newest posts,
// and returns them as hits — confidence 1.0 (they're from the site itself).
// Falls back to nothing if the site has no discoverable feed.
function htmlDecode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? htmlDecode(m[1]) : null;
}
async function discoverFeed(siteUrl, throttle) {
  // Already a feed? (xml-ish path) — use as-is.
  if (/\.(xml|rss|atom)(\?|$)/i.test(siteUrl) || /\/(feed|rss|atom)\/?$/i.test(siteUrl)) return siteUrl;
  // Look for <link rel=alternate type=...rss/atom...> in the homepage HTML.
  try {
    const html = await getText(siteUrl, { throttle });
    const m = html.match(/<link[^>]+(?:type="application\/(?:rss|atom)\+xml"[^>]+href="([^"]+)"|href="([^"]+)"[^>]+type="application\/(?:rss|atom)\+xml")/i);
    const href = m && (m[1] || m[2]);
    if (href) return new URL(href, siteUrl).href;
  } catch { /* fall through */ }
  // Common conventional paths.
  for (const p of ['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml']) {
    try { const u = new URL(p, siteUrl).href; const r = await fetch(u, { method: 'HEAD' }); if (r.ok) return u; } catch { /* */ }
  }
  return null;
}
async function fetchFeed({ url, domain }) {
  const site = url || (domain ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}` : null);
  if (!site) return [];
  const throttle = new Throttle(500);
  const feedUrl = await discoverFeed(site, throttle);
  if (!feedUrl) return [];
  let xml;
  try { xml = await getText(feedUrl, { throttle, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, */*' } }); }
  catch { return []; }
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = (xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || []).slice(0, 25);
  for (const b of blocks) {
    const title = tag(b, 'title');
    let link = isAtom ? (b.match(/<link[^>]+href="([^"]+)"/i)?.[1] || null) : tag(b, 'link');
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const body = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const text = [title, body].filter(Boolean).join(' — ').slice(0, 2000);
    if (!text) continue;
    out.push(await makeMention({ source: 'feed', source_url: link || feedUrl, text, posted_at: date, confidence: 1.0, raw: { feed: feedUrl } }));
  }
  return out;
}

export const SOURCES = {
  hn:            { fn: fetchHN,            keyless: true,  label: 'Hacker News' },
  reddit:        { fn: fetchReddit,        keyless: true,  label: 'Reddit' },
  duckduckgo:    { fn: fetchDuckDuckGo,    keyless: true,  label: 'DuckDuckGo (web)' },
  stackoverflow: { fn: fetchStackOverflow, keyless: true,  label: 'Stack Overflow' },
  github:        { fn: fetchGitHub,        keyless: false, label: 'GitHub Issues (optional token)' },
  feed:          { fn: fetchFeed,          keyless: true,  label: 'Site RSS/Atom feed (needs target url)' },
};

// Run a target through the requested sources. Returns a flat, de-duped,
// newest-first array of normalized hits. minConfidence is a floor on the
// relevance HINT (default 0.4 = bare name match).
export async function scrape(target, { sources = Object.keys(SOURCES), minConfidence = 0.4, githubToken } = {}) {
  const picked = sources.filter((s) => SOURCES[s]);
  const all = [];
  for (const key of picked) {
    try {
      const hits = await SOURCES[key].fn({ name: target.name, domain: target.domain || null, url: target.url || null }, { githubToken });
      for (const h of hits) if ((h.confidence ?? 0) >= minConfidence) all.push(h);
    } catch { /* whole-source failure non-fatal */ }
  }
  const seen = new Set();
  return all
    .filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)))
    .sort((a, b) => (b.posted_at || 0) - (a.posted_at || 0));
}
