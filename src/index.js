#!/usr/bin/env node
// osint-mcp — a tiny MCP server that watches the topics/brands you care about
// across HN, Reddit, DuckDuckGo, Stack Overflow, and GitHub, and hands the raw
// hits back. No LLM, no scoring beyond a relevance hint — your model reasons
// over the results.
//
// Tools: list_sources, list_targets, add_target, remove_target, fetch_updates.

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
];

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
const server = new Server({ name: 'osint-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
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
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${String(e?.message || e)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`[osint-mcp] ready — data dir ${DIR}`);
