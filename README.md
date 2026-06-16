# osint-mcp

A tiny MCP server that watches the topics, brands, or competitors you care
about across the public web and hands back the **raw signal**. No LLM, no
opinion baked in — the relevance scoring is a hint; **your model reasons over
the results.**

Sources (all keyless except GitHub):
- **Hacker News** (Algolia)
- **Reddit** (public search)
- **DuckDuckGo** (web search, keyless HTML)
- **Stack Overflow** (StackExchange API)
- **GitHub Issues** (optional `GITHUB_TOKEN` for higher rate limits)
- **Site feed** — give a target a `url` and it watches that site directly via
  its RSS/Atom feed (auto-discovered from the homepage, or pass the feed URL).

## Install

```bash
git clone <this repo> osint-mcp && cd osint-mcp
npm install
npm test        # offline self-check
```

## Connect it

Add to your MCP client config (Claude Desktop `claude_desktop_config.json`,
or any MCP client):

```json
{
  "mcpServers": {
    "osint": {
      "command": "node",
      "args": ["/absolute/path/to/osint-mcp/src/index.js"],
      "env": {
        "GITHUB_TOKEN": "optional-ghp_xxx",
        "OSINT_MCP_DIR": "optional /custom/data/dir"
      }
    }
  }
}
```

Targets and the "already seen" set persist as JSON in `OSINT_MCP_DIR`
(default `~/.osint-mcp/`).

## Tools

| tool | what it does |
|------|--------------|
| `list_sources` | the sources it can search + which need a key |
| `add_target` | save a watch: `{ name, domain?, sources? }` |
| `list_targets` | your saved watches |
| `remove_target` | drop one by name |
| `fetch_updates` | pull recent hits for one target, all targets, or an ad-hoc `name`. Returns `{ source, url, text, posted_at, confidence }`. `new_only` (default true) returns only items unseen on prior fetches, so repeat calls surface just what's new. |

### Typical flow

```
add_target { "name": "Anthropic", "domain": "anthropic.com" }   # watch the web
add_target { "name": "answer engine optimization" }
add_target { "url": "https://openai.com/blog" }                 # watch a site's feed
fetch_updates { "since_days": 7 }
```

The model then reads the hits and decides what's worth your attention.

"Watch a site for new posts" = give a `url`. It defaults to feed-only (won't
also search the web for the hostname). Repeat `fetch_updates` calls return only
posts you haven't seen. The MCP doesn't push on its own — call it on a schedule
(cron / a daily agent run) to get "tell me when new comes in."

`confidence` is a coarse hint: `1.0` domain match, `0.6` name + a product/news
cue nearby, `0.4` bare name match. Filter with `min_confidence` if you want.

## Notes

- Each source is throttled and fails soft — one flaky API won't sink a fetch.
- DuckDuckGo rate-limits aggressively; it's hard-throttled and may return
  little on bursts. HN is the most reliable.
- This is intentionally dumb: it fetches and de-dupes. No ranking model, no
  summarization. That's the client's job.

MIT.
