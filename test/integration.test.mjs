import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadUMD } from './helpers.mjs';

// End-to-end: the REAL meet-scraper feeds the REAL transcript-engine against a
// scripted Google-Meet-like caption DOM that mutates over time (growth,
// self-correction, element replacement, a second speaker, scroll-off, and a new
// utterance). The committed transcript must be clean, merged, and lossless.
const S = loadUMD('src/content/meet-scraper.js');
const { TranscriptEngine } = loadUMD('src/content/transcript-engine.js');

test('scraper + engine produce a clean, merged, duplicate-free transcript', () => {
  const doc = new JSDOM(
    `<!DOCTYPE html><body><div role="region" aria-label="Captions" id="cap"></div></body>`
  ).window.document;
  const region = doc.getElementById('cap');
  const AV = 'https://lh3.googleusercontent.com/a/u';

  const makeBlock = (speaker, text) => {
    const b = doc.createElement('div');
    b.className = 'nMcdL';
    b.innerHTML = `<img src="${AV}"><div class="NWpY1d">${speaker}</div><div class="bh44bd">${text}</div>`;
    return b;
  };
  const setText = (block, text) => { block.querySelector('.bh44bd').textContent = text; };

  const keys = new WeakMap();
  let seq = 1;
  const keyFor = (el) => { let k = keys.get(el); if (!k) { k = seq++; keys.set(el, k); } return k; };

  const engine = new TranscriptEngine({ stabilityMs: 2500, mergeWindowMs: 4000 });
  const persisted = new Map();
  engine.on('persist', (t) => persisted.set(t.id, { speaker: t.speaker, text: t.text }));

  let now = 0;
  const tick = (ms) => { now += ms; engine.ingest(S.extractRows(region, keyFor), now); };

  // Alice grows and self-corrects, then pauses.
  const a = makeBlock('Alice', 'Hey');
  region.appendChild(a); tick(300);
  setText(a, 'Hey everyone'); tick(400);
  setText(a, 'Hey everyone thanks for'); tick(400);
  setText(a, 'Hey everyone thanks for joining'); tick(400);
  tick(3000);

  // Meet swaps Alice's node while she keeps talking (element replacement).
  const a2 = makeBlock('Alice', 'Hey everyone thanks for joining today');
  region.replaceChild(a2, a); tick(200);
  setText(a2, 'Hey everyone thanks for joining today lets begin'); tick(400);
  tick(3000);

  // Bob speaks (Alice's block still visible).
  const b = makeBlock('Bob', 'Sure');
  region.appendChild(b); tick(300);
  setText(b, 'Sure sounds good'); tick(400);
  tick(3000);

  // Old block scrolls off.
  region.removeChild(a2); tick(200);

  // Alice speaks again - a genuinely new, unrelated utterance.
  const a3 = makeBlock('Alice', 'One more thing');
  region.appendChild(a3); tick(300);
  setText(a3, 'One more thing before we wrap'); tick(400);

  engine.flush(now + 100);

  const lines = [...persisted.values()].map((v) => v.text);
  assert.equal(persisted.size, 3, 'three clean turns');
  assert.ok(
    lines.includes('Hey everyone thanks for joining today lets begin'),
    'Alice turn 1 fully merged across the element replacement'
  );
  assert.ok(lines.includes('Sure sounds good'), 'Bob turn captured in full');
  assert.ok(lines.includes('One more thing before we wrap'), 'Alice turn 2 captured in full');
  assert.equal(
    lines.filter((x) => x.startsWith('Hey everyone')).length, 1,
    'no duplicate of the merged utterance'
  );
});
