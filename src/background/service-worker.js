/**
 * LocalCaptions service worker.
 *
 * The single writer to IndexedDB. The content script (in the meet.google.com
 * origin) cannot reach the extension-origin database, so it streams turn and
 * lifecycle messages here. Also owns opening the history tab.
 */
import * as store from '../lib/storage.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // keep the channel open for the async response
});

async function handle(msg) {
  switch (msg && msg.type) {
    case 'MEETING_START':
      return store.startMeeting(msg.meeting);
    case 'TURN_UPSERT':
      return store.upsertTurn(msg.sessionId, msg.turn);
    case 'TITLE_UPDATE':
      return store.setTitle(msg.sessionId, msg.title);
    case 'MEETING_END':
      return store.endMeeting(msg.sessionId, msg.endedAt);
    case 'OPEN_HISTORY':
      return openHistory(msg.sessionId);
    case 'STATS':
      return store.stats();
    default:
      return undefined;
  }
}

async function openHistory(sessionId) {
  const base = chrome.runtime.getURL('src/history/history.html');
  const url = sessionId ? `${base}#${encodeURIComponent(sessionId)}` : base;
  // Reuse an already-open history tab if there is one. Querying by url needs no
  // "tabs" permission for our own extension page, but guard it so a missing
  // match (or any restriction) just falls through to opening a fresh tab.
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: base + '*' }); } catch (_e) { tabs = []; }
  if (tabs && tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// First-run: open the history page so the user sees where transcripts live.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
  }
});
