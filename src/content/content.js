/**
 * LocalCaptions content-script entry point.
 *
 * Runs on every meet.google.com page and reacts to Meet's single-page routing:
 * when the URL is a meeting (a `xxx-yyyy-zzz` code), it mounts the panel and
 * starts capturing; when you leave, it flushes and finalizes the session.
 *
 * Data flow:
 *   Scraper (DOM)  ->  Engine (dedup/stabilize)  ->  Panel (live UI)
 *                                              \->  Service worker (IndexedDB)
 *
 * Loaded after transcript-engine.js, meet-scraper.js and panel.js, which expose
 * LocalCaptionsEngine / LocalCaptionsScraper / LocalCaptionsPanel on the shared isolated
 * world.
 */
(function () {
  'use strict';
  if (window.__localcaptionsLoaded) return;
  window.__localcaptionsLoaded = true;

  const { TranscriptEngine } = self.LocalCaptionsEngine;
  const Scraper = self.LocalCaptionsScraper;
  const { Panel } = self.LocalCaptionsPanel;

  // A Meet room code looks like abc-defg-hij (occasionally longer).
  const CODE_RE = /^\/([a-z0-9]{3,}-[a-z0-9]{3,}-[a-z0-9]{3,})/i;

  const state = {
    code: null,
    sessionId: null,
    started: false,
    startedAt: 0,
    title: '',
    captionsActive: false,
    panel: null,
    engine: null,
    scraper: null,
    titleTimer: null,
    lastSentTitle: '',
  };

  function meetingCode() {
    const m = location.pathname.match(CODE_RE);
    return m ? m[1] : null;
  }

  function cleanTitle(t) {
    const cleaned = (t || '').replace(/\s*[-–\u2014]\s*Google Meet\s*$/i, '').trim();
    if (!cleaned) return '';
    if (state.code && cleaned.toLowerCase() === state.code.toLowerCase()) return '';
    return cleaned;
  }

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_e) { /* extension context invalidated (reload) - ignore */ }
  }

  // ---- lifecycle ----

  function ensureStarted() {
    if (state.started) return;
    state.started = true;
    state.startedAt = Date.now();
    state.sessionId = `${state.code}__${new Date(state.startedAt).toISOString()}`;
    state.title = cleanTitle(document.title);
    send({
      type: 'MEETING_START',
      meeting: {
        sessionId: state.sessionId,
        code: state.code,
        title: state.title,
        url: location.href,
        startedAt: state.startedAt,
      },
    });
    if (state.title) { state.lastSentTitle = state.title; }
    maybePushTitle();
  }

  function maybePushTitle() {
    if (!state.started) return;
    const t = cleanTitle(document.title);
    if (t && t !== state.lastSentTitle) {
      state.lastSentTitle = t;
      state.title = t;
      if (state.panel) state.panel.setTitle(t);
      send({ type: 'TITLE_UPDATE', sessionId: state.sessionId, title: t });
    }
  }

  function enterMeeting(code) {
    state.code = code;

    const engine = new TranscriptEngine();
    const panel = new Panel({
      onEnableCaptions: () => {
        const ok = Scraper.enableCaptions(document);
        panel.setStatus(ok ? 'Enabling captions…' : 'Open Meet\'s "⋮" menu → Captions to enable.');
      },
      onOpenHistory: () => send({ type: 'OPEN_HISTORY', sessionId: state.sessionId }),
    });
    panel.mount();
    panel.setTitle(cleanTitle(document.title) || 'Google Meet');
    panel.setStatus('Ready - turn on captions (CC)');

    engine.on('update', (turn) => {
      ensureStarted();
      panel.upsertTurn(turn);
    });
    engine.on('persist', (turn) => {
      ensureStarted();
      send({
        type: 'TURN_UPSERT',
        sessionId: state.sessionId,
        turn: { id: turn.id, speaker: turn.speaker, text: turn.text, startedAt: turn.startedAt, updatedAt: turn.updatedAt },
      });
    });

    const scraper = new Scraper.Scraper({
      onRows: (rows) => engine.ingest(rows, Date.now()),
      onCaptionsState: (active) => {
        state.captionsActive = active;
        // Use the local `panel` (always defined here) rather than state.panel,
        // which is assigned only after scraper.start() returns.
        panel.setCaptionsActive(active);
        panel.setRecording(active);
        if (active) {
          if (panel.turns.size === 0) panel.setStatus('Listening…');
        } else {
          panel.setStatus('Captions off - turn on CC to capture');
        }
      },
      pollMs: 1000,
    });
    scraper.start();

    state.engine = engine;
    state.panel = panel;
    state.scraper = scraper;

    state.titleTimer = setInterval(maybePushTitle, 3000);
  }

  function leaveMeeting() {
    if (!state.code) return;
    try {
      if (state.engine) state.engine.flush(Date.now());
    } catch (_e) {}
    if (state.started) {
      send({ type: 'MEETING_END', sessionId: state.sessionId, endedAt: Date.now() });
    }
    if (state.scraper) state.scraper.stop();
    if (state.titleTimer) clearInterval(state.titleTimer);
    if (state.panel && state.panel._host) state.panel._host.remove();

    state.code = null;
    state.sessionId = null;
    state.started = false;
    state.startedAt = 0;
    state.title = '';
    state.lastSentTitle = '';
    state.captionsActive = false;
    state.engine = state.panel = state.scraper = null;
    state.titleTimer = null;
  }

  function sync() {
    const code = meetingCode();
    if (code && code !== state.code) {
      if (state.code) leaveMeeting();
      enterMeeting(code);
    } else if (!code && state.code) {
      leaveMeeting();
    }
  }

  // ---- SPA navigation + unload hooks ----

  function watchNavigation() {
    const fire = () => setTimeout(sync, 50);
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener('popstate', fire);
    setInterval(sync, 2000); // safety net for routing we can't hook
  }

  function onExit() {
    try {
      if (state.engine) state.engine.flush(Date.now());
      if (state.started) send({ type: 'MEETING_END', sessionId: state.sessionId, endedAt: Date.now() });
    } catch (_e) {}
  }
  window.addEventListener('pagehide', onExit);
  window.addEventListener('beforeunload', onExit);

  // ---- messages from popup ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'GET_STATE':
        sendResponse({
          inMeeting: !!state.code,
          started: state.started,
          captionsActive: state.captionsActive,
          lineCount: state.panel ? state.panel.turns.size : 0,
          title: state.title || cleanTitle(document.title) || 'Google Meet',
          sessionId: state.sessionId,
          panelVisible: state.panel ? state.panel.isVisible() : false,
        });
        break;
      case 'TOGGLE_PANEL':
        sendResponse({ visible: state.panel ? state.panel.toggle() : false });
        break;
      case 'SHOW_PANEL':
        if (state.panel) { state.panel.show(); state.panel.expand(); }
        sendResponse({ visible: true });
        break;
      case 'GET_TRANSCRIPT':
        sendResponse({ text: state.panel ? state.panel.buildText(true) : '', title: state.title });
        break;
      default:
        sendResponse({});
    }
    return false;
  });

  watchNavigation();
  sync();
})();
