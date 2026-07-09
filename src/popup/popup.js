import { listMeetings, stats } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  if (isYest) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function meetingLabel(m) {
  return m.title || (m.code ? `Meet ${m.code}` : 'Untitled meeting');
}

async function activeMeetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https:\/\/meet\.google\.com\//.test(tab.url)) return tab;
  return null;
}

async function askContent(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (_e) { return null; }
}

async function renderLive() {
  const pill = $('livePill');
  const title = $('liveTitle');
  const sub = $('liveSub');
  const actions = $('liveActions');

  const tab = await activeMeetTab();
  if (!tab) {
    pill.textContent = 'Not in a meeting';
    pill.className = 'pill';
    title.textContent = '';
    sub.textContent = 'Open a Google Meet tab to start capturing.';
    actions.hidden = true;
    return;
  }

  const st = await askContent(tab.id, { type: 'GET_STATE' });
  actions.hidden = false;
  if (!st || !st.inMeeting) {
    pill.textContent = 'On Google Meet';
    pill.className = 'pill';
    title.textContent = '';
    sub.textContent = 'Join a call and turn on captions (CC).';
    $('btnCopy').disabled = true;
    return;
  }

  title.textContent = st.title || 'Google Meet';
  if (st.captionsActive) { pill.textContent = 'Recording'; pill.className = 'pill rec'; }
  else { pill.textContent = 'Captions off'; pill.className = 'pill'; }
  const n = st.lineCount || 0;
  sub.textContent = st.captionsActive
    ? `${n} line${n === 1 ? '' : 's'} captured`
    : `${n} captured - turn on CC to continue`;
  $('btnCopy').disabled = n === 0;

  $('btnPanel').onclick = async () => { await askContent(tab.id, { type: 'SHOW_PANEL' }); window.close(); };
  $('btnCopy').onclick = async () => {
    const res = await askContent(tab.id, { type: 'GET_TRANSCRIPT' });
    if (res && res.text) {
      try { await navigator.clipboard.writeText(res.text); $('btnCopy').textContent = 'Copied ✓'; }
      catch (_e) { $('btnCopy').textContent = 'Copy failed'; }
      setTimeout(() => { $('btnCopy').textContent = 'Copy transcript'; }, 1300);
    }
  };
}

async function renderRecent() {
  const list = $('recent');
  let meetings = [];
  try { meetings = await listMeetings(); } catch (_e) {}
  if (!meetings.length) {
    list.innerHTML = '<li class="muted">No saved meetings yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const m of meetings.slice(0, 6)) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<div class="t"></div><div class="m"></div>`;
    li.querySelector('.t').textContent = meetingLabel(m);
    li.querySelector('.m').textContent =
      `${fmtDate(m.startedAt)} · ${m.turnCount || 0} line${(m.turnCount || 0) === 1 ? '' : 's'}`;
    li.onclick = () => {
      chrome.runtime.sendMessage({ type: 'OPEN_HISTORY', sessionId: m.sessionId });
      window.close();
    };
    list.appendChild(li);
  }
}

async function renderStats() {
  try {
    const s = await stats();
    $('stats').textContent = `${s.meetings} meeting${s.meetings === 1 ? '' : 's'} · ${s.turns} lines saved`;
  } catch (_e) { $('stats').textContent = ''; }
}

$('btnHistory').onclick = () => {
  chrome.runtime.sendMessage({ type: 'OPEN_HISTORY' });
  window.close();
};

renderLive();
renderRecent();
renderStats();
