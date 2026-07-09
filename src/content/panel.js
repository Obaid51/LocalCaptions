/**
 * LocalCaptions in-page panel - the real-time transcript overlay.
 *
 * Rendered inside a Shadow DOM so Google Meet's CSS cannot leak in (and ours
 * cannot leak out). Driven entirely by content.js through a small imperative API
 * (upsertTurn/setCaptionsActive/setStatus/...). Keeps its own copy of turns so
 * copy/download/search work without touching storage.
 *
 * UMD: attaches `globalThis.LocalCaptionsPanel`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalCaptionsPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOST_ID = 'localcaptions-host';

  const STYLE = `
    :host { all: initial; }
    :host([hidden]) { display: none !important; }
    * { box-sizing: border-box; }
    .lc-panel {
      display: flex; flex-direction: column;
      width: 360px; min-width: 280px; max-width: 92vw;
      height: 460px; min-height: 180px; max-height: 82vh;
      resize: both; overflow: hidden;
      font-family: 'Google Sans', Roboto, system-ui, -apple-system, sans-serif;
      color: #e8eaed; background: rgba(24,26,31,0.97);
      border: 1px solid rgba(255,255,255,0.10); border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      backdrop-filter: blur(6px);
    }
    .lc-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 10px 10px 12px; cursor: grab; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .lc-head:active { cursor: grabbing; }
    .lc-dot {
      width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
      background: #5f6368;
    }
    .lc-dot.rec { background: #ea4335; box-shadow: 0 0 0 0 rgba(234,67,53,0.6); animation: mspulse 1.8s infinite; }
    @keyframes mspulse { 0%{box-shadow:0 0 0 0 rgba(234,67,53,0.55);} 70%{box-shadow:0 0 0 7px rgba(234,67,53,0);} 100%{box-shadow:0 0 0 0 rgba(234,67,53,0);} }
    .lc-title {
      flex: 1 1 auto; font-size: 13px; font-weight: 600; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; letter-spacing: .2px;
    }
    .lc-brand { font-size: 10px; opacity: .5; font-weight: 700; letter-spacing: .6px; }
    .lc-actions { display: flex; gap: 2px; flex: 0 0 auto; }
    .lc-btn {
      all: unset; cursor: pointer; width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      color: #bdc1c6; font-size: 15px; line-height: 1;
    }
    .lc-btn:hover { background: rgba(255,255,255,0.10); color: #fff; }
    .lc-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .lc-searchbar { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .lc-searchbar input {
      all: unset; width: 100%; box-sizing: border-box; padding: 7px 10px;
      background: rgba(255,255,255,0.07); border-radius: 8px; color: #e8eaed; font-size: 13px;
    }
    .lc-searchbar input::placeholder { color: #9aa0a6; }
    .lc-prompt {
      margin: 10px; padding: 12px; border-radius: 10px; font-size: 12.5px; line-height: 1.5;
      background: rgba(66,133,244,0.12); border: 1px solid rgba(66,133,244,0.35); color: #d2e3fc;
    }
    .lc-prompt button {
      all: unset; cursor: pointer; margin-top: 8px; display: inline-block;
      padding: 6px 12px; border-radius: 8px; background: #1a73e8; color: #fff; font-size: 12px; font-weight: 600;
    }
    .lc-prompt button:hover { background: #2b7de9; }
    .lc-body { position: relative; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; }
    .lc-body::-webkit-scrollbar { width: 9px; }
    .lc-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 6px; }
    .lc-lines { list-style: none; margin: 0; padding: 6px 10px 12px; }
    .lc-empty { padding: 24px 14px; text-align: center; color: #9aa0a6; font-size: 12.5px; line-height: 1.6; }
    .lc-line { padding: 6px 4px; border-radius: 8px; }
    .lc-line:hover { background: rgba(255,255,255,0.05); }
    .lc-line[hidden] { display: none; }
    .lc-line-head { display: flex; align-items: baseline; gap: 7px; }
    .lc-spk { font-size: 12px; font-weight: 700; white-space: nowrap; }
    .lc-ts { font-size: 10.5px; color: #80868b; flex: 0 0 auto; }
    .lc-line-copy {
      all: unset; cursor: pointer; margin-left: auto; opacity: 0; color: #9aa0a6;
      font-size: 12px; padding: 1px 5px; border-radius: 6px; flex: 0 0 auto;
    }
    .lc-line:hover .lc-line-copy { opacity: 1; }
    .lc-line-copy:hover { background: rgba(255,255,255,0.12); color: #fff; }
    .lc-line-copy.done { color: #81c995; opacity: 1; }
    .lc-line-text {
      font-size: 13.5px; line-height: 1.5; color: #e8eaed; margin-top: 1px;
      white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
    }
    .lc-jump {
      all: unset; cursor: pointer; position: sticky; bottom: 8px; left: 50%;
      transform: translateX(-50%); display: block; width: fit-content;
      padding: 5px 12px; border-radius: 20px; background: #1a73e8; color: #fff;
      font-size: 11.5px; font-weight: 600; box-shadow: 0 3px 10px rgba(0,0,0,0.4);
    }
    .lc-foot {
      display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 11px;
      color: #9aa0a6; border-top: 1px solid rgba(255,255,255,0.08);
    }
    .lc-status { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    [hidden] { display: none !important; }

    /* Minimized pill */
    .lc-pill {
      all: initial; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
      font-family: 'Google Sans', Roboto, system-ui, sans-serif;
      padding: 9px 14px; border-radius: 22px; color: #fff;
      background: linear-gradient(135deg,#1a73e8,#174ea6);
      box-shadow: 0 6px 18px rgba(0,0,0,0.45); font-size: 12.5px; font-weight: 600;
      user-select: none;
    }
    .lc-pill .lc-dot { width: 8px; height: 8px; }
  `;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function hueFor(name) {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function speakerColor(name) {
    return `hsl(${hueFor(name)}, 70%, 72%)`;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function clockHM(ms) {
    const d = new Date(ms || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function clockHMS(ms) {
    const d = new Date(ms || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // Inline SVG icons keep the panel self-contained (no web-accessible assets).
  const ICON = {
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (_e2) { return false; }
    }
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function safeName(s) {
    return String(s || 'meeting').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
  }

  class Panel {
    constructor(opts = {}) {
      this.onEnableCaptions = opts.onEnableCaptions || (() => {});
      this.onOpenHistory = opts.onOpenHistory || (() => {});
      this.turns = new Map();     // id -> { speaker, text, startedAt }
      this.filter = '';
      this.title = 'Google Meet';
      this._collapsed = false;
      this._host = null;
      this._root = null;
    }

    mount() {
      if (this._host) return;
      const host = document.createElement('div');
      host.id = HOST_ID;
      // Inline fallback for the host anchor (in case the content CSS is blocked).
      host.style.cssText = 'position:fixed;top:88px;right:16px;z-index:2147483000;width:max-content;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${STYLE}</style>
        <div class="lc-panel" part="panel">
          <div class="lc-head">
            <span class="lc-dot" data-el="dot"></span>
            <span class="lc-title" data-el="title">Google Meet</span>
            <span class="lc-brand">LocalCaptions</span>
            <div class="lc-actions">
              <button class="lc-btn" data-act="search" title="Search transcript">${ICON.search}</button>
              <button class="lc-btn" data-act="copy" title="Copy full transcript">${ICON.copy}</button>
              <button class="lc-btn" data-act="download" title="Download transcript (.txt)">${ICON.download}</button>
              <button class="lc-btn" data-act="history" title="Open saved history">${ICON.history}</button>
              <button class="lc-btn" data-act="collapse" title="Minimize">${ICON.min}</button>
              <button class="lc-btn" data-act="close" title="Hide panel">${ICON.close}</button>
            </div>
          </div>
          <div class="lc-searchbar" data-el="searchbar" hidden>
            <input data-el="search" type="text" placeholder="Filter transcript…" />
          </div>
          <div class="lc-prompt" data-el="prompt" hidden>
            Turn on Google Meet <b>captions (CC)</b> so LocalCaptions can capture this meeting.
            <br /><button data-act="enable">Turn on captions</button>
          </div>
          <div class="lc-body" data-el="body">
            <div class="lc-empty" data-el="empty">Waiting for captions…<br />Speech will appear here in real time.</div>
            <ol class="lc-lines" data-el="lines"></ol>
            <button class="lc-jump" data-el="jump" hidden>↓ Jump to latest</button>
          </div>
          <div class="lc-foot"><span class="lc-status" data-el="status">Idle</span></div>
        </div>
        <div class="lc-pill" data-el="pill" hidden>
          <span class="lc-dot" data-el="pilldot"></span><span data-el="pilltext">LocalCaptions</span>
        </div>
      `;
      document.documentElement.appendChild(host);
      this._host = host;
      this._root = root;
      this._el = {};
      root.querySelectorAll('[data-el]').forEach((n) => { this._el[n.dataset.el] = n; });

      this._wire();
      return this;
    }

    _wire() {
      const root = this._root;
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'search') this._toggleSearch();
        else if (act === 'copy') this._copyAll(btn);
        else if (act === 'download') this._download();
        else if (act === 'history') this.onOpenHistory();
        else if (act === 'collapse') this.collapse();
        else if (act === 'close') this.hide();
        else if (act === 'enable') this.onEnableCaptions();
      });

      // Per-line copy (event delegation).
      this._el.lines.addEventListener('click', (e) => {
        const cp = e.target.closest('.lc-line-copy');
        if (!cp) return;
        const li = cp.closest('.lc-line');
        const t = this.turns.get(Number(li.dataset.id));
        if (!t) return;
        copyText(`${t.speaker}: ${t.text}`).then((ok) => {
          if (ok) { cp.classList.add('done'); cp.textContent = '✓'; setTimeout(() => { cp.classList.remove('done'); cp.textContent = '⧉'; }, 1200); }
        });
      });

      // Search filter.
      this._el.search.addEventListener('input', (e) => {
        this.filter = e.target.value.trim().toLowerCase();
        this._applyFilter();
      });

      // Jump to latest.
      this._el.jump.addEventListener('click', () => { this._scrollToBottom(); this._el.jump.hidden = true; });
      this._el.body.addEventListener('scroll', () => {
        if (this._nearBottom()) this._el.jump.hidden = true;
      });

      // Pill click restores the panel.
      this._el.pill.addEventListener('click', () => this.expand());

      this._enableDrag();
    }

    _enableDrag() {
      const head = this._root.querySelector('.lc-head');
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const nx = ox + (e.clientX - sx);
        const ny = oy + (e.clientY - sy);
        const maxX = window.innerWidth - 60, maxY = window.innerHeight - 40;
        this._host.style.left = Math.max(0, Math.min(nx, maxX)) + 'px';
        this._host.style.top = Math.max(0, Math.min(ny, maxY)) + 'px';
        this._host.style.right = 'auto';
      };
      const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('.lc-btn')) return; // don't drag when clicking buttons
        dragging = true;
        const r = this._host.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
    }

    // ---- public API ----

    setTitle(title) {
      if (!title) return;
      this.title = title;
      if (this._el) this._el.title.textContent = title;
    }

    setRecording(on) {
      if (!this._el) return;
      this._el.dot.classList.toggle('rec', !!on);
      this._el.pilldot.classList.toggle('rec', !!on);
    }

    setStatus(text) {
      if (this._el) this._el.status.textContent = text;
    }

    setCaptionsActive(active) {
      if (!this._el) return;
      this._el.prompt.hidden = !!active;
    }

    upsertTurn(turn) {
      if (!this._el) return;
      const id = turn.id;
      const existed = this.turns.has(id);
      this.turns.set(id, { speaker: turn.speaker, text: turn.text, startedAt: turn.startedAt });

      const wasAtBottom = this._nearBottom();
      let li = this._el.lines.querySelector(`[data-id="${id}"]`);
      if (!li) {
        li = this._insertLineNode(id, turn);
      } else {
        li.querySelector('.lc-spk').textContent = turn.speaker;
        li.querySelector('.lc-spk').style.color = speakerColor(turn.speaker);
        li.querySelector('.lc-line-text').textContent = turn.text;
      }
      this._el.empty.hidden = this.turns.size > 0;
      if (this.filter) this._applyFilterToLine(li);

      if (wasAtBottom) this._scrollToBottom();
      else if (!existed) this._el.jump.hidden = false;

      this._updateCount();
    }

    // Insert a line node in id order (ids are monotonic with first appearance).
    _insertLineNode(id, turn) {
      const li = document.createElement('li');
      li.className = 'lc-line';
      li.dataset.id = String(id);
      li.innerHTML = `
        <div class="lc-line-head">
          <span class="lc-spk" style="color:${speakerColor(turn.speaker)}">${esc(turn.speaker)}</span>
          <span class="lc-ts">${clockHM(turn.startedAt)}</span>
          <button class="lc-line-copy" title="Copy line">⧉</button>
        </div>
        <div class="lc-line-text">${esc(turn.text)}</div>`;
      const lines = this._el.lines;
      let ref = null;
      for (const child of lines.children) {
        if (Number(child.dataset.id) > id) { ref = child; break; }
      }
      lines.insertBefore(li, ref);
      return li;
    }

    _updateCount() {
      const n = this.turns.size;
      this.setStatus(`${n} line${n === 1 ? '' : 's'} captured`);
    }

    clear() {
      this.turns.clear();
      if (this._el) { this._el.lines.innerHTML = ''; this._el.empty.hidden = false; this._updateCount(); }
    }

    // ---- transcript export ----

    buildText(withSeconds) {
      const rows = Array.from(this.turns.entries()).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      const fmt = withSeconds ? clockHMS : clockHM;
      const head = `${this.title}\nSaved by LocalCaptions\n\n`;
      return head + rows.map((t) => `[${fmt(t.startedAt)}] ${t.speaker}: ${t.text}`).join('\n');
    }

    async _copyAll(btn) {
      const ok = await copyText(this.buildText(false));
      if (ok && btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✓';
        setTimeout(() => { btn.innerHTML = orig; }, 1200);
      }
    }

    _download() {
      const stamp = clockHM(Date.now()).replace(':', '');
      download(`${safeName(this.title)}-${stamp}.txt`, this.buildText(true));
    }

    // ---- search / scroll / collapse ----

    _toggleSearch() {
      const sb = this._el.searchbar;
      sb.hidden = !sb.hidden;
      if (!sb.hidden) this._el.search.focus();
      else { this._el.search.value = ''; this.filter = ''; this._applyFilter(); }
    }

    _applyFilter() {
      this._el.lines.querySelectorAll('.lc-line').forEach((li) => this._applyFilterToLine(li));
    }
    _applyFilterToLine(li) {
      if (!this.filter) { li.hidden = false; return; }
      const t = this.turns.get(Number(li.dataset.id));
      const hay = ((t && t.speaker) + ' ' + (t && t.text)).toLowerCase();
      li.hidden = !hay.includes(this.filter);
    }

    _nearBottom() {
      const b = this._el.body;
      return b.scrollHeight - b.scrollTop - b.clientHeight < 60;
    }
    _scrollToBottom() {
      const b = this._el.body;
      b.scrollTop = b.scrollHeight;
    }

    collapse() {
      this._collapsed = true;
      this._root.querySelector('.lc-panel').hidden = true;
      this._el.pill.hidden = false;
      this._el.pilltext.textContent = `LocalCaptions · ${this.turns.size}`;
    }
    expand() {
      this._collapsed = false;
      this._root.querySelector('.lc-panel').hidden = false;
      this._el.pill.hidden = true;
      this._scrollToBottom();
    }

    // Set inline display directly (not just the [hidden] attribute) so hiding
    // works even if panel.css never loaded - inline style beats Meet's author CSS.
    show() { if (this._host) { this._host.hidden = false; this._host.style.display = ''; } }
    hide() { if (this._host) { this._host.hidden = true; this._host.style.display = 'none'; } }
    isVisible() { return !!(this._host && this._host.style.display !== 'none'); }
    toggle() { if (this.isVisible()) this.hide(); else this.show(); return this.isVisible(); }
  }

  return { Panel };
});
