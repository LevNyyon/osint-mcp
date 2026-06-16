// ponytail self-check: pure logic only (no network). Fails loudly if the
// relevance scoring or dedupe regresses.
import assert from 'node:assert';
import { scoreMention, scrape, SOURCES } from './src/sources.js';

// scoreMention: domain hit > name+cue > bare name > miss
assert.equal(scoreMention('we use anthropic.com daily', { name: 'Anthropic', domain: 'anthropic.com' }), 1.0);
assert.equal(scoreMention('Anthropic launched a new product', { name: 'Anthropic' }), 0.6);
assert.equal(scoreMention('Anthropic is a Greek word', { name: 'Anthropic' }), 0.4);
assert.equal(scoreMention('totally unrelated text', { name: 'Anthropic' }), 0);
assert.equal(scoreMention('antarctica is cold', { name: 'Anthropic' }), 0, 'must be whole-word');

// sources registry shape
assert.ok(SOURCES.hn && SOURCES.duckduckgo && SOURCES.github);
assert.equal(SOURCES.github.keyless, false);

// scrape with an empty source list returns nothing (no network touched)
const none = await scrape({ name: 'x' }, { sources: [] });
assert.deepEqual(none, []);

console.log('ok — scoring + registry + empty-scrape checks pass');
