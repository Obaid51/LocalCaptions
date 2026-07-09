/**
 * LocalCaptions Google Meet scraper.
 *
 * Reads Google Meet's *own* live-caption DOM (no audio processing, no bot). The
 * user turns on captions (CC); Meet does the speech-to-text; we observe the
 * caption region and hand ordered rows to the transcript engine.
 *
 * Meet ships heavily-obfuscated, frequently-changing class names, so every
 * selector here is layered: a precise attempt first, then structural/heuristic
 * fallbacks that survive class renames. If capture ever breaks, the selectors in
 * SELECTORS below are the single place to update.
 *
 * Exposes pure functions (unit-tested with jsdom) plus a Scraper class that
 * wires them to a throttled MutationObserver and a polling safety-net.
 *
 * UMD: attaches `globalThis.LocalCaptionsScraper` as a content script; exports for
 * the Node test runner.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalCaptionsScraper = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SELECTORS = {
    // The captions container. The aria-label variants appear only while captions
    // are ON, which we also use as the "captions active" signal. Legacy class
    // fallbacks come last.
    region: [
      '[role="region"][aria-label="Captions"]',
      '[role="region"][aria-label="Live captions"]',
      '[role="region"][aria-label="Live caption"]',
      '.a4cQT',
    ],
    // One speaker turn (a caption block) inside the region.
    block: '.nMcdL, div[data-message-id], div[data-sender-name]',
    // Avatar image - anchors a block when class-based detection fails. Kept
    // Meet-specific (googleusercontent avatar / data-iml load marker) so it does
    // not latch onto arbitrary images.
    avatar: 'img[src*="googleusercontent"], img[data-iml]',
    // Speaker name inside a block.
    name: '.NWpY1d, .zs7s8d, [data-sender-name], [data-self-name]',
    // Caption text inside a block.
    text: '.bh44bd, .VbkSUe, .iTTPOb, .ygicle',
  };

  function norm(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  function qsa(el, sel) {
    if (!el) return [];
    try { return Array.from(el.querySelectorAll(sel)); } catch (_e) { return []; }
  }

  // Non-caption chrome that Meet renders INSIDE the captions region - most
  // notably a "jump to bottom" button (a Material icon whose ligature text reads
  // e.g. "arrow_downward"). These must never be scraped as speech.
  const ICON_SEL =
    'i.google-material-icons, i.material-icons, i.material-symbols-outlined, i.material-symbols-rounded, ' +
    '.google-material-icons, .material-icons, .material-symbols-outlined, .material-symbols-rounded';
  const CONTROL_SEL = 'button, [role="button"]';

  function safeMatches(el, sel) {
    return !!(el && el.nodeType === 1 && el.matches && el.matches(sel));
  }

  // A Material icon ligature: an icon name like "arrow_downward" - lowercase
  // words joined by underscores, never a normal spoken phrase.
  function isIconLigature(s) {
    return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(s);
  }

  // Visible text of an element with icon glyphs and button controls removed.
  function meaningfulText(el) {
    if (!el) return '';
    let s = '';
    const walk = (node) => {
      if (node.nodeType === 3) { s += node.nodeValue || ''; return; }
      if (node.nodeType !== 1) return;
      if (safeMatches(node, ICON_SEL) || safeMatches(node, CONTROL_SEL)) return;
      const ch = node.childNodes;
      for (let i = 0; i < ch.length; i++) walk(ch[i]);
    };
    walk(el);
    return norm(s);
  }

  const NOISE_RE = /^(jump to (bottom|latest|top)|arrow_downward|arrow_upward|keyboard_arrow_down|keyboard_arrow_up|more_vert|expand_more|expand_less|closed_caption)$/i;

  // Should this extracted caption text be discarded as UI noise?
  function isNoiseText(s) {
    return !s || isIconLigature(s) || NOISE_RE.test(s);
  }

  // ---- Region / captions state -------------------------------------------

  function findCaptionsRegion(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    for (const sel of SELECTORS.region) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    // Heuristic: a region whose label still reads caption-like (localized or
    // annotated variants) AND that contains Google avatar images. Requiring the
    // caption-like label prevents locking onto the participants/people panel,
    // which also shows avatars.
    for (const r of qsa(doc, '[role="region"]')) {
      const label = r.getAttribute('aria-label') || '';
      if (/caption|subtitle|transcript/i.test(label) &&
          r.querySelector('img[src*="googleusercontent"], img[data-iml]')) {
        return r;
      }
    }
    return null;
  }

  function isCaptionsActive(doc) {
    return !!findCaptionsRegion(doc);
  }

  // The toolbar button that toggles captions, for the "Turn on captions" prompt.
  function findCaptionsButton(doc) {
    doc = doc || document;
    for (const b of qsa(doc, 'button, [role="button"]')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-tooltip') || '');
      if (/caption|subtitle/i.test(label)) return b;
      const icon = b.querySelector('i.google-material-icons, i.material-icons, i.material-symbols-outlined');
      if (icon && /closed_caption/i.test(icon.textContent || '')) return b;
    }
    return null;
  }

  // Best-effort: click Meet's captions button if captions are not already on.
  function enableCaptions(doc) {
    doc = doc || document;
    if (isCaptionsActive(doc)) return true;
    const btn = findCaptionsButton(doc);
    if (btn) { btn.click(); return true; }
    return false;
  }

  // ---- Row extraction -----------------------------------------------------

  // Return the region's direct child that contains `node` (the caption block).
  function blockAncestor(node, region) {
    let el = node;
    while (el && el.parentElement && el.parentElement !== region) el = el.parentElement;
    return el && el.parentElement === region ? el : null;
  }

  function getRowElements(region) {
    if (!region) return [];

    // 1) Precise: known caption-block class / data attributes.
    const byClass = qsa(region, SELECTORS.block);
    if (byClass.length) return byClass;

    // 2) Structural: each avatar image sits inside one block (a direct child of
    //    the region). Dedupe by that direct child.
    const avatars = qsa(region, SELECTORS.avatar);
    if (avatars.length) {
      const seen = new Set();
      const out = [];
      for (const img of avatars) {
        const block = blockAncestor(img, region);
        if (block && !seen.has(block)) { seen.add(block); out.push(block); }
      }
      if (out.length) return out;
    }

    // 3) Last resort: region's direct children that carry real caption text -
    //    excluding buttons and icon-only controls (e.g. jump-to-bottom).
    return Array.from(region.children).filter((el) => {
      if (safeMatches(el, CONTROL_SEL)) return false;
      const t = meaningfulText(el);
      return t && !isNoiseText(t);
    });
  }

  // Ordered text fragments within a block: an element's own direct text plus its
  // text-bearing descendants. Captures direct text even when an element also has
  // element children (e.g. "Name says <span>hello</span>"), so no words are lost.
  function leafTexts(block) {
    const out = [];
    const walk = (el) => {
      if (safeMatches(el, ICON_SEL) || safeMatches(el, CONTROL_SEL)) return;
      let directText = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3 /* TEXT_NODE */) directText += node.nodeValue || '';
      }
      directText = norm(directText);
      const textChildren = [];
      for (const k of el.children) {
        if (norm(k.textContent)) textChildren.push(k);
      }
      if (directText) out.push(directText);
      if (textChildren.length) {
        for (const k of textChildren) walk(k);
      } else if (!directText) {
        const t = norm(el.textContent);
        if (t) out.push(t);
      }
    };
    walk(block);
    return out;
  }

  function extractSpeakerText(block) {
    if (!block) return { speaker: 'Speaker', text: '' };

    let speaker = '';
    const nameEl = block.querySelector(SELECTORS.name);
    if (nameEl) speaker = norm(nameEl.textContent);

    let text = '';
    const textEls = qsa(block, SELECTORS.text);
    if (textEls.length) text = norm(textEls.map((e) => meaningfulText(e)).join(' '));

    // Structural fallback when class-based selectors miss: the first leaf is
    // usually the name, the rest is the caption.
    if (!speaker || !text) {
      const leaves = leafTexts(block);
      if (!speaker && leaves.length) {
        // A name is short and not the whole caption.
        if (leaves.length >= 2) speaker = leaves[0];
      }
      if (!text) {
        if (speaker && leaves.length >= 2) {
          text = leaves.slice(1).join(' ');
        } else {
          // Strip a leading "Name" off the block's full text if we know it.
          const full = meaningfulText(block);
          text = speaker && full.startsWith(speaker) ? norm(full.slice(speaker.length)) : full;
        }
      }
    }

    if (!speaker) {
      const img = block.querySelector('img[alt]');
      const alt = img && norm(img.getAttribute('alt'));
      if (alt) speaker = alt;
    }

    return { speaker: norm(speaker) || 'Speaker', text: norm(text) };
  }

  /**
   * Extract ordered rows from a region.
   * @param {Element} region
   * @param {(el:Element)=>(string|number)} keyFor stable per-element key.
   */
  function extractRows(region, keyFor) {
    const rows = [];
    for (const el of getRowElements(region)) {
      const { speaker, text } = extractSpeakerText(el);
      if (isNoiseText(text)) continue; // drop UI controls / icon glyphs / empty
      rows.push({ key: keyFor(el), speaker, text });
    }
    return rows;
  }

  // ---- Live scraper -------------------------------------------------------

  class Scraper {
    constructor(opts = {}) {
      this.onRows = opts.onRows || (() => {});
      this.onCaptionsState = opts.onCaptionsState || (() => {});
      this.pollMs = opts.pollMs || 1000;
      this.doc = opts.doc || document;

      this._keys = new WeakMap();
      this._keySeq = 1;
      this._region = null;
      this._regionObs = null;
      this._docObs = null;
      this._timer = null;
      this._lastActive = null;
      this._scanScheduled = false;
      this._emitScheduled = false;
      this._scanTimer = null;
      this._emitTimer = null;
      this._stopped = false;
    }

    _keyFor(el) {
      let k = this._keys.get(el);
      if (!k) { k = this._keySeq++; this._keys.set(el, k); }
      return k;
    }

    start() {
      this._stopped = false;
      const target = this.doc.body || this.doc.documentElement;
      this._docObs = new MutationObserver(() => this._scheduleScan());
      if (target) this._docObs.observe(target, { childList: true, subtree: true });
      this._timer = setInterval(() => this._scan(), this.pollMs);
      this._scan();
    }

    stop() {
      // Mark stopped FIRST so any already-queued scheduled callback bails out
      // instead of resurrecting a region observer after teardown.
      this._stopped = true;
      if (this._timer) clearInterval(this._timer);
      if (this._scanTimer) clearTimeout(this._scanTimer);
      if (this._emitTimer) clearTimeout(this._emitTimer);
      this._scanScheduled = false;
      this._emitScheduled = false;
      if (this._docObs) this._docObs.disconnect();
      if (this._regionObs) this._regionObs.disconnect();
      this._regionObs = null;
      this._region = null;
    }

    _scheduleScan() {
      if (this._stopped || this._scanScheduled) return;
      this._scanScheduled = true;
      this._scanTimer = setTimeout(() => {
        this._scanScheduled = false;
        if (this._stopped) return;
        this._scan();
      }, 400);
    }

    _scheduleEmit() {
      if (this._stopped || this._emitScheduled) return;
      this._emitScheduled = true;
      this._emitTimer = setTimeout(() => {
        this._emitScheduled = false;
        if (this._stopped) return;
        this._emitRows();
      }, 120);
    }

    _bindRegion(region) {
      if (this._region === region) return;
      if (this._regionObs) this._regionObs.disconnect();
      this._region = region;
      if (region) {
        this._regionObs = new MutationObserver(() => this._scheduleEmit());
        this._regionObs.observe(region, { childList: true, subtree: true, characterData: true });
      }
    }

    _scan() {
      if (this._stopped) return;
      const region = findCaptionsRegion(this.doc);
      const active = !!region;
      if (active !== this._lastActive) {
        this._lastActive = active;
        try { this.onCaptionsState(active); } catch (_e) {}
      }
      this._bindRegion(region);
      // Only push rows while a region exists. Skipping the empty case avoids
      // wiping in-flight turns during transient re-renders (the elements keep
      // their WeakMap keys, so capture resumes seamlessly).
      if (region) this._emitRows();
    }

    _emitRows() {
      if (this._stopped || !this._region) return;
      const rows = extractRows(this._region, (el) => this._keyFor(el));
      try { this.onRows(rows); } catch (_e) {}
    }
  }

  return {
    SELECTORS,
    findCaptionsRegion,
    isCaptionsActive,
    findCaptionsButton,
    enableCaptions,
    getRowElements,
    extractSpeakerText,
    extractRows,
    Scraper,
  };
});
