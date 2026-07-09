/**
 * LocalCaptions transcript engine - pure, DOM-agnostic, and unit-testable.
 *
 * Google Meet renders live captions that mutate constantly: a single utterance
 * grows word-by-word, gets re-corrected ("mic, so" -> "microphones only"), and
 * the DOM row that holds it can be recycled/replaced mid-sentence. Naively
 * appending every caption change produces garbage transcripts.
 *
 * This engine consumes ordered snapshots of the *currently visible* caption rows
 * and emits two kinds of events:
 *   - "update"  : a turn's live text changed (drive the real-time panel)
 *   - "persist" : a turn has settled to a stable value (write it to storage)
 *
 * A "turn" is one continuous thing one speaker said. Each turn has a stable,
 * monotonic `id`, so both the UI and storage can upsert-by-id: no matter how many
 * times the underlying text is corrected, there is exactly one line per turn.
 *
 * The engine is transport-agnostic. In the extension the DOM layer assigns each
 * caption row a stable `key` (via a WeakMap on the element); tests pass synthetic
 * keys. That keeps all the tricky logic here, fully testable in Node.
 *
 * UMD wrapper: loads as a content script (attaches `globalThis.LocalCaptionsEngine`)
 * and as a CommonJS/ESM-interop module for the test runner.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalCaptionsEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = {
    // A visible turn whose text has not changed for this long is treated as
    // settled and persisted (even though it is still on screen).
    stabilityMs: 2500,
    // When a caption row is replaced by a fresh element mid-utterance, Meet shows
    // the same-or-extended text under a brand new DOM node. If a new turn from the
    // same speaker appears within this window and its text extends the previous
    // turn's text, we treat it as a continuation (reuse the id) instead of a
    // duplicate line.
    mergeWindowMs: 4000,
  };

  function normalize(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  // Is `next` a continuation of `prev`? (equal, or prev is a prefix of next).
  // Used to collapse element-replacement duplicates without merging genuinely
  // separate sentences that merely happen to share a leading word.
  function isContinuation(prev, next) {
    if (!prev) return false;
    if (prev === next) return true;
    return next.length > prev.length && next.slice(0, prev.length) === prev;
  }

  class TranscriptEngine {
    constructor(options = {}) {
      this.opts = Object.assign({}, DEFAULTS, options);
      this._turns = new Map();        // key -> live turn state
      this._lastBySpeaker = new Map(); // speaker -> { id, text, at } for merge detection
      this._nextId = 1;
      this._handlers = { update: [], persist: [] };
    }

    on(event, fn) {
      if (this._handlers[event]) this._handlers[event].push(fn);
      return this;
    }

    _emit(event, turn) {
      const list = this._handlers[event];
      if (!list) return;
      const view = this._view(turn);
      for (const fn of list) {
        try { fn(view); } catch (_e) { /* isolate handler failures */ }
      }
    }

    _view(t) {
      return {
        id: t.id,
        speaker: t.speaker,
        text: t.text,
        startedAt: t.startedAt,
        updatedAt: t.updatedAt,
      };
    }

    /**
     * Feed the set of caption rows currently visible on screen.
     * @param {Array<{key:(string|number), speaker:string, text:string}>} rows
     *        ordered oldest -> newest as they appear in the caption box.
     * @param {number} now epoch milliseconds (injected so the engine stays pure).
     */
    ingest(rows, now) {
      now = Number(now) || 0;
      rows = Array.isArray(rows) ? rows : [];

      const present = new Set();
      const newSpeakers = new Set(); // speakers introducing an unseen row this batch
      for (const r of rows) {
        if (!r || r.key == null || !normalize(r.text)) continue;
        present.add(r.key);
        if (!this._turns.has(r.key)) newSpeakers.add(normalize(r.speaker) || 'Speaker');
      }

      // 1) Settle + drop any tracked turn that is no longer on screen. Done first
      //    so that `_lastBySpeaker` is fresh when we evaluate new rows below -
      //    an element-replacement removes the old row and adds the new one in the
      //    same mutation batch, and we want the new one to see the just-settled turn.
      for (const key of Array.from(this._turns.keys())) {
        if (present.has(key)) continue;
        const t = this._turns.get(key);
        // A turn is merge-eligible only if the SAME speaker also introduced a
        // fresh row in this very batch - i.e. Meet swapped the DOM node
        // mid-utterance (element replacement), not "the turn simply ended".
        this._settle(t, now, newSpeakers.has(t.speaker));
        this._turns.delete(key);
      }

      // 2) Apply the visible rows: create, merge-continue, or update.
      for (const r of rows) {
        if (!r || r.key == null) continue;
        const speaker = normalize(r.speaker) || 'Speaker';
        const text = normalize(r.text);
        if (!text) continue;

        let t = this._turns.get(r.key);
        if (t) {
          if (t.text !== text || t.speaker !== speaker) {
            t.text = text;
            t.speaker = speaker;
            t.updatedAt = now;
            t.lastChanged = now;
            this._emit('update', t);
          }
          continue;
        }

        // New row for a key we have not seen. Is it a continuation of the same
        // speaker's just-ended turn (DOM row was recycled mid-sentence)? Only
        // merge when the previous turn actually LEFT the screen (`eligible`);
        // never merge into a turn that is still visible - that would be two
        // separate utterances that merely share a leading word.
        const last = this._lastBySpeaker.get(speaker);
        const isMerge =
          last &&
          last.eligible &&
          now - last.at <= this.opts.mergeWindowMs &&
          isContinuation(last.text, text);
        // A merge is a one-shot claim on the ended turn's id: consume it so a
        // second concurrent row for this speaker cannot grab the same id.
        if (isMerge) last.eligible = false;

        t = {
          id: isMerge ? last.id : this._nextId++,
          key: r.key,
          speaker,
          text,
          startedAt: isMerge ? last.startedAt : now,
          updatedAt: now,
          lastChanged: now,
          // Reusing an id: force a re-persist so storage gets the extended text.
          persistedText: null,
        };
        this._turns.set(r.key, t);
        this._emit('update', t);
      }

      // 3) Persist turns that have gone quiet while still on screen. These stay
      //    visible, so they are NOT merge-eligible.
      for (const t of this._turns.values()) {
        if (now - t.lastChanged >= this.opts.stabilityMs) {
          this._settle(t, now, false);
        }
      }
    }

    // Persist a turn if its current text differs from what was last written, and
    // record it as this speaker's most recent turn for merge detection.
    // `eligible` marks the turn as continuable - set only for element-replacement
    // removals (same-speaker row reintroduced in the same batch).
    _settle(t, now, eligible) {
      if (t.persistedText !== t.text) {
        t.persistedText = t.text;
        this._emit('persist', t);
      }
      this._lastBySpeaker.set(t.speaker, {
        id: t.id,
        text: t.text,
        startedAt: t.startedAt,
        at: now,
        eligible: !!eligible,
      });
    }

    /** Persist everything still in flight - call on meeting end / page hide. */
    flush(now) {
      now = Number(now) || 0;
      for (const key of Array.from(this._turns.keys())) {
        const t = this._turns.get(key);
        this._settle(t, now, false);
        this._turns.delete(key);
      }
    }

    /** In-flight turns, ordered by first appearance (for a live snapshot). */
    snapshot() {
      return Array.from(this._turns.values())
        .sort((a, b) => a.id - b.id)
        .map((t) => this._view(t));
    }

    /** Reset all state (new meeting). */
    reset() {
      this._turns.clear();
      this._lastBySpeaker.clear();
      this._nextId = 1;
    }
  }

  return { TranscriptEngine, normalize, isContinuation };
});
