import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUMD } from './helpers.mjs';

const { TranscriptEngine, normalize, isContinuation } = loadUMD('src/content/transcript-engine.js');

function collect(engine) {
  const updates = [], persists = [];
  engine.on('update', (t) => updates.push({ ...t }));
  engine.on('persist', (t) => persists.push({ ...t }));
  return { updates, persists };
}

test('normalize collapses whitespace', () => {
  assert.equal(normalize('  hello   world \n'), 'hello world');
  assert.equal(normalize(null), '');
});

test('isContinuation: equal or prefix-extension only', () => {
  assert.equal(isContinuation('I think', 'I think we'), true);
  assert.equal(isContinuation('I think', 'I think'), true);
  assert.equal(isContinuation('I think', 'I thou'), false);
  assert.equal(isContinuation('I think we', 'I think'), false); // shrink is not a continuation
  assert.equal(isContinuation('', 'anything'), false);
});

test('growing text updates one turn; stabilizes to a single persist', () => {
  const e = new TranscriptEngine({ stabilityMs: 1000, mergeWindowMs: 2000 });
  const { updates, persists } = collect(e);

  e.ingest([{ key: 'a', speaker: 'Alice', text: 'Hello' }], 0);
  e.ingest([{ key: 'a', speaker: 'Alice', text: 'Hello there' }], 100);
  e.ingest([{ key: 'a', speaker: 'Alice', text: 'Hello there team' }], 200);
  assert.equal(persists.length, 0, 'not yet stable');

  // Same text, 1000ms after last change -> stable -> persist once.
  e.ingest([{ key: 'a', speaker: 'Alice', text: 'Hello there team' }], 1200);
  assert.equal(persists.length, 1);
  assert.deepEqual({ id: persists[0].id, text: persists[0].text }, { id: 1, text: 'Hello there team' });

  // Still stable, unchanged -> no duplicate persist.
  e.ingest([{ key: 'a', speaker: 'Alice', text: 'Hello there team' }], 3000);
  assert.equal(persists.length, 1);

  assert.ok(updates.length >= 3);
  assert.ok(updates.every((u) => u.id === 1), 'all updates target one turn id');
});

test('a removed row is persisted with its final text', () => {
  const e = new TranscriptEngine({ stabilityMs: 9999 });
  const { persists } = collect(e);
  e.ingest([{ key: 'a', speaker: 'Bob', text: 'quick note' }], 0);
  e.ingest([], 50); // scrolled off screen
  assert.equal(persists.length, 1);
  assert.equal(persists[0].text, 'quick note');
});

test('element replacement mid-sentence keeps ONE turn (no duplicate line)', () => {
  const e = new TranscriptEngine({ stabilityMs: 1000, mergeWindowMs: 2000 });
  const { updates, persists } = collect(e);

  // Meet renders "I think we" then swaps the DOM node for a fresh one that
  // continues the same utterance ("I think we should ship").
  e.ingest([{ key: 'n1', speaker: 'Sam', text: 'I think we' }], 0);
  e.ingest([{ key: 'n2', speaker: 'Sam', text: 'I think we should ship' }], 100);
  e.ingest([{ key: 'n2', speaker: 'Sam', text: 'I think we should ship it' }], 300);
  e.ingest([{ key: 'n2', speaker: 'Sam', text: 'I think we should ship it' }], 1500);

  // Everything must live under a single turn id.
  assert.ok(updates.every((u) => u.id === 1), 'updates stay on id 1');
  assert.ok(persists.every((p) => p.id === 1), 'persists stay on id 1');
  // Final persisted text is the fullest version.
  assert.equal(persists.at(-1).text, 'I think we should ship it');
});

test('element replacement cannot hand one id to two concurrent rows (no lost line)', () => {
  const e = new TranscriptEngine({ stabilityMs: 1000, mergeWindowMs: 4000 });
  const { persists } = collect(e);
  e.ingest([{ key: 1, speaker: 'A', text: 'ok' }], 0);
  // Same batch: old row removed AND two fresh same-speaker rows appear.
  e.ingest([
    { key: 2, speaker: 'A', text: 'ok good' },
    { key: 3, speaker: 'A', text: 'ok great' },
  ], 800);
  e.flush(900);
  const finalById = new Map(persists.map((p) => [p.id, p.text]));
  assert.ok(finalById.size >= 2, 'concurrent rows keep distinct ids');
  const texts = [...finalById.values()];
  assert.ok(texts.includes('ok great'), '"ok great" is not lost to an id collision');
});

test('merge eligibility requires a same-batch replacement (not just any removal)', () => {
  // "Yes" ends, captions clear, THEN a prefixed utterance arrives later - new turn.
  const e = new TranscriptEngine({ stabilityMs: 500, mergeWindowMs: 4000 });
  const { persists } = collect(e);
  e.ingest([{ key: 1, speaker: 'A', text: 'ok' }], 0);
  e.ingest([], 100);                                      // cleared, no same-batch replacement
  e.ingest([{ key: 2, speaker: 'A', text: 'ok then lets go' }], 200); // prefixed but separate
  e.flush(300);
  const ids = new Set(persists.map((p) => p.id));
  assert.equal(ids.size, 2, 'no merge across an empty-caption gap');
});

test('same speaker, unrelated text after a gap = a new turn', () => {
  const e = new TranscriptEngine({ stabilityMs: 500, mergeWindowMs: 2000 });
  const { persists } = collect(e);
  e.ingest([{ key: 'x', speaker: 'Cara', text: 'Yes' }], 0);
  e.ingest([], 100); // finalize "Yes"
  e.ingest([{ key: 'y', speaker: 'Cara', text: 'No, wait' }], 150); // not a continuation
  e.ingest([], 300); // finalize "No, wait"
  const ids = [...new Set(persists.map((p) => p.id))];
  assert.equal(ids.length, 2, 'two distinct turns');
});

test('a same-speaker row that shares a prefix while the first is STILL visible is a new turn', () => {
  // Guards against merging into a turn that has not left the screen.
  const e = new TranscriptEngine({ stabilityMs: 100, mergeWindowMs: 2000 });
  const { persists } = collect(e);
  e.ingest([{ key: 'b1', speaker: 'A', text: 'Okay' }], 0);
  e.ingest([{ key: 'b1', speaker: 'A', text: 'Okay' }], 200);          // b1 stabilizes, still visible
  e.ingest([
    { key: 'b1', speaker: 'A', text: 'Okay' },
    { key: 'b2', speaker: 'A', text: 'Okay so' },                       // second utterance appears
  ], 250);
  e.flush(400);
  const ids = [...new Set(persists.map((p) => p.id))];
  assert.equal(ids.length, 2, 'the still-visible turn is not merged into');
});

test('concurrent speakers get distinct turns', () => {
  const e = new TranscriptEngine({ stabilityMs: 1000 });
  const { updates } = collect(e);
  e.ingest([
    { key: 'a', speaker: 'A', text: 'hi' },
    { key: 'b', speaker: 'B', text: 'yo' },
  ], 0);
  const byId = new Map(updates.map((u) => [u.id, u.speaker]));
  assert.equal(byId.size, 2);
  assert.deepEqual([...byId.values()].sort(), ['A', 'B']);
});

test('flush persists everything in flight and clears state', () => {
  const e = new TranscriptEngine({ stabilityMs: 9999 });
  const { persists } = collect(e);
  e.ingest([{ key: 'a', speaker: 'A', text: 'hey' }], 0);
  assert.equal(persists.length, 0);
  e.flush(10);
  assert.equal(persists.length, 1);
  assert.equal(persists[0].text, 'hey');
  assert.equal(e.snapshot().length, 0);
});

test('empty / whitespace-only rows are ignored', () => {
  const e = new TranscriptEngine();
  const { updates } = collect(e);
  e.ingest([{ key: 'a', speaker: 'A', text: '   ' }], 0);
  e.ingest([{ key: 'b', speaker: 'B', text: '' }], 0);
  assert.equal(updates.length, 0);
});

test('reset clears turns and restarts ids', () => {
  const e = new TranscriptEngine({ stabilityMs: 100 });
  e.ingest([{ key: 'a', speaker: 'A', text: 'one' }], 0);
  e.reset();
  const { updates } = collect(e);
  e.ingest([{ key: 'a', speaker: 'A', text: 'two' }], 0);
  assert.equal(updates[0].id, 1, 'ids restart from 1 after reset');
});
