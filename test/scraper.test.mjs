import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadUMD } from './helpers.mjs';

const S = loadUMD('src/content/meet-scraper.js');

function dom(html) {
  return new JSDOM(`<!DOCTYPE html><body>${html}</body>`).window.document;
}

const AVATAR = 'https://lh3.googleusercontent.com/a/default-user';

test('findCaptionsRegion: aria-label (captions on)', () => {
  const doc = dom(`<div role="region" aria-label="Captions"><span>x</span></div>`);
  assert.ok(S.findCaptionsRegion(doc));
  assert.equal(S.isCaptionsActive(doc), true);
});

test('findCaptionsRegion: none when captions off', () => {
  const doc = dom(`<div>no captions here</div>`);
  assert.equal(S.findCaptionsRegion(doc), null);
  assert.equal(S.isCaptionsActive(doc), false);
});

test('findCaptionsRegion: legacy class + avatar heuristic fallback', () => {
  const legacy = dom(`<div class="a4cQT"></div>`);
  assert.ok(S.findCaptionsRegion(legacy), 'matches .a4cQT');

  // Heuristic now requires a caption-like label (plus an avatar) so it can't
  // latch onto the participants panel.
  const heuristic = dom(`<div role="region" aria-label="Captions (English)"><img src="${AVATAR}"></div>`);
  assert.ok(S.findCaptionsRegion(heuristic), 'matches caption-like labelled region with avatar');
});

test('getRowElements + extractSpeakerText: class-based (precise) path', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d">Alice</div><div class="bh44bd">Hello everyone</div></div>
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d">Bob</div><div class="bh44bd">Hi Alice</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.getRowElements(region);
  assert.equal(rows.length, 2);

  const a = S.extractSpeakerText(rows[0]);
  assert.deepEqual(a, { speaker: 'Alice', text: 'Hello everyone' });
  const b = S.extractSpeakerText(rows[1]);
  assert.deepEqual(b, { speaker: 'Bob', text: 'Hi Alice' });
});

test('extractSpeakerText: structural fallback when classes are unknown', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="mystery">
        <img src="${AVATAR}">
        <div><span>Carol</span></div>
        <div><span>How are you doing today</span></div>
      </div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.getRowElements(region);
  assert.equal(rows.length, 1, 'avatar-anchored to the region direct child');
  const { speaker, text } = S.extractSpeakerText(rows[0]);
  assert.equal(speaker, 'Carol');
  assert.equal(text, 'How are you doing today');
});

test('extractRows applies a keyer and preserves order', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="nMcdL" data-k="k1"><img src="${AVATAR}"><div class="NWpY1d">A</div><div class="bh44bd">one</div></div>
      <div class="nMcdL" data-k="k2"><img src="${AVATAR}"><div class="NWpY1d">B</div><div class="bh44bd">two</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.extractRows(region, (el) => el.getAttribute('data-k'));
  assert.deepEqual(rows, [
    { key: 'k1', speaker: 'A', text: 'one' },
    { key: 'k2', speaker: 'B', text: 'two' },
  ]);
});

test('Scraper assigns stable keys to the same elements across scans', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d">A</div><div class="bh44bd">hi</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  let captured = [];
  const scraper = new S.Scraper({ doc, onRows: (r) => { captured = r; } });
  scraper._region = region;

  scraper._emitRows();
  const first = captured.map((r) => r.key);
  scraper._emitRows();
  const second = captured.map((r) => r.key);
  assert.deepEqual(first, second, 'same DOM elements keep their keys');
  assert.equal(captured[0].speaker, 'A');
});

function keyer() {
  const keys = new WeakMap();
  let seq = 1;
  return (el) => { let k = keys.get(el); if (!k) { k = seq++; keys.set(el, k); } return k; };
}

test('Meet "jump to bottom" control inside the region is not scraped as a caption', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <button aria-label="Jump to bottom"><i class="google-material-icons">arrow_downward</i></button>
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d">Alice</div><div class="bh44bd">Hello there team</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.extractRows(region, keyer());
  assert.equal(rows.length, 1, 'only the real caption is a row');
  assert.deepEqual(rows[0].speaker, 'Alice');
  assert.equal(rows[0].text, 'Hello there team');
});

test('jump-to-bottom control excluded even via the fallback row strategy', () => {
  // No .nMcdL class and no googleusercontent avatar -> forces strategy 3.
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="jump"><i class="google-material-icons">arrow_downward</i></div>
      <div class="jumplabel">Jump to bottom</div>
      <div class="capline"><span class="who">Bob</span><span class="say">can everyone hear me</span></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.extractRows(region, keyer());
  assert.equal(rows.length, 1, 'icon control + label are filtered, caption survives');
  assert.equal(rows[0].text, 'can everyone hear me');
});

test('a row whose text is only an icon ligature is dropped', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d"></div><div class="bh44bd">arrow_downward</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  const rows = S.extractRows(region, keyer());
  assert.equal(rows.length, 0, 'ligature-only text is not a caption');
});

test('stop() prevents further emission or observer resurrection', () => {
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div class="nMcdL"><img src="${AVATAR}"><div class="NWpY1d">A</div><div class="bh44bd">hi</div></div>
    </div>`);
  const region = S.findCaptionsRegion(doc);
  let calls = 0;
  const scraper = new S.Scraper({ doc, onRows: () => { calls++; } });
  scraper._region = region;
  scraper.stop();

  // Simulate leftover work firing after teardown - all must be inert.
  scraper._scan();
  scraper._emitRows();
  scraper._scheduleScan();
  scraper._scheduleEmit();

  assert.equal(calls, 0, 'no rows emitted after stop()');
  assert.equal(scraper._regionObs, null, 'no region observer resurrected');
  assert.equal(scraper._region, null);
});

test('avatar-only region without a caption-like label is NOT treated as captions', () => {
  // e.g. the participants/people panel, which also shows avatars.
  const doc = dom(`<div role="region" aria-label="Participants"><img src="${AVATAR}"></div>`);
  assert.equal(S.findCaptionsRegion(doc), null);
  assert.equal(S.isCaptionsActive(doc), false);
});

test('findCaptionsButton / enableCaptions', () => {
  const off = dom(`<button aria-label="Turn on captions (c)">CC</button>`);
  const btn = S.findCaptionsButton(off);
  assert.ok(btn);
  let clicked = false;
  btn.addEventListener('click', () => { clicked = true; });
  assert.equal(S.enableCaptions(off), true);
  assert.equal(clicked, true, 'clicks the captions button when captions are off');

  const on = dom(`<div role="region" aria-label="Captions"></div><button aria-label="Turn off captions (c)"></button>`);
  assert.equal(S.enableCaptions(on), true, 'already-on returns true without needing a click');
});
