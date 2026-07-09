import {
  listMeetings, getMeeting, getTurns, deleteMeeting, clearAll, searchMeetings, stats,
} from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let meetings = [];       // {meeting, snippet}
let current = null;      // { meeting, turns: [] }

// ---- formatting helpers ----
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function clockHMS(ms) { const d = new Date(ms || 0); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function clockHM(ms) { const d = new Date(ms || 0); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function fmtWhen(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(m) {
  const start = m.startedAt || 0;
  const end = m.endedAt || m.updatedAt || 0;
  const min = Math.round(Math.max(0, end - start) / 60000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), mm = min % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}
function meetingLabel(m) { return m.title || (m.code ? `Meet ${m.code}` : 'Untitled meeting'); }

function hueFor(name) { let h = 0; const s = String(name || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
function speakerColor(name) { return `hsl(${hueFor(name)}, 68%, 66%)`; }

function escapeHTML(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Highlight matches by scanning the ORIGINAL text with a case-insensitive regex,
// so indices always line up (avoids drift when toLowerCase() changes length).
function highlight(text, q) {
  if (!q) return escapeHTML(text);
  let out = '', last = 0, m;
  const re = new RegExp(escapeRegExp(q), 'gi');
  while ((m = re.exec(text)) !== null) {
    out += escapeHTML(text.slice(last, m.index));
    out += '<mark>' + escapeHTML(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
  }
  out += escapeHTML(text.slice(last));
  return out;
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function safeName(s) { return String(s || 'meeting').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting'; }

// ---- exports ----
function buildTxt(meeting, turns) {
  const head = `${meetingLabel(meeting)}\n${fmtWhen(meeting.startedAt)} · ${fmtDuration(meeting)}\nSaved by LocalCaptions\n\n`;
  return head + turns.map((t) => `[${clockHMS(t.startedAt)}] ${t.speaker}: ${t.text}`).join('\n');
}
function buildMd(meeting, turns) {
  let out = `# ${meetingLabel(meeting)}\n\n_${fmtWhen(meeting.startedAt)} · ${fmtDuration(meeting)} · ${turns.length} lines_\n\n`;
  for (const t of turns) out += `**${t.speaker}** \`${clockHM(t.startedAt)}\`  \n${t.text}\n\n`;
  return out;
}

// ---- sidebar list ----
async function refreshList(query) {
  meetings = query ? await searchMeetings(query) : (await listMeetings()).map((m) => ({ meeting: m, snippet: '' }));
  renderList();
  renderStats();
}

function renderList() {
  const ul = $('mlist');
  if (!meetings.length) {
    ul.innerHTML = `<li class="muted">${$('search').value ? 'No matches.' : 'No saved meetings yet. Join a Google Meet with captions on to start.'}</li>`;
    return;
  }
  ul.innerHTML = '';
  for (const { meeting: m, snippet } of meetings) {
    const li = document.createElement('li');
    li.className = 'mitem' + (current && current.meeting.sessionId === m.sessionId ? ' active' : '');
    li.dataset.session = m.sessionId;
    li.innerHTML =
      `<div class="mi-title"></div>` +
      `<div class="mi-meta"></div>` +
      (snippet ? `<div class="mi-snip"></div>` : '');
    li.querySelector('.mi-title').textContent = meetingLabel(m);
    li.querySelector('.mi-meta').textContent = `${fmtWhen(m.startedAt)} · ${m.turnCount || 0} lines · ${fmtDuration(m)}`;
    if (snippet) li.querySelector('.mi-snip').textContent = snippet;
    li.onclick = () => openMeeting(m.sessionId);
    ul.appendChild(li);
  }
}

async function renderStats() {
  try {
    const s = await stats();
    $('sbStats').textContent = `${s.meetings} meeting${s.meetings === 1 ? '' : 's'} · ${s.turns} lines`;
  } catch (_e) {}
}

// ---- detail view ----
async function openMeeting(sessionId) {
  const meeting = await getMeeting(sessionId);
  if (!meeting) { showEmpty(); return; }
  const turns = await getTurns(sessionId);
  current = { meeting, turns };

  if (location.hash.slice(1) !== encodeURIComponent(sessionId)) {
    history.replaceState(null, '', '#' + encodeURIComponent(sessionId));
  }

  $('emptyState').hidden = true;
  $('viewer').hidden = false;
  $('dTitle').textContent = meetingLabel(meeting);
  $('dMeta').textContent = `${fmtWhen(meeting.startedAt)} · ${fmtDuration(meeting)} · ${turns.length} line${turns.length === 1 ? '' : 's'}${meeting.code ? ' · ' + meeting.code : ''}`;
  renderTranscript('');
  document.querySelectorAll('.mitem').forEach((el) => el.classList.toggle('active', el.dataset.session === sessionId));
  const ts = $('tsearch'); ts.hidden = true; ts.value = '';
}

function renderTranscript(query) {
  const box = $('transcript');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const t of current.turns) {
    const line = document.createElement('div');
    line.className = 't-line';
    const hay = `${t.speaker} ${t.text}`.toLowerCase();
    if (query && !hay.includes(query.toLowerCase())) line.hidden = true;
    line.innerHTML =
      `<div class="t-time">${clockHMS(t.startedAt)}</div>` +
      `<div class="t-body">` +
        `<span class="t-spk" style="color:${speakerColor(t.speaker)}">${escapeHTML(t.speaker)}</span>` +
        `<button class="t-copy" title="Copy line">⧉</button>` +
        `<div class="t-text">${highlight(t.text, query)}</div>` +
      `</div>`;
    line.querySelector('.t-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(`${t.speaker}: ${t.text}`); } catch (_e) {}
    };
    frag.appendChild(line);
  }
  box.appendChild(frag);
}

function showEmpty() {
  current = null;
  $('viewer').hidden = true;
  $('emptyState').hidden = false;
  if (location.hash) history.replaceState(null, '', location.pathname);
}

// ---- toolbar ----
$('viewer').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tbtn');
  if (!btn || !current) return;
  const act = btn.dataset.act;
  const { meeting, turns } = current;
  if (act === 'find') {
    const ts = $('tsearch'); ts.hidden = !ts.hidden;
    if (!ts.hidden) ts.focus(); else { ts.value = ''; renderTranscript(''); }
  } else if (act === 'copy') {
    try { await navigator.clipboard.writeText(buildTxt(meeting, turns)); btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy', 1300); } catch (_e) {}
  } else if (act === 'txt') {
    download(`${safeName(meetingLabel(meeting))}.txt`, buildTxt(meeting, turns));
  } else if (act === 'md') {
    download(`${safeName(meetingLabel(meeting))}.md`, buildMd(meeting, turns));
  } else if (act === 'delete') {
    if (confirm(`Delete "${meetingLabel(meeting)}" and its transcript? This cannot be undone.`)) {
      await deleteMeeting(meeting.sessionId);
      showEmpty();
      await refreshList($('search').value.trim());
    }
  }
});

$('tsearch').addEventListener('input', (e) => { if (current) renderTranscript(e.target.value.trim()); });

// ---- sidebar events ----
let searchTimer = null;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => refreshList(q), 200);
});

$('btnClear').onclick = async () => {
  if (!meetings.length) return;
  if (confirm('Delete ALL saved meetings and transcripts? This cannot be undone.')) {
    await clearAll();
    showEmpty();
    await refreshList('');
  }
};

window.addEventListener('hashchange', () => {
  const sid = decodeURIComponent(location.hash.slice(1));
  if (sid) openMeeting(sid);
});

// ---- init ----
(async function init() {
  await refreshList('');
  const sid = decodeURIComponent(location.hash.slice(1));
  if (sid) openMeeting(sid);
})();
