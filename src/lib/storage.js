/**
 * LocalCaptions storage layer - IndexedDB, shared across the extension origin.
 *
 * The service worker is the sole *writer* (it receives turn/lifecycle messages
 * from the content script, which lives in the meet.google.com origin and cannot
 * touch this database directly). The popup and history pages are *readers* and
 * import these same helpers. IndexedDB handles the cross-context concurrency.
 *
 * Stores:
 *   meetings  keyPath "sessionId"
 *             { sessionId, code, title, url, startedAt, endedAt, updatedAt, turnCount }
 *   turns     keyPath ["sessionId","id"], index "bySession" -> "sessionId"
 *             { sessionId, id, speaker, text, startedAt, updatedAt }
 *
 * `sessionId` = `${meetingCode}__${startedAtISO}` so re-joining the same code
 * later produces a distinct, separately-saved session.
 */

// Intentionally kept as 'meetscribe' (the project's original codename): renaming
// the IndexedDB database would orphan transcripts already saved on a user's
// machine. The name is internal and never shown in the UI.
const DB_NAME = 'meetscribe';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meetings')) {
        db.createObjectStore('meetings', { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains('turns')) {
        const turns = db.createObjectStore('turns', { keyPath: ['sessionId', 'id'] });
        turns.createIndex('bySession', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Invalidate the memoized promise if the connection goes away, so the next
      // call re-opens a fresh connection instead of reusing a closed one.
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      db.onclose = () => { _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

// Promise wrapper for an IDBRequest.
function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Promise that resolves when a transaction commits.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** Create the meeting record for a session (no-op-ish if it already exists). */
export async function startMeeting(meeting) {
  const db = await openDB();
  const tx = db.transaction('meetings', 'readwrite');
  const store = tx.objectStore('meetings');
  const existing = await reqp(store.get(meeting.sessionId));
  const merged = {
    sessionId: meeting.sessionId,
    code: meeting.code || (existing && existing.code) || '',
    title: meeting.title || (existing && existing.title) || '',
    url: meeting.url || (existing && existing.url) || '',
    startedAt: (existing && existing.startedAt) || meeting.startedAt || meeting.updatedAt || 0,
    endedAt: (existing && existing.endedAt) || 0,
    updatedAt: Math.max((existing && existing.updatedAt) || 0, meeting.startedAt || 0),
    turnCount: (existing && existing.turnCount) || 0,
  };
  store.put(merged);
  await txDone(tx);
  return merged;
}

/** Insert or update one turn; keeps the parent meeting's counters fresh. */
export async function upsertTurn(sessionId, turn) {
  const db = await openDB();
  const tx = db.transaction(['turns', 'meetings'], 'readwrite');
  const turns = tx.objectStore('turns');
  const meetings = tx.objectStore('meetings');

  const key = [sessionId, turn.id];
  const prior = await reqp(turns.get(key));
  turns.put({
    sessionId,
    id: turn.id,
    speaker: turn.speaker || 'Speaker',
    text: turn.text || '',
    startedAt: turn.startedAt || 0,
    updatedAt: turn.updatedAt || 0,
  });

  let m = await reqp(meetings.get(sessionId));
  if (!m) {
    m = {
      sessionId,
      code: sessionId.split('__')[0] || '',
      title: '',
      url: '',
      startedAt: turn.startedAt || turn.updatedAt || 0,
      endedAt: 0,
      updatedAt: 0,
      turnCount: 0,
    };
  }
  if (!prior) m.turnCount = (m.turnCount || 0) + 1;
  m.updatedAt = Math.max(m.updatedAt || 0, turn.updatedAt || 0);
  if (!m.startedAt) m.startedAt = turn.startedAt || turn.updatedAt || 0;
  meetings.put(m);

  await txDone(tx);
}

export async function endMeeting(sessionId, endedAt) {
  const db = await openDB();
  const tx = db.transaction('meetings', 'readwrite');
  const store = tx.objectStore('meetings');
  const m = await reqp(store.get(sessionId));
  if (m) {
    m.endedAt = endedAt || m.updatedAt || 0;
    m.updatedAt = Math.max(m.updatedAt || 0, m.endedAt);
    store.put(m);
  }
  await txDone(tx);
}

export async function setTitle(sessionId, title) {
  if (!title) return;
  const db = await openDB();
  const tx = db.transaction('meetings', 'readwrite');
  const store = tx.objectStore('meetings');
  const m = await reqp(store.get(sessionId));
  if (m) {
    m.title = title;
    store.put(m);
  }
  await txDone(tx);
}

export async function listMeetings() {
  const db = await openDB();
  const tx = db.transaction('meetings', 'readonly');
  const all = await reqp(tx.objectStore('meetings').getAll());
  return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function getMeeting(sessionId) {
  const db = await openDB();
  const tx = db.transaction('meetings', 'readonly');
  return reqp(tx.objectStore('meetings').get(sessionId));
}

export async function getTurns(sessionId) {
  const db = await openDB();
  const tx = db.transaction('turns', 'readonly');
  const idx = tx.objectStore('turns').index('bySession');
  const rows = await reqp(idx.getAll(IDBKeyRange.only(sessionId)));
  return rows.sort((a, b) => a.id - b.id);
}

export async function deleteMeeting(sessionId) {
  const db = await openDB();
  const tx = db.transaction(['turns', 'meetings'], 'readwrite');
  const turns = tx.objectStore('turns');
  const idx = turns.index('bySession');
  const keys = await reqp(idx.getAllKeys(IDBKeyRange.only(sessionId)));
  for (const k of keys) turns.delete(k);
  tx.objectStore('meetings').delete(sessionId);
  await txDone(tx);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['turns', 'meetings'], 'readwrite');
  tx.objectStore('turns').clear();
  tx.objectStore('meetings').clear();
  await txDone(tx);
}

/** Aggregate counters for the popup. */
export async function stats() {
  const db = await openDB();
  const tx = db.transaction(['turns', 'meetings'], 'readonly');
  const meetings = await reqp(tx.objectStore('meetings').count());
  const turns = await reqp(tx.objectStore('turns').count());
  return { meetings, turns };
}

/**
 * Full-text search across all saved meetings. Returns matching meetings with a
 * short snippet. Scans turn text lazily per meeting; fine for personal volumes.
 */
export async function searchMeetings(query) {
  const q = (query || '').trim().toLowerCase();
  const meetings = await listMeetings();
  if (!q) return meetings.map((m) => ({ meeting: m, snippet: '' }));

  const db = await openDB();
  const results = [];
  for (const m of meetings) {
    const titleHit = (m.title || '').toLowerCase().includes(q);
    const tx = db.transaction('turns', 'readonly');
    const idx = tx.objectStore('turns').index('bySession');
    const rows = await reqp(idx.getAll(IDBKeyRange.only(m.sessionId)));
    let snippet = '';
    let bodyHit = false;
    for (const r of rows) {
      const lc = (r.text || '').toLowerCase();
      const at = lc.indexOf(q);
      if (at !== -1) {
        bodyHit = true;
        const start = Math.max(0, at - 30);
        snippet = (start > 0 ? '…' : '') + r.text.slice(start, at + q.length + 40).trim() + '…';
        break;
      }
    }
    if (titleHit || bodyHit) results.push({ meeting: m, snippet });
  }
  return results;
}
