#!/usr/bin/env node
// osint-mcp — a tiny MCP server that watches the topics/brands you care about
// across HN, Reddit, DuckDuckGo, Stack Overflow, and GitHub, and hands the raw
// hits back. No LLM, no scoring beyond a relevance hint — your model reasons
// over the results.
//
// Tools: list_sources, list_targets, add_target, remove_target, fetch_updates,
// hot_takes (raw signal + a keyless recipe your model runs to write hot takes).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SOURCES, scrape } from './sources.js';

// ── store: two JSON files (targets + seen ids) ───────────────
const DIR = process.env.OSINT_MCP_DIR || join(homedir(), '.osint-mcp');
mkdirSync(DIR, { recursive: true });
const TARGETS = join(DIR, 'targets.json');
const SEEN = join(DIR, 'seen.json');
const read = (f, fb) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fb; } };
const write = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2));
const getTargets = () => read(TARGETS, []);          // [{name, domain?, sources?}]
const getSeen = () => new Set(read(SEEN, []));
const saveSeen = (set) => write(SEEN, [...set].slice(-5000)); // ponytail: cap, FIFO-ish

const GH_TOKEN = process.env.GITHUB_TOKEN || null;

// ── tools ────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_sources',
    description: 'List the sources this server can search (HN, Reddit, DuckDuckGo, Stack Overflow, GitHub) and whether each needs a key.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_targets',
    description: 'List the saved targets (topics/brands you watch).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_target',
    description: 'Save a target to watch. Give a name (phrase to search, e.g. "Anthropic"), a url (a site/blog to watch directly via its RSS/Atom feed, e.g. "https://openai.com/blog"), or both. domain optional — a domain match scores highest in web search. sources optional — restrict this target to specific sources.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Search phrase. Optional if url is given.' },
        url:     { type: 'string', description: 'Site or feed URL to watch directly (RSS/Atom auto-discovered).' },
        domain:  { type: 'string' },
        sources: { type: 'array', items: { type: 'string', enum: Object.keys(SOURCES) } },
      },
    },
  },
  {
    name: 'remove_target',
    description: 'Remove a saved target by name (case-insensitive).',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'fetch_updates',
    description: 'Fetch recent mentions for a target (or all saved targets if omitted). Returns raw normalized hits — source, url, text, posted_at, confidence (a relevance hint, not a verdict). By default returns only items not seen on a previous fetch (new_only) so repeated calls surface just what is new. You decide what matters.',
    inputSchema: {
      type: 'object',
      properties: {
        target:        { type: 'string', description: 'Target name. Omit to fetch all saved targets.' },
        name:          { type: 'string', description: 'Ad-hoc search phrase (fetch without saving a target).' },
        url:           { type: 'string', description: 'Ad-hoc site/feed URL to watch directly (RSS/Atom), without saving.' },
        domain:        { type: 'string', description: 'Optional domain for the ad-hoc search.' },
        sources:       { type: 'array', items: { type: 'string', enum: Object.keys(SOURCES) }, description: 'Restrict to these sources. Default: all.' },
        since_days:    { type: 'number', description: 'Only items posted within N days (items with no date are kept). Default 14.' },
        min_confidence:{ type: 'number', description: 'Floor on the relevance hint 0..1. Default 0.4.' },
        new_only:      { type: 'boolean', description: 'Only items unseen on previous fetches. Default true.' },
        limit:         { type: 'number', description: 'Max items per target. Default 40.' },
      },
    },
  },
  {
    name: 'hot_takes',
    description: 'Fetch the latest signal for a target/phrase/url (or all saved targets) AND return a ready-to-run recipe for turning that signal into sharp HOT TAKES. This server runs no LLM: it hands YOUR model the raw hits plus the instructions, and your model writes the takes. A hot take is a bold, specific, debatable opinion that takes a side, names the thing, and would make a smart reader want to argue. Not a summary, not a tip. Use when you want angles worth publishing, not just a list of links.',
    inputSchema: {
      type: 'object',
      properties: {
        target:        { type: 'string', description: 'Saved target name. Omit to use all saved targets.' },
        name:          { type: 'string', description: 'Ad-hoc search phrase (no need to save a target).' },
        url:           { type: 'string', description: 'Ad-hoc site/feed URL to watch directly (RSS/Atom).' },
        domain:        { type: 'string' },
        sources:       { type: 'array', items: { type: 'string', enum: Object.keys(SOURCES) }, description: 'Restrict to these sources. Default: all.' },
        since_days:    { type: 'number', description: 'Only items within N days. Default 14.' },
        min_confidence:{ type: 'number', description: 'Floor on the relevance hint 0..1. Default 0.4.' },
        limit:         { type: 'number', description: 'Max items per target. Default 40.' },
      },
    },
  },
];

// The value layer, kept keyless: the server returns this recipe alongside the raw
// signal so the CALLING model writes the takes. No opinion is baked into the MCP.
const HOT_TAKE_RECIPE = `Turn the signals into a SHORT set of HOT TAKES.

A HOT TAKE is a bold, specific, debatable OPINION that takes a side and makes a smart person stop and want to argue. It NAMES the thing (a company, a claim, a consensus). It says what most people will not. It is falsifiable or genuinely provocative.
KILL anything that: hedges ("it depends"), gives a tip or how-to, just restates the news, or could be published by any brand without risk. If it is safe, cut it.

Energy to match (not the subjects, just the spice level):
- "Most AI agents shipping today are cron jobs in a trench coat."
- "Perplexity raising 200M for a browser is a confession it cannot win search."
- "AEO is a rebrand for the consultants who fumbled SEO."

Work SEVERAL angles so the set is varied, not five versions of one idea:
- CONTRARIAN: argue the opposite of what everyone agrees on.
- PREDICTION: a falsifiable call on what happens next, and who specifically loses.
- EMPEROR: call out the hype or theater the field pretends not to see.
- UNSAID: the uncomfortable truth insiders know but will not post.
- POWER MOVE: decode what a specific company move REALLY reveals (fear, retreat, land-grab) versus its press-release framing.

Generate candidates across those angles, then keep ONLY the 5-6 spiciest and most DISTINCT. Each must take a clear side. No en-dashes or em-dashes.
For each, give: take (one sharp declarative sentence), argument (2-3 sentences), why_now (the trigger), counter (the strongest argument AGAINST it, because a real hot take knows its opposition), and the source url(s) it draws on.`;

async function fetchForTarget(t, opts) {
  const sinceMs = opts.since_days != null ? Date.now() - opts.since_days * 864e5 : Date.now() - 14 * 864e5;
  const hits = await scrape(t, {
    sources: opts.sources || t.sources || Object.keys(SOURCES),
    minConfidence: opts.min_confidence ?? 0.4,
    githubToken: GH_TOKEN,
  });
  // window: keep items dated within sinceMs, plus undated ones (just-found).
  let out = hits.filter((h) => h.posted_at == null || h.posted_at >= sinceMs);
  return out.slice(0, opts.limit ?? 40);
}

async function handleFetch(args) {
  const opts = args || {};
  const newOnly = opts.new_only !== false;
  const seen = getSeen();

  let list;
  if (opts.name || opts.url) {
    let label = opts.name;
    if (!label && opts.url) { try { label = new URL(opts.url).host; } catch { label = opts.url; } }
    list = [{ name: label, domain: opts.domain || null,
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.url && !opts.name ? { sources: ['feed'] } : {}) }];
  } else if (opts.target) {
    const t = getTargets().find((x) => x.name.toLowerCase() === opts.target.toLowerCase());
    if (!t) throw new Error(`no saved target "${opts.target}". add_target first, or pass name for an ad-hoc search.`);
    list = [t];
  } else {
    list = getTargets();
    if (!list.length) throw new Error('no saved targets. add_target first, or pass name for an ad-hoc search.');
  }

  const results = [];
  for (const t of list) {
    let hits = await fetchForTarget(t, opts);
    if (newOnly) hits = hits.filter((h) => !seen.has(h.id));
    hits.forEach((h) => seen.add(h.id));
    results.push({ target: t.name, count: hits.length, hits });
  }
  if (newOnly) saveSeen(seen);
  return { new_only: newOnly, targets: results.length, results };
}

// ── server ───────────────────────────────────────────────────
const server = new Server({ name: 'osint-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
  try {
    switch (name) {
      case 'list_sources':
        return ok(Object.entries(SOURCES).map(([k, v]) => ({ source: k, label: v.label, keyless: v.keyless })));
      case 'list_targets':
        return ok(getTargets());
      case 'add_target': {
        // name OR url required; if no name, use the URL's host as the label.
        let label = args.name;
        if (!label && args.url) { try { label = new URL(args.url).host; } catch { label = args.url; } }
        if (!label) throw new Error('give a name or a url');
        const ts = getTargets().filter((t) => t.name.toLowerCase() !== label.toLowerCase());
        // url-only watch (no search phrase) defaults to feed-only — watch the
        // site itself, don't search the web for its hostname.
        const sources = args.sources || (args.url && !args.name ? ['feed'] : undefined);
        const t = { name: label, domain: args.domain || null,
          ...(args.url ? { url: args.url } : {}),
          ...(sources ? { sources } : {}) };
        ts.push(t); write(TARGETS, ts);
        return ok({ added: t, total: ts.length });
      }
      case 'remove_target': {
        const before = getTargets();
        const after = before.filter((t) => t.name.toLowerCase() !== (args.name || '').toLowerCase());
        write(TARGETS, after);
        return ok({ removed: before.length - after.length, total: after.length });
      }
      case 'fetch_updates':
        return ok(await handleFetch(args));
      case 'hot_takes': {
        // Take the freshest signal (not just unseen), then hand the model the recipe.
        const signal = await handleFetch({ ...args, new_only: false });
        return ok({
          recipe: HOT_TAKE_RECIPE,
          signals: signal,
          note: 'osint-mcp runs no LLM. Feed `signals` to your model together with `recipe` to write the hot takes.',
        });
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${String(e?.message || e)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`[osint-mcp] ready — data dir ${DIR}`);
