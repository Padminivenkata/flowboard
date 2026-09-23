/* FlowBoard client */
'use strict';

const ROLES = ['viewer', 'editor', 'admin'];
const $ = (id) => document.getElementById(id);

let board = null;
let socket = null;
let refreshTimer = null;
let draggedId = null;
let editingTaskId = null;
let targetColumnId = null;
let editingColumnId = null;
let draftTags = new Set();
let draftDepts = [];
let draftPris = [];
let redrawSettingsLists = null;
let authMode = 'login';

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function initials(n) {
  return (n || '').split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase() || '?';
}
function canEdit() { return !!board && board.me.role !== 'viewer'; }
function isAdmin() { return !!board && board.me.role === 'admin'; }
function fmtDue(due) {
  if (!due) return 'No due date';
  return 'Due ' + new Date(due + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.style.display = 'block';
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => { t.style.display = 'none'; }, 2200);
}
function fmtCycle(min) {
  if (min == null) return '—';
  if (min < 60) return Math.round(min) + 'm';
  const h = min / 60;
  if (h < 24) return (Math.round(h * 10) / 10) + 'h';
  const d = Math.floor(h / 24);
  const rh = Math.round(h % 24);
  return d + 'd ' + rh + 'h';
}
function hoursOf(t) {
  const n = parseFloat(String(t.hours || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function fmtFull(n) { return (Math.round(n * 10) / 10) + 'h'; }
const RECURLABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', half: '6-mo', yearly: 'Yearly' };
function fmtElapsed(startSec, nowSec) {
  const mins = Math.floor(Math.max(0, nowSec - startSec) / 60);
  if (mins < 60) return mins + 'm';
  const h = mins / 60;
  if (h < 24) return (Math.floor(h * 10) / 10) + 'h';
  const d = Math.floor(h / 24);
  const rh = Math.floor(h % 24);
  return d + 'd ' + rh + 'h';
}
const PRIO_COLORS = { high: '#c44d45', medium: '#e8a548', low: '#3fb27f' };
function prioColor(p) { return PRIO_COLORS[String(p || '').toLowerCase()] || '#9ba0ae'; }
async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showAuth(); throw new Error('Please log in'); }
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }

/* ---------- data loading & rendering ---------- */
async function loadBoard() {
  board = await api('/api/board');
  renderAll();
}

function renderAll() {
  if (!board) return;
  const s = board.settings;
  $('wsName').textContent = s.workspace_name;
  $('boardTitle').textContent = s.board_name;
  $('sprintName').textContent = s.sprint_name || '—';
  $('btnSprint').textContent = s.sprint_active ? 'End Sprint' : 'Start Sprint';
  $('whoami').innerHTML = esc(board.me.username) + `<span class="role-chip">${esc(board.me.role)}</span>`;
  $('btnNewTask').hidden = !canEdit();
  $('btnSprint').hidden = !canEdit();
  $('navSettings').hidden = !canEdit();
  $('navLabels').hidden = !canEdit();
  $('navMembers').hidden = !isAdmin();
  fillFilters();
  renderStats();
  renderCapacity();
  renderColumns();
  if ($('membersModal').classList.contains('show')) renderMembers();
  if ($('calendarModal').classList.contains('show')) renderCalendar();
}

function renderStats() {
  const st = board.stats;
  $('statbar').hidden = !st;
  if (!st) return;
  $('statCycle').innerHTML = `Avg cycle (In Progress → Done): <span>${fmtCycle(st.avgCycleMinutes)}</span> <em>(${st.cycleCount} done)</em>`;
  $('statDone').innerHTML = `Done: <span>${st.doneCount}</span>`;
  $('statOpen').innerHTML = `Open: <span>${st.openCount}</span>`;
  $('statHours').innerHTML = `Total hours: <span>${fmtFull(st.totalHours)}</span>`;
}

function renderCapacity() {
  const caps = board.capacity || [];
  const hasData = caps.some((c) => c.capacity > 0 || c.workload > 0);
  $('capacityWrap').hidden = !hasData;
  if (!hasData) return;
  const totCap = caps.reduce((s, c) => s + c.capacity, 0);
  const totLoad = caps.reduce((s, c) => s + c.workload, 0);
  $('capSummary').textContent = `${fmtFull(totLoad)} of ${totCap || 'no'} hrs capacity assigned`;
  $('capacityList').innerHTML = caps.map((c) => {
    const pct = c.capacity > 0 ? Math.round((c.workload / c.capacity) * 100) : 0;
    const cls = c.capacity > 0 ? (pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok') : 'na';
    const barW = c.capacity > 0 ? Math.min(100, pct) : 0;
    const score = c.capacity > 0 ? `${pct}%` : '—';
    return `<div class="cap-item">
      <div class="cap-top">
        <span class="cap-user"><span class="avatar">${initials(c.username)}</span> ${esc(c.username)}</span>
        <span class="cap-h">${fmtFull(c.workload)} / ${c.capacity ? fmtFull(c.capacity) : '—'}</span>
      </div>
      <div class="cap-bar${cls === 'na' ? ' na' : ''}"><i style="width:${barW}%"></i></div>
      <div class="cap-top" style="margin-top:4px"><span class="cap-score ${cls}">${score === '—' ? 'capacity not set' : score + ' utilized'}</span></div>
    </div>`;
  }).join('');
}

function fillSelect(sel, values, current, allLabel) {
  const opts = [`<option value="">${allLabel}</option>`];
  const list = [...values];
  if (current && !list.includes(current)) list.push(current);
  for (const v of list) {
    opts.push(`<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`);
  }
  sel.innerHTML = opts.join('');
}

function fillFilters() {
  const assignees = [...new Set([
    ...board.members.map((m) => m.username),
    ...board.tasks.map((t) => t.assignee),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillSelect($('fAssignee'), assignees, $('fAssignee').value, 'All assignees');

  const prios = [...new Set([...(board.settings.priorities || []), ...board.tasks.map((t) => t.priority)].filter(Boolean))];
  fillSelect($('fPriority'), prios, $('fPriority').value, 'All priorities');

  const depts = [...new Set([...(board.settings.departments || []), ...board.tasks.map((t) => t.department)].filter(Boolean))];
  fillSelect($('fDept'), depts, $('fDept').value, 'All departments');

  const curTag = $('fTag').value;
  $('fTag').innerHTML = '<option value="">All tags</option>' + board.tags
    .map((t) => `<option value="${t.id}"${String(t.id) === curTag ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  if (curTag && !board.tags.some((t) => String(t.id) === curTag)) $('fTag').value = '';
}

function filteredTasks() {
  const q = $('search').value.trim().toLowerCase();
  const a = $('fAssignee').value;
  const p = $('fPriority').value;
  const d = $('fDept').value;
  const tg = $('fTag').value;
  return board.tasks.filter((t) =>
    (!q || [t.title, t.assignee, t.department, t.outcome, t.acceptance].join(' ').toLowerCase().includes(q)) &&
    (!a || t.assignee === a) &&
    (!p || t.priority === p) &&
    (!d || t.department === d) &&
    (!tg || t.tags.includes(Number(tg))));
}

let backlogMode = false;
const leftmostCol = () => board.columns.slice().sort((a, b) => a.position - b.position)[0];

function cardHtml(t) {
  const edit = canEdit();
  const prio = (t.priority || '').toLowerCase();
  const prioClass = ['high', 'medium', 'low'].includes(prio) ? ' ' + prio : '';
  let chips = t.spilled ? '<span class="tag spilled-chip" title="Carried over from a previous sprint">SPILLED</span>' : '';
  chips += `<span class="tag${prioClass}">${esc(t.priority || '—')}</span>`;
  if (t.department) chips += `<span class="tag">${esc(t.department)}</span>`;
  if (t.hours) chips += `<span class="tag">${esc(t.hours)}</span>`;
  if (t.recur) chips += `<span class="tag" title="Recurring · ${t.recurHistory.length} completed">↻ ${RECURLABELS[t.recur] || t.recur}</span>`;
  const startCol = board.columns.find((c) => c.stage === 'start');
  if (startCol && t.column_id === startCol.id && t.startedAt != null) {
    chips += `<span class="tag timelive" data-live="${t.startedAt}" title="Elapsed in ${esc(startCol.name)}">⏱ ${fmtElapsed(t.startedAt, Date.now() / 1000)}</span>`;
  }
  if (t.cycleMinutes != null) chips += `<span class="tag" title="Cycle time">↺ ${fmtCycle(t.cycleMinutes)}</span>`;
  for (const tid of t.tags) {
    const g = board.tags.find((x) => x.id === tid);
    if (g) chips += `<span class="tag dot-tag" style="color:${esc(g.color)};background:${esc(g.color)}1a">${esc(g.name)}</span>`;
  }
  let shown = 0;
  for (const f of board.customFields) {
    if (shown >= 2) break;
    const v = t.customValues[f.id];
    if (v !== undefined && v !== null && String(v) !== '') {
      chips += `<span class="tag cfield">${esc(f.name)}: ${esc(v)}</span>`;
      shown++;
    }
  }
  const inBacklog = backlogMode && edit && leftmostCol() && t.column_id === leftmostCol().id;
  return `<div class="card" data-id="${t.id}" ${edit ? 'draggable="true"' : ''}>
    <div class="task-title">${esc(t.title)}</div>
    <div class="meta">${chips}</div>
    <div class="bottom">
      <span class="avatar">${initials(t.assignee)}</span>
      <span>${esc(t.assignee || 'Unassigned')}</span>
      <span class="due">${esc(fmtDue(t.due))}</span>
      ${inBacklog ? `<button class="sprint-btn" data-act="to-sprint" type="button">→ Sprint</button>` : ''}
    </div>
  </div>`;
}

function renderColumns() {
  if (!board) return;
  const list = filteredTasks();
  $('total').textContent = list.length;
  const edit = canEdit();
  if (backlogMode) {
    const blk = leftmostCol();
    const arr = list.filter((t) => t.column_id === blk.id);
    $('columns').innerHTML = `<div class="backlog-bar">SPRINT BACKLOG — tasks waiting to be planned · <b>→ Sprint</b> on a card (or ⤴ Sprint on the column) moves it into the current sprint. Create tasks here with the ＋ button — full options, including recurrence, apply.</div>
      <div class="column" data-col="${blk.id}">
        <div class="col-head">
          <span class="dot" style="background:${esc(blk.color)}"></span>
          <span class="col-name">${esc(blk.name)}</span>
          <span class="count">${arr.length}</span>
          ${edit ? `<button class="col-edit" data-act="sprint-all" title="Move all to current sprint">⤴ Sprint</button>` : ''}
        </div>
        <div class="cards">${arr.length ? arr.map(cardHtml).join('') : '<div class="empty">Drop tasks here</div>'}</div>
        ${edit ? `<button class="add" data-act="add-card" data-col="${blk.id}">＋ Add task</button>` : ''}
      </div>`;
    return;
  }
  let html = board.columns.map((col) => {
    const arr = list.filter((t) => t.column_id === col.id);
    return `<div class="column" data-col="${col.id}">
      <div class="col-head">
        <span class="dot" style="background:${esc(col.color)}"></span>
        <span class="col-name">${esc(col.name)}</span>
        ${col.stage === 'start' ? `<span class="stage-mark" title="Start column — cycle time starts here" style="color:${esc(col.color)}">▶</span>` : ''}
        ${col.stage === 'done' ? `<span class="stage-mark" title="Done column — cycle time ends here" style="color:${esc(col.color)}">●</span>` : ''}
        <span class="count">${arr.length}</span>
        ${edit ? `<button class="col-edit" data-act="col-menu" data-col="${col.id}" title="Column options">⋯</button>` : ''}
      </div>
      <div class="cards">${arr.length ? arr.map(cardHtml).join('') : '<div class="empty">Drop tasks here</div>'}</div>
      ${edit ? `<button class="add" data-act="add-card" data-col="${col.id}">＋ Add task</button>` : ''}
    </div>`;
  }).join('');
  if (edit) {
    html += `<div class="add-col-slot"><button class="add" data-act="add-col">＋ Add column</button></div>`;
  }
  $('columns').innerHTML = html;
}

/* ---------- board interactions (drag & drop, clicks) ---------- */
function clearDropHints() {
  document.querySelectorAll('.col-dragover,.drop-before').forEach((el) => {
    el.classList.remove('col-dragover', 'drop-before');
  });
}

function bindBoard() {
  const el = $('columns');

  el.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card || !canEdit()) { e.preventDefault(); return; }
    draggedId = Number(card.dataset.id);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(draggedId));
  });
  el.addEventListener('dragend', () => {
    clearDropHints();
    document.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
    draggedId = null;
  });
  el.addEventListener('dragover', (e) => {
    if (!canEdit() || draggedId == null) return;
    const col = e.target.closest('.column');
    clearDropHints();
    if (!col) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.card');
    if (card && Number(card.dataset.id) !== draggedId) card.classList.add('drop-before');
    else col.classList.add('col-dragover');
  });
  el.addEventListener('drop', (e) => {
    if (!canEdit() || draggedId == null) return;
    const col = e.target.closest('.column');
    if (!col) return;
    e.preventDefault();
    const card = e.target.closest('.card');
    const colId = Number(col.dataset.col);
    const beforeId = card && Number(card.dataset.id) !== draggedId ? Number(card.dataset.id) : null;
    const id = draggedId;
    draggedId = null;
    clearDropHints();
    moveTask(id, colId, beforeId);
  });

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const kind = act.dataset.act;
      if (kind === 'to-sprint') { e.stopPropagation(); moveToSprint(Number(act.closest('.card').dataset.id)); return; }
      if (kind === 'sprint-all') { moveAllToSprint(); return; }
      if (kind === 'add-card') return openTaskNew(Number(act.dataset.col));
      if (kind === 'col-menu') return openColumnEdit(Number(act.dataset.col));
      if (kind === 'add-col') return openColumnNew();
      return;
    }
    const card = e.target.closest('.card');
    if (card) openTaskView(Number(card.dataset.id));
  });
}

async function moveTask(id, columnId, beforeTaskId) {
  try {
    const body = { column_id: columnId };
    if (beforeTaskId != null) body.beforeTaskId = beforeTaskId;
    await api(`/api/tasks/${id}`, { method: 'PATCH', body });
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
    await loadBoard().catch(() => {});
  }
}

function sprintTargetCol() {
  const cols = board.columns.slice().sort((a, b) => a.position - b.position);
  const blk = cols[0];
  const target = cols.find((c) => c.id !== blk.id);
  return target ? target.id : blk.id;
}

async function moveToSprint(id) {
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { column_id: sprintTargetCol() } });
    toast('Moved to current sprint');
    await loadBoard();
  } catch (e) { toast(e.message, true); }
}

async function moveAllToSprint() {
  const blk = leftmostCol();
  const ids = board.tasks.filter((t) => t.column_id === blk.id).map((t) => t.id);
  if (!ids.length) { toast('Backlog is empty', true); return; }
  const target = sprintTargetCol();
  for (const id of ids) {
    try { await api(`/api/tasks/${id}`, { method: 'PATCH', body: { column_id: target } }); } catch (e) {}
  }
  toast(`${ids.length} moved to current sprint`);
  await loadBoard();
}

function toggleBacklog() {
  backlogMode = !backlogMode;
  $('navBoard').classList.toggle('active', !backlogMode);
  $('navBacklog').classList.toggle('active', backlogMode);
  $('sidebar').classList.remove('open');
  renderColumns();
}

/* ---------- task modal ---------- */
function fillHours() {
  const opts = [];
  for (let i = 0; i <= 8; i++) opts.push(`<option>${i}h</option>`);
  $('mHours').innerHTML = opts.join('');
}

function fillTaskSelects(dept, prio) {
  const depts = [...(board.settings.departments || [])];
  if (dept && !depts.includes(dept)) depts.push(dept);
  $('mDept').innerHTML = depts.length
    ? depts.map((d) => `<option${d === dept ? ' selected' : ''}>${esc(d)}</option>`).join('')
    : '<option value=""></option>';
  const prios = [...(board.settings.priorities || [])];
  if (prio && !prios.includes(prio)) prios.push(prio);
  $('mPriority').innerHTML = prios.length
    ? prios.map((p) => `<option${p === prio ? ' selected' : ''}>${esc(p)}</option>`).join('')
    : '<option value=""></option>';
  fillAssigneeList(dept);
}

function fillAssigneeList(dept) {
  const memberDept = new Map(board.members.map((m) => [m.username, m.department || '']));
  const names = [...new Set([
    ...board.members.map((m) => m.username),
    ...board.tasks.map((t) => t.assignee),
  ].filter(Boolean))].filter((n) => {
    const dep = memberDept.get(n);
    if (dep === undefined || dep === '') return true;
    return !dept || dep === dept;
  });
  $('assigneeList').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
  if ($('mAssignee').value && !names.includes($('mAssignee').value)) $('mAssignee').value = '';
}

function fieldInputHtml(f, val, disabled) {
  const d = disabled ? ' disabled' : '';
  if (f.type === 'select') {
    return `<div class="field"><label>${esc(f.name)}</label><select data-cf="${f.id}"${d}>
      <option value="">—</option>
      ${f.options.map((o) => `<option${String(val ?? '') === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select></div>`;
  }
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
  return `<div class="field"><label>${esc(f.name)}</label><input type="${type}" data-cf="${f.id}" value="${esc(val ?? '')}"${d}></div>`;
}

function renderTaskExtras(disabled, customValues = {}) {
  const tagsBox = $('mTags');
  if (!board.tags.length) {
    tagsBox.innerHTML = '<span class="chip none">No tags yet — create them under Tags &amp; Fields</span>';
  } else {
    tagsBox.innerHTML = board.tags.map((t) =>
      `<button type="button" class="chip${draftTags.has(t.id) ? ' on' : ''}" data-tag="${t.id}" style="--chip-color:${esc(t.color)}"${disabled ? ' disabled' : ''}>${esc(t.name)}</button>`
    ).join('');
  }
  const wrap = $('mCustomWrap');
  if (!board.customFields.length) {
    wrap.hidden = true;
    $('mCustom').innerHTML = '';
  } else {
    wrap.hidden = false;
    $('mCustom').innerHTML = board.customFields
      .map((f) => fieldInputHtml(f, customValues[f.id], disabled)).join('');
  }
}

function setTaskFormDisabled(disabled) {
  $('taskModal').querySelectorAll('.form input, .form select, .form textarea').forEach((el) => { el.disabled = disabled; });
}

function openTaskNew(colId) {
  if (!canEdit()) return;
  if (!board.columns.length) { toast('Create a column first', true); return; }
  editingTaskId = null;
  targetColumnId = colId || board.columns[0].id;
  $('taskModalTitle').textContent = 'Add Task';
  $('mCycle').hidden = true;
  delete $('mCycle').dataset.live;
  $('mDelete').hidden = true;
  $('mSave').hidden = false;
  $('mTitle').value = '';
  $('mAssignee').value = '';
  $('mDue').value = '';
  $('mOutcome').value = '';
  $('mAC').value = '';
  $('mRecur').value = '';
  $('mLogged').value = '';
  const prio = board.settings.priorities[0] || 'Medium';
  const dept = board.settings.departments[0] || '';
  fillTaskSelects(dept, prio);
  $('mHours').value = '2h';
  draftTags = new Set();
  setTaskFormDisabled(false);
  renderTaskExtras(false, {});
  openModal('taskModal');
  $('mTitle').focus();
}

function openTaskView(id) {
  const t = board.tasks.find((x) => x.id === id);
  if (!t) return;
  editingTaskId = id;
  targetColumnId = t.column_id;
  $('taskModalTitle').textContent = 'Edit Task';
  const cyc = $('mCycle');
  delete cyc.dataset.live;
  const startCol = board.columns.find((c) => c.stage === 'start');
  if (startCol && t.column_id === startCol.id && t.startedAt != null) {
    cyc.hidden = false;
    cyc.dataset.live = t.startedAt;
    cyc.innerHTML = `⏱ Live — elapsed in ${esc(startCol.name)}: <b data-idx>${fmtElapsed(t.startedAt, Date.now() / 1000)}</b>`;
  } else if (t.cycleMinutes != null) {
    cyc.hidden = false;
    cyc.innerHTML = `🔄 Cycle (In Progress → Done): <b>${fmtCycle(t.cycleMinutes)}</b>` +
      (t.doneAt ? ` · finished ${new Date(t.doneAt * 1000).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '') +
      (t.loggedMinutes ? ` · logged ${fmtFull(t.loggedMinutes / 60)}` : '');
  } else if (t.loggedMinutes) {
    cyc.hidden = false;
    cyc.innerHTML = `⏱ Logged time: <b>${fmtFull(t.loggedMinutes / 60)}</b>`;
  } else {
    cyc.hidden = true;
  }
  if (t.recur) {
    cyc.hidden = false;
    cyc.innerHTML += `<br>↻ Repeats ${RECURLABELS[t.recur] || t.recur} · next due ${t.due || '—'} · ${t.recurHistory.length} completed`;
  }
  const edit = canEdit();
  $('mDelete').hidden = !edit;
  $('mSave').hidden = !edit;
  $('mTitle').value = t.title;
  $('mAssignee').value = t.assignee;
  fillTaskSelects(t.department, t.priority);
  if (t.hours && ![...$('mHours').options].some((o) => o.value === t.hours)) {
    $('mHours').innerHTML += `<option>${esc(t.hours)}</option>`;
  }
  $('mHours').value = t.hours || '0h';
  $('mDue').value = t.due;
  $('mRecur').value = t.recur || '';
  $('mLogged').value = t.loggedMinutes ? Math.round((t.loggedMinutes / 60) * 100) / 100 : '';
  $('mOutcome').value = t.outcome;
  $('mAC').value = t.acceptance;
  draftTags = new Set(t.tags);
  setTaskFormDisabled(!edit);
  renderTaskExtras(!edit, t.customValues);
  openModal('taskModal');
}

function collectCustomValues() {
  const out = {};
  document.querySelectorAll('#mCustom [data-cf]').forEach((el) => {
    const key = el.dataset.cf;
    let v = el.value;
    if (v === '') return;
    if (el.type === 'number') v = Number(v);
    out[key] = v;
  });
  return out;
}

async function saveTask() {
  const body = {
    title: $('mTitle').value,
    assignee: $('mAssignee').value.trim(),
    department: $('mDept').value,
    priority: $('mPriority').value || 'Medium',
    due: $('mDue').value,
    hours: $('mHours').value,
    recur: $('mRecur').value,
    loggedMinutes: $('mLogged').value !== '' ? Math.max(0, Number($('mLogged').value) || 0) * 60 : undefined,
    outcome: $('mOutcome').value,
    acceptance: $('mAC').value,
    tags: [...draftTags],
    customValues: collectCustomValues(),
  };
  if (!body.title.trim()) { toast('Task name is required', true); return; }
  try {
    if (editingTaskId != null) {
      await api(`/api/tasks/${editingTaskId}`, { method: 'PATCH', body });
    } else {
      body.column_id = targetColumnId;
      await api('/api/tasks', { method: 'POST', body });
    }
    closeModal('taskModal');
    toast('Task saved');
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteTask() {
  if (editingTaskId == null) return;
  if (!confirm('Delete this task? This cannot be undone.')) return;
  try {
    await api(`/api/tasks/${editingTaskId}`, { method: 'DELETE' });
    closeModal('taskModal');
    toast('Task deleted');
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- column modal ---------- */
function openColumnNew() {
  if (!canEdit()) return;
  editingColumnId = null;
  $('colTitle').textContent = 'Add Column';
  $('cName').value = '';
  $('cColor').value = '#8b7cff';
  $('cStage').value = 'normal';
  $('cDelete').hidden = true;
  $('cMoveWrap').hidden = true;
  $('cReassign').hidden = true;
  openModal('columnModal');
  $('cName').focus();
}

function openColumnEdit(id) {
  if (!canEdit()) return;
  const col = board.columns.find((c) => c.id === id);
  if (!col) return;
  editingColumnId = id;
  $('colTitle').textContent = 'Edit Column';
  $('cName').value = col.name;
  $('cColor').value = /^#[0-9a-fA-F]{6}$/.test(col.color) ? col.color : '#8b7cff';
  $('cStage').value = ['start', 'done'].includes(col.stage) ? col.stage : 'normal';
  $('cDelete').hidden = false;
  $('cMoveWrap').hidden = false;
  $('cReassign').hidden = true;
  openModal('columnModal');
}

async function saveColumn() {
  const name = $('cName').value.trim();
  if (!name) { toast('Column name is required', true); return; }
  try {
    if (editingColumnId != null) {
      await api(`/api/board-columns/${editingColumnId}`, { method: 'PATCH', body: { name, color: $('cColor').value, stage: $('cStage').value } });
    } else {
      await api('/api/board-columns', { method: 'POST', body: { name, color: $('cColor').value, stage: $('cStage').value } });
    }
    closeModal('columnModal');
    toast('Column saved');
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteColumn() {
  if (editingColumnId == null) return;
  try {
    await api(`/api/board-columns/${editingColumnId}`, { method: 'DELETE' });
    closeModal('columnModal');
    toast('Column deleted');
    await loadBoard();
  } catch (e) {
    if (e.message && e.message.toLowerCase().includes('another column')) {
      showReassign();
    } else if (e.message === 'Move its tasks to another column first') {
      showReassign();
    } else {
      toast(e.message, true);
    }
  }
}

function showReassign() {
  const others = board.columns.filter((c) => c.id !== editingColumnId);
  const sel = $('cReassignTo');
  if (!others.length) {
    sel.innerHTML = '<option value="">No other column exists</option>';
    $('cReassignGo').disabled = true;
  } else {
    $('cReassignGo').disabled = false;
    sel.innerHTML = others.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }
  $('cReassign').hidden = false;
}

async function reassignAndDelete() {
  const to = Number($('cReassignTo').value);
  if (!to) { toast('No target column available', true); return; }
  try {
    await api(`/api/board-columns/${editingColumnId}`, { method: 'DELETE', body: { reassignTo: to } });
    closeModal('columnModal');
    toast('Column deleted, tasks moved');
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

async function moveColumn(dir) {
  if (editingColumnId == null) return;
  const ids = board.columns.map((c) => c.id);
  const i = ids.indexOf(editingColumnId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try {
    await api('/api/board-columns/reorder', { method: 'POST', body: { ids } });
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- settings modal ---------- */
function renderListEditor(el, items, onRemove) {
  el.innerHTML = items.length
    ? items.map((x, i) => `<div class="list-row"><span class="grow">${esc(x)}</span><button class="mini-del" type="button" data-i="${i}">×</button></div>`).join('')
    : '<div class="list-row" style="color:#9aa0af">Nothing yet</div>';
  el.querySelectorAll('.mini-del').forEach((b) => {
    b.onclick = () => onRemove(Number(b.dataset.i));
  });
}

function openSettings() {
  if (!canEdit()) return;
  const s = board.settings;
  $('sWorkspace').value = s.workspace_name;
  $('sBoard').value = s.board_name;
  $('sSprint').value = s.sprint_name;
  $('sStart').value = s.sprint_start;
  $('sEnd').value = s.sprint_end;
  $('sHrsDay').value = s.work_hours_per_day || 6;
  draftDepts = [...s.departments];
  draftPris = [...s.priorities];
  redrawSettingsLists = () => {
    renderListEditor($('sDepts'), draftDepts, (i) => { draftDepts.splice(i, 1); redrawSettingsLists(); });
    renderListEditor($('sPriorities'), draftPris, (i) => { draftPris.splice(i, 1); redrawSettingsLists(); });
  };
  redrawSettingsLists();
  openModal('settingsModal');
}

function addToList(input, arr) {
  const v = input.value.trim();
  if (!v) return;
  if (arr.some((x) => x.toLowerCase() === v.toLowerCase())) { toast('Already in the list', true); return; }
  arr.push(v);
  input.value = '';
  input.focus();
}

async function saveSettings() {
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        workspace_name: $('sWorkspace').value.trim(),
        board_name: $('sBoard').value.trim(),
        sprint_name: $('sSprint').value.trim(),
        sprint_start: $('sStart').value,
        sprint_end: $('sEnd').value,
        work_hours_per_day: Math.max(1, Math.min(24, Number($('sHrsDay').value) || 6)),
        departments: draftDepts,
        priorities: draftPris,
      },
    });
    closeModal('settingsModal');
    toast('Settings saved');
    await loadBoard();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- tags & custom fields modal ---------- */
function openLabels() {
  if (!canEdit()) return;
  renderTagList();
  renderFieldList();
  openModal('labelsModal');
}

function renderTagList() {
  $('tagList').innerHTML = board.tags.length
    ? board.tags.map((t) => `<div class="list-row"><span class="swatch" style="background:${esc(t.color)}"></span><span class="grow">${esc(t.name)}</span><button class="mini-del" type="button" data-id="${t.id}">×</button></div>`).join('')
    : '<div class="list-row" style="color:#9aa0af">No tags yet</div>';
  $('tagList').querySelectorAll('.mini-del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this tag?')) return;
      try {
        await api(`/api/tags/${b.dataset.id}`, { method: 'DELETE' });
        await loadBoard();
        renderTagList();
        toast('Tag deleted');
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function addTag() {
  const name = $('tName').value.trim();
  if (!name) { toast('Tag name is required', true); return; }
  try {
    await api('/api/tags', { method: 'POST', body: { name, color: $('tColor').value } });
    $('tName').value = '';
    await loadBoard();
    renderTagList();
    toast('Tag added');
  } catch (e) { toast(e.message, true); }
}

function renderFieldList() {
  $('fieldList').innerHTML = board.customFields.length
    ? board.customFields.map((f) => `<div class="list-row"><span class="grow">${esc(f.name)} <em style="color:#9aa0af">(${esc(f.type)})</em></span><button class="mini-del" type="button" data-id="${f.id}">×</button></div>`).join('')
    : '<div class="list-row" style="color:#9aa0af">No custom fields yet</div>';
  $('fieldList').querySelectorAll('.mini-del').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this field? Existing values on tasks will be hidden.')) return;
      try {
        await api(`/api/custom-fields/${b.dataset.id}`, { method: 'DELETE' });
        await loadBoard();
        renderFieldList();
        toast('Field deleted');
      } catch (e) { toast(e.message, true); }
    };
  });
}

async function addField() {
  const name = $('cfName').value.trim();
  const type = $('cfType').value;
  if (!name) { toast('Field name is required', true); return; }
  const options = $('cfOptions').value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await api('/api/custom-fields', { method: 'POST', body: { name, type, options } });
    $('cfName').value = '';
    $('cfOptions').value = '';
    await loadBoard();
    renderFieldList();
    toast('Field added');
  } catch (e) { toast(e.message, true); }
}

/* ---------- members modal ---------- */
function openMembers() {
  if (!isAdmin()) return;
  renderInvite();
  renderMembers();
  openModal('membersModal');
}

function renderInvite() {
  $('inviteCode').textContent = board.settings.invite_code || '(not set)';
}

async function regenInvite() {
  try {
    const d = await api('/api/settings/invite-code', { method: 'POST' });
    $('inviteCode').textContent = d.inviteCode;
    toast('New invite code generated');
    await loadBoard();
    renderInvite();
  } catch (e) { toast(e.message, true); }
}

async function copyInvite() {
  const code = $('inviteCode').textContent;
  if (!code || code === '(not set)') { toast('Generate a code first', true); return; }
  try { await navigator.clipboard.writeText(code); toast('Invite code copied'); }
  catch { toast('Could not copy — select the code manually', true); }
}

function renderMembers() {
  $('memList').innerHTML = board.members.map((m) => {
    const self = m.id === board.me.id;
    return `<div class="member-row">
      <span class="avatar">${initials(m.username)}</span>
      <span class="grow">${esc(m.username)}${self ? ' (you)' : ''}</span>
      <input type="number" class="cap-input" data-cap="${m.id}" value="${m.capacity || ''}" min="0" step="0.5" title="Capacity in hours per sprint (leave 0 for 30h/wk default)">
      <select class="dept-input" data-dept="${m.id}" title="Department — used for dept-wise capacity & assignee list">
        <option value="">No dept</option>
        ${(board.settings.departments || []).map((d) => `<option${d === (m.department || '') ? ' selected' : ''}>${esc(d)}</option>`).join('')}
      </select>
      <select data-id="${m.id}"${self ? ' disabled' : ''}>
        ${ROLES.map((r) => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}
      </select>
      ${self ? '' : `<button class="mini-del" type="button" data-del="${m.id}" title="Remove member">×</button>`}
    </div>`;
  }).join('');
  $('memList').querySelectorAll('select').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api(`/api/members/${sel.dataset.id}/role`, { method: 'PATCH', body: { role: sel.value } });
        toast('Role updated');
        await loadBoard();
      } catch (e) {
        toast(e.message, true);
        await loadBoard().catch(() => {});
      }
    };
  });
  $('memList').querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const name = (board.members.find((m) => m.id === Number(b.dataset.del)) || {}).username || 'this member';
      if (!confirm(`Remove ${name} from the workspace?`)) return;
      try {
        await api(`/api/members/${b.dataset.del}`, { method: 'DELETE' });
        toast('Member removed');
        await loadBoard();
      } catch (e) { toast(e.message, true); }
    };
  });
  $('memList').querySelectorAll('[data-cap]').forEach((inp) => {
    inp.onchange = async () => {
      const cap = Math.max(0, Number(inp.value) || 0);
      try {
        await api(`/api/members/${inp.dataset.cap}/capacity`, { method: 'PATCH', body: { capacity: cap } });
        toast('Capacity updated');
        await loadBoard();
      } catch (e) {
        toast(e.message, true);
        await loadBoard().catch(() => {});
      }
    };
  });
  $('memList').querySelectorAll('[data-dept]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api(`/api/members/${sel.dataset.dept}/department`, { method: 'PATCH', body: { department: sel.value } });
        toast('Department updated');
        await loadBoard();
      } catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------- capacity & reports ---------- */
let holidayDraft = [];

function openReports() {
  $('sidebar').classList.remove('open');
  loadReports().catch((e) => toast(e.message, true));
}

function optCls(u) { return u > 100 ? 'ov' : u >= 80 ? 'wk' : 'ok'; }
function pctCell(u) {
  const res = Math.min(100, u);
  return `<div style="display:flex;align-items:center;gap:6px">
    <span class="${optCls(u)}" style="min-width:38px;font-weight:650">${u}%</span>
    <div class="cap-bar ${u > 100 ? 'over' : u >= 80 ? 'warn' : ''}" style="flex:1;margin-top:0"><i style="width:${res}%"></i></div>
  </div>`;
}
function capPills(d) {
  return `Wk ${fmtFull(d.weeklyCap)} · Day ${fmtFull(d.dailyCap)} · Mo ${fmtFull(d.monthlyCap)} · Qtr ${fmtFull(d.quarterlyCap)} · 6mo ${fmtFull(d.halfCap)} · Yr ${fmtFull(d.yearlyCap)}`;
}

async function loadReports() {
  const r = await api('/api/reports');
  const canEditAdmin = isAdmin();
  $('repRange').textContent = canEditAdmin
    ? `holidays: ${r.settings.holidays.length} · ${r.settings.work_hours_per_day}h/day default · capacity & dept editable inline`
    : `holidays: ${r.settings.holidays.length} · ${r.settings.work_hours_per_day}h/day default (view-only)`;
  $('repDepts').querySelector('tbody').innerHTML = r.departments.map((d) => `
    <tr>
      <td><b>${esc(d.name)}</b><br><span class="rm" style="color:var(--muted);font-size:11px">${capPills(d)}</span></td>
      <td>${d.resCount}</td>
      <td>${fmtFull(d.weeklyCap)}</td>
      <td class="${optCls(d.utilization)}">${fmtFull(d.workload)}</td>
      <td>${fmtFull(d.available)}</td>
      <td>${pctCell(d.utilization)}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No team members yet — add them under ☺ Members and set their department</td></tr>';
  $('repMembers').querySelector('tbody').innerHTML = r.members.map((m) => `
    <tr>
      <td><b>${esc(m.username)}</b>${m.override ? ' <span class="week-pill">custom cap</span>' : ''}</td>
      <td>${canEditAdmin ? `<select class="dept-input" data-dept="${m.id}">
        <option value="">No dept</option>
        ${(r.settings.departments || []).map((d) => `<option${d === m.dept ? ' selected' : ''}>${esc(d)}</option>`).join('')}
      </select>` : esc(m.dept)}</td>
      <td>${canEditAdmin
        ? `<input type="number" class="cap-input" data-cap="${m.id}" value="${m.capacity}" min="0" step="0.5" title="Weekly capacity in hours — leave 0 for default (working days × hours/day)">`
        : fmtFull(m.capacity)}</td>
      <td class="${optCls(m.utilization)}">${fmtFull(m.workload)}</td>
      <td>${fmtFull(m.available)}</td>
      <td>${pctCell(m.utilization)}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No members</td></tr>';
  if (canEditAdmin) {
    const tbl = $('repMembers').querySelector('tbody');
    const after = async () => { await loadBoard(); await loadReports().catch(() => {}); };
    tbl.querySelectorAll('[data-dept]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api(`/api/members/${sel.dataset.dept}/department`, { method: 'PATCH', body: { department: sel.value } });
          toast('Department updated');
          after();
        } catch (e) { toast(e.message, true); }
      };
    });
    tbl.querySelectorAll('[data-cap]').forEach((inp) => {
      inp.onchange = async () => {
        const v = Math.max(0, Number(inp.value) || 0);
        try {
          await api(`/api/members/${inp.dataset.cap}/capacity`, { method: 'PATCH', body: { capacity: v } });
          toast('Capacity updated');
          after();
        } catch (e) { toast(e.message, true); }
      };
    });
  }
  const today = new Date();
  $('repWeeks').querySelector('tbody').innerHTML = r.weeks.map((w) => {
    const cur = today >= new Date(w.start + 'T00:00:00') && today <= new Date(w.end + 'T00:00:00');
    const cols = Object.keys(w.colHours).map((n) => {
      const col = r.columns.find((c) => c.name === n);
      return `<span class="week-pill"${col ? ` style="background:${esc(col.color)}22"` : ''}>${esc(n)}: ${w.colHours[n]}</span>`;
    }).join('');
    return `<tr>
      <td><b>${fmtWeekDay(new Date(w.start + 'T00:00:00'))} – ${fmtWeekDay(new Date(w.end + 'T00:00:00'))}</b>${cur ? ' <span class="week-pill" style="background:var(--purple);color:#fff">now</span>' : ''}
        ${w.holidaysInWeek.length ? `<br><span class="rm" style="color:var(--muted);font-size:10.5px">holidays: ${w.holidaysInWeek.join(', ')}</span>` : ''}</td>
      <td>${fmtFull(w.weeklyCap)}</td>
      <td class="${optCls(w.utilization)}">${fmtFull(w.workload)}</td>
      <td>${fmtFull(w.available)}</td>
      <td>${pctCell(w.utilization)}</td>
      <td>${cols || '—'}</td>
    </tr>`;
  }).join('');
  $('repSprints').querySelector('tbody').innerHTML = r.sprints.map((s) => `
    <tr>
      <td><b>${esc(s.name)}</b><br><span class="rm" style="color:var(--muted);font-size:11px">${s.start || '—'} → ${s.end || 'now'}</span></td>
      <td>${fmtFull(s.plannedHours)}</td>
      <td>${fmtFull(s.actualHours)}</td>
      <td class="${s.velocity == null ? '' : optCls(s.velocity)}">${s.velocity == null ? '—' : s.velocity + '%'}</td>
      <td>${s.spilled}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No completed sprint yet — End the current sprint to record history &amp; velocity</td></tr>';
  $('repRecur').innerHTML = r.recurringTasks.length
    ? r.recurringTasks.map((t) => `<div class="rr">
      <span><b>${esc(t.title)}</b><span class="rm"> · ${esc(t.assignee || 'unassigned')}</span></span>
      <span class="rm">${esc(t.recurLabel)} · next ${t.nextDue} · done ${t.completions}×</span>
    </div>`).join('')
    : '<div style="color:var(--muted);font-size:12.5px">No recurring tasks — set a recurrence in task edit</div>';
  holidayDraft = [...r.settings.holidays];
  renderHolidays();
  openModal('reportsModal');
}

function renderHolidays() {
  const can = canEdit();
  $('repHolidays').innerHTML = holidayDraft.length
    ? holidayDraft.map((h, i) => `<div class="list-row"><span class="grow">${esc(h)}</span>${can ? `<button class="mini-del" type="button" data-i="${i}">×</button>` : ''}</div>`).join('')
    : '<div class="list-row" style="color:#9aa0af">None — add holidays so capacity auto-adjusts that week</div>';
  $('repHolidays').querySelectorAll('.mini-del').forEach((b) => {
    b.onclick = async () => {
      holidayDraft.splice(Number(b.dataset.i), 1);
      renderHolidays();
      await saveHolidays();
    };
  });
  $('repHolidayAdd').style.display = can ? '' : 'none';
  $('repHolidayNew').style.display = can ? '' : 'none';
}

async function saveHolidays() {
  try {
    await api('/api/settings', { method: 'PATCH', body: { holidays: holidayDraft } });
    await loadBoard();
  } catch (e) { toast(e.message, true); }
}

/* ---------- sprint calendar ---------- */
function fmtWeekDay(d) {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
function mondayOf(d) {
  const x = d instanceof Date ? new Date(d) : new Date(String(d) + 'T00:00:00');
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isoWeekNo(d) {
  const mon = mondayOf(d);
  const thur = new Date(mon);
  thur.setDate(thur.getDate() + 3);
  const jan1 = new Date(thur.getFullYear(), 0, 1);
  return Math.ceil((((thur - jan1) / 86400000) + jan1.getDay() + 1) / 7);
}

function openCalendar() {
  renderCalendar();
  openModal('calendarModal');
}

function calTaskHtml(t, idx) {
  const doneId = board.columns.some((c) => c.stage === 'done')
    ? board.columns.find((c) => c.stage === 'done').id : -1;
  const done = t.column_id === doneId;
  return `<div class="cal-task" data-id="${t.id}">
    <span class="idx">${idx}</span>
    <span class="tinfo"><b>${esc(t.title)}${done ? '<span class="cal-inside">done</span>' : ''}</b>
      <span class="tmeta">
        <span class="dot" style="background:${esc(prioColor(t.priority))}"></span>
        ${t.assignee ? `${esc(t.assignee)}` : ''}
        ${t.due ? fmtWeekDay(new Date(t.due + 'T00:00:00')) : ''}
        ${t.hours ? `<span class="tag">${esc(t.hours)}</span>` : ''}
        ${t.cycleMinutes != null ? `<span class="tag">↺ ${fmtCycle(t.cycleMinutes)}</span>` : ''}
      </span>
    </span>
  </div>`;
}

function renderCalendar() {
  const todayMonday = mondayOf(new Date());
  const grouped = new Map();
  const unscheduled = [];
  for (const t of board.tasks) {
    if (!t.due) { unscheduled.push(t); continue; }
    const mon = mondayOf(t.due);
    const key = dayKey(mon);
    if (!grouped.has(key)) grouped.set(key, { mon, tasks: [] });
    grouped.get(key).tasks.push(t);
  }
  const weeks = [...grouped.values()].sort((a, b) => a.mon - b.mon);

  const curr = new Date();
  $('calRange').textContent = 'Today: ' + curr.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

  let html = weeks.map((w) => {
    const sun = new Date(w.mon);
    sun.setDate(sun.getDate() + 6);
    const cur = w.mon.getTime() === todayMonday.getTime();
    const hrs = Math.round(w.tasks.reduce((s, t) => s + hoursOf(t), 0) * 10) / 10;
    const tasks = [...w.tasks].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    return `<div class="cal-week${cur ? ' cal-current' : ''}">
      <div class="cal-week-head">
        <span>${fmtWeekDay(w.mon)} – ${fmtWeekDay(sun)}</span>
        <span class="cal-w">W${isoWeekNo(w.mon)}</span>
        <span class="cal-h">${fmtFull(hrs)}</span>
      </div>
      ${tasks.map((t, i) => calTaskHtml(t, i + 1)).join('')}
    </div>`;
  }).join('');

  if (unscheduled.length) {
    const hrs = Math.round(unscheduled.reduce((s, t) => s + hoursOf(t), 0) * 10) / 10;
    html += `<div class="cal-week">
      <div class="cal-week-head"><span>Unscheduled</span><span class="cal-h">${fmtFull(hrs)}</span></div>
      ${unscheduled.map((t, i) => calTaskHtml(t, '•')).join('')}
    </div>`;
  }

  if (!html) html = '<div class="cal-empty">No tasks yet — add tasks with a due date to plan week-wise.</div>';
  $('calWeeks').innerHTML = html;
  $('calWeeks').querySelectorAll('.cal-task').forEach((el) => {
    el.onclick = () => {
      closeModal('calendarModal');
      openTaskView(Number(el.dataset.id));
    };
  });
}

/* ---------- sprint ---------- */
async function toggleSprint() {
  if (!canEdit()) return;
  const on = !board.settings.sprint_active;
  try {
    await api('/api/settings', { method: 'PATCH', body: { sprint_active: on } });
    await loadBoard();
    toast(on ? 'Sprint started' : 'Sprint ended');
  } catch (e) { toast(e.message, true); }
}

/* ---------- auth & app shell ---------- */
function showAuth() {
  $('app').hidden = true;
  $('authScreen').hidden = false;
  $('sidebar').classList.remove('open');
  if (socket) { socket.disconnect(); socket = null; }
}

async function showApp() {
  $('authScreen').hidden = true;
  $('app').hidden = false;
  connectSocket();
}

function connectSocket() {
  if (socket || typeof io === 'undefined') return;
  socket = io();
  socket.on('board:changed', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => loadBoard().catch(() => {}), 150);
  });
  socket.on('connect_error', () => {});
}

function setAuthMode(mode) {
  authMode = mode;
  $('tabLogin').classList.toggle('active', mode === 'login');
  $('tabRegister').classList.toggle('active', mode === 'register');
  $('authSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('authInviteWrap').style.display = mode === 'register' ? '' : 'none';
  $('inviteHint').textContent = mode === 'register' ? '(required for new members)' : '';
  $('authError').textContent = '';
}

async function handleAuth(e) {
  e.preventDefault();
  $('authError').textContent = '';
  try {
    const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const body = { username: $('authUser').value, password: $('authPass').value };
    if (path.endsWith('register')) body.inviteCode = $('authInvite').value.trim();
    const d = await api(path, { method: 'POST', body });
    $('authPass').value = '';
    toast(`Welcome, ${d.user.username}`);
    await loadBoard();
    await showApp();
  } catch (err) {
    $('authError').textContent = err.message;
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  showAuth();
}

/* ---------- init ---------- */
function bindEvents() {
  setAuthMode('login');
  $('tabLogin').onclick = () => setAuthMode('login');
  $('tabRegister').onclick = () => setAuthMode('register');
  $('authForm').onsubmit = handleAuth;
  $('logoutBtn').onclick = logout;
  $('menuToggle').onclick = () => $('sidebar').classList.toggle('open');
  $('navBoard').onclick = () => { backlogMode = false; $('navBoard').classList.add('active'); $('navBacklog').classList.remove('active'); $('sidebar').classList.remove('open'); renderColumns(); };
  $('navBacklog').onclick = toggleBacklog;
  $('navSettings').onclick = openSettings;
  $('navLabels').onclick = openLabels;
  $('navMembers').onclick = openMembers;
  $('navCalendar').onclick = () => { $('sidebar').classList.remove('open'); openCalendar(); };
  $('calClose').onclick = () => closeModal('calendarModal');
  $('navReports').onclick = openReports;
  $('repClose').onclick = () => closeModal('reportsModal');
  $('repHolidayAdd').onclick = async () => {
    const v = $('repHolidayNew').value;
    if (!v) { toast('Pick a date first', true); return; }
    if (holidayDraft.includes(v)) { toast('Already added', true); return; }
    holidayDraft.push(v);
    $('repHolidayNew').value = '';
    renderHolidays();
    await saveHolidays();
  };
  $('mDept').onchange = () => fillAssigneeList($('mDept').value);
  $('btnNewTask').onclick = () => openTaskNew(null);
  $('btnSprint').onclick = toggleSprint;
  $('btnClear').onclick = () => {
    $('search').value = '';
    $('fAssignee').value = '';
    $('fPriority').value = '';
    $('fDept').value = '';
    $('fTag').value = '';
    renderColumns();
  };
  $('search').oninput = renderColumns;
  ['fAssignee', 'fPriority', 'fDept', 'fTag'].forEach((id) => { $(id).onchange = renderColumns; });

  $('mSave').onclick = saveTask;
  $('mDelete').onclick = deleteTask;
  $('mCancel').onclick = () => closeModal('taskModal');
  $('mTags').onclick = (e) => {
    const chip = e.target.closest('[data-tag]');
    if (!chip || !canEdit()) return;
    const id = Number(chip.dataset.tag);
    if (draftTags.has(id)) draftTags.delete(id);
    else draftTags.add(id);
    chip.classList.toggle('on');
  };

  $('cSave').onclick = saveColumn;
  $('cDelete').onclick = deleteColumn;
  $('cCancel').onclick = () => closeModal('columnModal');
  $('cLeft').onclick = () => moveColumn(-1);
  $('cRight').onclick = () => moveColumn(1);
  $('cReassignGo').onclick = reassignAndDelete;

  $('sSave').onclick = saveSettings;
  $('sCancel').onclick = () => closeModal('settingsModal');
  $('sDeptAdd').onclick = () => { addToList($('sDeptNew'), draftDepts); if (redrawSettingsLists) redrawSettingsLists(); };
  $('sDeptNew').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('sDeptAdd').click(); } };
  $('sPriAdd').onclick = () => { addToList($('sPriNew'), draftPris); if (redrawSettingsLists) redrawSettingsLists(); };
  $('sPriNew').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('sPriAdd').click(); } };

  $('tAdd').onclick = addTag;
  $('tName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
  $('cfType').onchange = () => { $('cfOptionsWrap').hidden = $('cfType').value !== 'select'; };
  $('cfAdd').onclick = addField;
  $('lbClose').onclick = () => closeModal('labelsModal');
  $('memClose').onclick = () => closeModal('membersModal');
  $('inviteRegen').onclick = regenInvite;
  $('inviteCopy').onclick = copyInvite;

  document.querySelectorAll('.modal-back').forEach((back) => {
    back.addEventListener('mousedown', (e) => { if (e.target === back) back.classList.remove('show'); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-back.show').forEach((m) => m.classList.remove('show'));
  });

  bindBoard();
}

async function init() {
  bindEvents();
  fillHours();
  setInterval(() => {
    document.querySelectorAll('.timelive').forEach((el) => {
      el.textContent = '⏱ ' + fmtElapsed(Number(el.dataset.live), Date.now() / 1000);
    });
    const cycEl = $('mCycle');
    if (cycEl && !cycEl.hidden && cycEl.dataset.live) {
      const b = cycEl.querySelector('b[data-idx]');
      if (b) b.textContent = fmtElapsed(Number(cycEl.dataset.live), Date.now() / 1000);
    }
  }, 1000);
  try {
    await loadBoard();
    await showApp();
  } catch {
    showAuth();
  }
}

init();
