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
let editingSprintId = null;

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function initials(n) {
  return (n || '').split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase() || '?';
}
function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
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
  $('whoami').innerHTML = esc(board.me.username) + `<span class="role-chip">${esc(board.me.role)}</span>`;
  $('btnNewTask').hidden = !canEdit();
  $('btnNewSprint').hidden = !canEdit();
  $('btnSprint').hidden = !canEdit();
  $('btnSprintEdit').hidden = !canEdit();
  $('navSettings').hidden = !canEdit();
  $('navLabels').hidden = !canEdit();
  $('navMembers').hidden = !isAdmin();
  renderSprintControl();
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
  const active = caps.filter((c) => c.workload > 0);
  const hasData = active.length > 0;
  $('capacityWrap').hidden = !hasData;
  if (!hasData) return;
  const totCap = caps.reduce((s, c) => s + c.capacity, 0);
  const totLoad = caps.reduce((s, c) => s + c.workload, 0);
  $('capSummary').textContent = `${fmtFull(totLoad)} of ${fmtFull(totCap)} hrs capacity assigned`;
  $('capacityList').innerHTML = active.map((c) => {
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
  $('capacityList').hidden = false;
  const tog = $('capToggle');
  tog.setAttribute('aria-expanded', 'true');
  tog.textContent = '▾';
  tog.onclick = () => {
    const l = $('capacityList');
    l.hidden = !l.hidden;
    tog.textContent = l.hidden ? '▸' : '▾';
    tog.setAttribute('aria-expanded', String(!l.hidden));
  };
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
  if (t.sprint_id) {
    const cs = (board.settings.sprints || []).find((s2) => s2.id === t.sprint_id);
    if (cs) chips += `<span class="tag sp-chip" title="Planned in ${esc(cs.name)}">${esc(cs.name)}</span>`;
  }
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
  const inBacklog = edit && leftmostCol() && t.column_id === leftmostCol().id;
  return `<div class="card" data-id="${t.id}" ${edit ? 'draggable="true"' : ''}>
    <div class="task-title">${esc(t.title)}</div>
    <div class="meta">${chips}</div>
    <div class="bottom">
      <span class="avatar">${initials(t.assignee)}</span>
      <span>${esc(t.assignee || 'Unassigned')}</span>
      <span class="due">${esc(fmtDue(t.due))}</span>
      ${inBacklog ? `<button class="dot-btn" data-act="task-menu" data-id="${t.id}" type="button" title="Actions">⋮</button>` : ''}
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
    $('columns').innerHTML = `<div class="backlog-title">Sprint Backlog<span>unplanned tasks — plan them into the sprint during planning</span></div>
      <div class="backlog-bar">New tasks land here. Click a card's <b>⋮</b> → <b>Move to new sprint</b> and it lands in your sprint board's <i>To Do</i> column.</div>
      <div class="column backlog-col" data-col="${blk.id}">
        <div class="col-head">
          <span class="dot" style="background:${esc(blk.color)}"></span>
          <span class="col-name">${esc(blk.name)}</span>
          <span class="count">${arr.length}</span>
          ${edit ? `<button class="col-edit" data-act="col-menu" data-col="${blk.id}" title="Edit column: name / colour / position">✎</button>` : ''}
          ${edit ? `<button class="col-edit" data-act="sprint-all" title="Move all to current sprint">⤴ Move all</button>` : ''}
        </div>
        <div class="cards">${arr.length ? arr.map(cardHtml).join('') : '<div class="empty">Backlog is empty — create a task with ＋ New Task</div>'}</div>
        ${edit ? `<button class="add" data-act="add-card" data-col="${blk.id}">＋ New Task</button>` : ''}
      </div>`;
    return;
  }
  const flow = board.columns.slice().sort((a, b) => a.position - b.position);
  if (leftmostCol()) flow.shift();
  let html = flow.map((col) => {
    const arr = list.filter((t) => t.column_id === col.id);
    return `<div class="column" data-col="${col.id}">
      <div class="col-head">
        <span class="dot" style="background:${esc(col.color)}"></span>
        <span class="col-name">${esc(col.name)}</span>
        ${col.stage === 'start' ? `<span class="stage-mark" title="Start column — cycle time starts here" style="color:${esc(col.color)}">▶</span>` : ''}
        ${col.stage === 'done' ? `<span class="stage-mark" title="Done column — cycle time ends here" style="color:${esc(col.color)}">●</span>` : ''}
        <span class="count">${arr.length}</span>
        ${edit ? `<button class="col-edit" data-act="col-menu" data-col="${col.id}" title="Edit column: name / colour / position">✎</button>` : ''}
      </div>
      <div class="cards">${arr.length ? arr.map(cardHtml).join('') : '<div class="empty">Drop tasks here</div>'}</div>
    </div>`;
  }).join('');
  if (edit) {
    html += `<div class="add-col-slot"><button class="add" data-act="add-col">＋ Add column</button></div>`;
  }
  const bl = leftmostCol();
  const backlogN = bl ? list.filter((t) => t.column_id === bl.id).length : 0;
  if (backlogN) {
    html = `<div class="backlog-note"><b>${backlogN}</b> task${backlogN === 1 ? '' : 's'} waiting in <b>Sprint Backlog</b> — <button type="button" data-act="go-backlog">open backlog</button></div>` + html;
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
      if (kind === 'go-backlog') { toggleBacklog(); return; }
      if (kind === 'to-sprint') { e.stopPropagation(); moveToSprint(Number(act.closest('.card').dataset.id)); return; }
      if (kind === 'task-menu') { e.stopPropagation(); openTaskMenu(act); return; }
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

function closeTaskMenu() {
  document.querySelectorAll('.task-menu-pop').forEach((el) => el.remove());
}

function openTaskMenu(btn) {
  closeTaskMenu();
  const id = Number(btn.dataset.id);
  const r = btn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'task-menu-pop';
  menu.innerHTML = `<button type="button" data-move="${id}">Move to new sprint</button>`;
  menu.style.top = `${Math.min(r.bottom + 5, window.innerHeight - 48)}px`;
  menu.style.left = `${Math.max(8, r.left)}px`;
  document.body.appendChild(menu);
  menu.querySelector('[data-move]').onclick = () => {
    closeTaskMenu();
    moveToSprint(id);
  };
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.task-menu-pop') && !e.target.closest('.dot-btn')) closeTaskMenu();
});

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
      <input type="number" class="cap-input" data-cap="${m.id}" value="${m.dailyCap || ''}" min="0" step="0.5" title="Daily capacity (hours/day) — leave 0 for the work-hours/day default">
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
        await api(`/api/employees/${inp.dataset.cap}`, { method: 'PATCH', body: { daily_capacity: cap } });
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

/* ---------- employees (team sheet) ---------- */
let empData = { rows: [], totals: {}, departments: [], workDays: 5 };

function openEmployees() {
  if ($('employeesModal').classList.contains('show')) { closeModal('employeesModal'); return; }
  $('sidebar').classList.remove('open');
  loadEmployees().catch((e) => toast(e.message, true));
}

function empDatalist() {
  const names = (empData.rows || []).map((r) => r.name).map(esc).join('\n');
  let dl = $('empManagers');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'empManagers';
    document.body.appendChild(dl);
  }
  dl.innerHTML = names;
}

async function loadEmployees() {
  empData = await api('/api/employees');
  empDatalist();
  const t = empData.totals || {};
  $('empRange').textContent = isAdmin() ? 'editable · auto-saves' : 'view only';
  $('empSummary').innerHTML = `
    <div class="emp-sum"><b>${t.people || 0}</b><span>active people</span></div>
    <div class="emp-sum"><b>${fmtFull(t.capacity)}</b><span>capacity this week</span></div>
    <div class="emp-sum"><b>${fmtFull(t.workload)}</b><span>planned workload</span></div>
    <div class="emp-sum"><b>${fmtFull(t.available)}</b><span>available</span></div>
    <div class="emp-sum"><b class="${t.utilization > 100 ? 'ov' : t.utilization >= 80 ? 'wk' : 'ok'}">${t.utilization || 0}%</b><span>utilisation</span></div>
    <div class="emp-sum rm"><b>${empData.workDays}</b><span>working days this week</span></div>`;
  const can = isAdmin();
  $('empTable').querySelector('tbody').innerHTML = empData.rows.map((r) => {
    const depOpts = '<option value="">No dept</option>' + empData.departments.map((d) => `<option${d === r.department ? ' selected' : ''}>${esc(d)}</option>`).join('');
    const idv = `data-id="${r.id}"`;
    return `<tr class="${r.isActive ? '' : 'inactive-row'}">
      <td>${can ? `<input class="emp-in emp-id" data-f="employeeId" ${idv} value="${esc(r.employeeId)}" title="Employee ID">` : esc(r.employeeId)}</td>
      <td>${can ? `<input class="emp-in" data-f="name" ${idv} value="${esc(r.name)}" title="Employee name (updates on tasks too)" list="empManagers">` : `<b>${esc(r.name)}</b>`}</td>
      <td>${can ? `<select class="dept-input" data-f="department" ${idv}>${depOpts}</select>` : esc(r.department)}</td>
      <td>${can ? `<input class="emp-in" data-f="title" ${idv} value="${esc(r.title)}" title="Role">` : esc(r.title)}</td>
      <td>${can ? `<input class="emp-in" data-f="manager" ${idv} value="${esc(r.manager)}" list="empManagers" title="Manager">` : esc(r.manager)}</td>
      <td>${can ? `<input type="number" class="emp-in emp-num" data-f="daily_capacity" ${idv} value="${r.dailyCap}" min="0" max="24" step="0.5" title="Hours per day">` : r.dailyCap}</td>
      <td>${fmtFull(r.weeklyCap)}</td>
      <td class="${r.over ? 'ov' : r.utilization >= 80 ? 'wk' : 'ok'}">${fmtFull(r.workload)}</td>
      <td>${fmtFull(r.available)}</td>
      <td>${pctCell(r.utilization)}</td>
      <td class="emp-flag">${can
        ? `<input type="checkbox" class="emp-active" data-f="is_active" ${idv} ${r.isActive ? 'checked' : ''} title="Active (can log in)">
           <span class="${r.isActive ? 'on' : 'off'}">${r.isActive ? 'Yes' : 'No'}</span>`
        : (r.isActive ? 'Yes' : 'No')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" style="color:var(--muted)">No employees yet — click "+ Add employee" to build your team sheet</td></tr>';
  $('empTable').querySelector('tbody').onchange = async (ev) => {
    const el = ev.target.closest('[data-f]');
    if (!el) return;
    let payload;
    if (el.dataset.f === 'is_active') payload = { is_active: el.checked };
    else if (el.dataset.f === 'daily_capacity') payload = { daily_capacity: Math.max(0, Number(el.value) || 0) };
    else payload = { [el.dataset.f]: el.value.trim() };
    if (el.dataset.f !== 'is_active' && el.tagName === 'INPUT' && !el.value.trim()) el.value = el.dataset.prev || '';
    try {
      await api(`/api/employees/${el.dataset.id}`, { method: 'PATCH', body: payload });
      toast('Saved — recalculating');
      await loadAfterEdit();
    } catch (e) {
      toast(e.message, true);
      await loadAfterEdit();
    }
  };
  openModal('employeesModal');
}

async function loadAfterEdit() {
  try { await Promise.all([loadBoard(), loadEmployees()]); } catch {}
}

function openEmpAdd() {
  $('eaDept').innerHTML = '<option value="">No dept</option>' + (empData.departments || []).map((d) => `<option>${esc(d)}</option>`).join('');
  openModal('empAddModal');
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
  $('repSprints').querySelector('tbody').innerHTML = [...r.sprints].reverse().map((s) => `
    <tr>
      <td><span class="week-pill sr-pill-${s.status}">${s.status}</span></td>
      <td><b>${esc(s.name)}</b><br><span class="rm" style="color:var(--muted);font-size:11px">${s.start || '—'} → ${s.end || 'now'}</span></td>
      <td>${s.done} / ${s.open}</td>
      <td>${fmtFull(s.plannedHours)}</td>
      <td>${fmtFull(s.actualHours)}</td>
      <td class="${s.velocity == null ? '' : optCls(s.velocity)}">${s.velocity == null ? '—' : s.velocity + '%'}</td>
      <td>${s.spilled}</td>
    </tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted)">No sprints yet — create one from the top bar</td></tr>';
  $('repRecur').innerHTML = r.recurringTasks.length
    ? r.recurringTasks.map((t) => `<div class="rr">
      <span><b>${esc(t.title)}</b><span class="rm"> · ${esc(t.assignee || 'unassigned')}</span></span>
      <span class="rm">${esc(t.recurLabel)} · next ${t.nextDue} · done ${t.completions}×</span>
    </div>`).join('')
    : '<div style="color:var(--muted);font-size:12.5px">No recurring tasks — set a recurrence in task edit</div>';
  holidayDraft = [...r.settings.holidays];
  renderHolidays();
  renderSprintReport(r);
  openModal('reportsModal');
}

/* ---------- sprint report charts ---------- */
let srData = [];

function renderSprintReport(r) {
  srData = r.sprints || [];
  const sel = $('srSprintSel');
  sel.innerHTML = srData.map((s) => {
    const label = s.start
      ? `${s.name} · ${s.status} (${s.start} → ${s.end || 'now'})`
      : `${s.name} · ${s.status}`;
    return `<option value="${s.id}">${esc(label)}</option>`;
  }).join('');
  const active = srData.find((x) => x.status === 'active');
  const def = active || srData[srData.length - 1];
  sel.onchange = () => renderSprintCharts(Number(sel.value));
  renderSprintCharts(def ? Number(def.id) : null);
}

function taskRow(t) {
  return `<div class="sr-task"><span class="grow"><b>${esc(t.title)}</b><span class="rm"> · ${esc(t.assignee || 'unassigned')}</span></span><span class="rm">${t.column ? esc(t.column) + ' · ' : ''}${fmtFull(t.hours)}</span></div>`;
}

function renderTrend(completed) {
  if (!completed.length) return '<p class="sr-empty">No completed sprint yet — end a sprint to see the trend.</p>';
  const max = Math.max(1, ...completed.map((x) => Math.max(x.plannedHours, x.actualHours)));
  return `<div class="sr-tgrid">${completed.map((x) => `
    <div class="sr-tcol" title="${esc(x.name)}">
      <div class="sr-tbars">
        <i class="sr-tbar sr-tplan" style="height:${Math.round((x.plannedHours / max) * 100)}%"></i>
        <i class="sr-tbar sr-tact" style="height:${Math.round((x.actualHours / max) * 100)}%"></i>
      </div>
      <div class="sr-tlab">${esc(x.name)}</div>
      <div class="sr-tmeta">${x.done}/${x.total}${x.velocity != null ? ' · ' + x.velocity + '%' : ''}</div>
    </div>`).join('')}
  </div>`;
}

function renderSprintCharts(id) {
  const s = srData.find((x) => x.id === id);
  $('srDonut').innerHTML = '';
  $('srMembers').innerHTML = '';
  $('srCapacity').innerHTML = '';
  $('srTrend').innerHTML = '';
  $('srDoneList').innerHTML = '';
  $('srOpenList').innerHTML = '';
  if (!s) {
    $('srDonut').innerHTML = '<p class="sr-empty">No sprints yet — create one from the top bar.</p>';
    return;
  }
  const donePct = s.donePct ?? 0;
  $('srDonut').innerHTML = `<div class="donut" style="--p:${donePct}%">
    <div class="donut-hole"><b>${donePct}%</b><span>complete</span><em>${s.done} done · ${s.open} open</em></div>
  </div>`;
  const doneCls = s.total > 0 && s.done === s.total ? 'sup' : '';
  const mrows = s.byAssignee.length ? s.byAssignee.map((m) => {
    const mp = m.total ? Math.round((m.done / m.total) * 100) : 0;
    return `<div class="sr-mrow">
      <span class="sr-mname">${esc(m.username)}</span>
      <div class="sr-mbar"><i class="sr-mdone" style="width:${mp}%"></i></div>
      <span class="sr-mval ${m.done === m.total && m.total > 0 ? 'sup' : ''}">${m.done}/${m.total} · ${fmtFull(m.hours)}</span>
    </div>`;
  }).join('') : '<p class="sr-empty">No tasks assigned to members in this sprint.</p>';
  $('srMembers').innerHTML = `<div class="sr-mlegend"><span><i class="lg lg-done"></i>done</span><span><i class="lg lg-open"></i>open</span></div>${mrows}`;
  const capRows = [
    `<div class="sr-crow sr-ctotal"><span class="sr-mname">Total</span>
      <div class="sr-cbar"><i class="sr-cused" style="width:${s.capacityHours > 0 ? Math.min(100, (s.usedHours / s.capacityHours) * 100) : 0}%"></i></div>
      <span class="sr-mval">${fmtFull(s.usedHours)} / ${fmtFull(s.capacityHours)}${s.utilization == null ? '' : ' · ' + s.utilization + '%'}</span></div>`,
    ...s.byAssignee.map((m) => {
      const w = m.cap > 0 ? Math.min(100, (m.hours / m.cap) * 100) : 0;
      return `<div class="sr-crow"><span class="sr-mname">${esc(m.username)}</span>
        <div class="sr-cbar"><i class="sr-cused" style="width:${w}%"></i></div>
        <span class="sr-mval">${fmtFull(m.hours)} / ${fmtFull(m.cap)}${m.utilization == null ? '' : ' · ' + m.utilization + '%'}</span></div>`;
    }),
  ];
  $('srCapacity').innerHTML = capRows.join('');
  $('srTrend').innerHTML = renderTrend(srData.filter((x) => x.status === 'complete'));
  $('srDoneList').innerHTML = s.doneTasks.length ? s.doneTasks.map(taskRow).join('') : '<p class="sr-empty">Nothing completed in this sprint yet.</p>';
  $('srOpenList').innerHTML = s.openTasks.length ? s.openTasks.map(taskRow).join('') : '<p class="sr-empty">All tasks in this sprint are done!</p>';
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
  const weeksMap = new Map();
  const getWeek = (mon) => {
    const k = dayKey(mon);
    if (!weeksMap.has(k)) weeksMap.set(k, { mon, days: {} });
    return weeksMap.get(k);
  };
  getWeek(todayMonday);
  const unscheduled = [];
  for (const t of board.tasks) {
    if (!t.due) { unscheduled.push(t); continue; }
    const w = getWeek(mondayOf(t.due));
    (w.days[t.due] = w.days[t.due] || []).push(t);
  }
  const weeks = [...weeksMap.values()].sort((a, b) => a.mon - b.mon);

  const curr = new Date();
  $('calRange').textContent = 'Today: ' + curr.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

  let html = weeks.map((w) => {
    const cur = w.mon.getTime() === todayMonday.getTime();
    const hrs = Math.round(Object.keys(w.days).reduce((s, k) => s + w.days[k].reduce((a, t) => a + hoursOf(t), 0), 0) * 10) / 10;
    let cells = '';
    for (let i = 0; i < 5; i++) {
      const d = addDays(w.mon, i);
      const k = dayKey(d);
      const tasks = (w.days[k] || []).slice().sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
      const today = k === dayKey(curr);
      const dayHrs = Math.round(tasks.reduce((s, t) => s + hoursOf(t), 0) * 10) / 10;
      cells += `<div class="cal-day${today ? ' cal-today' : ''}">
        <div class="cal-day-head">${fmtWeekDay(d)}<i>${tasks.length ? fmtFull(dayHrs) : ''}</i></div>
        ${tasks.length ? tasks.map((t) =>
          `<div class="cal-task" data-id="${t.id}" title="${esc(t.title)}"><b>${esc(t.title)}</b><span class="rm">${t.assignee ? esc(t.assignee) : ''}${t.hours ? ' · ' + esc(t.hours) : ''}</span></div>`
        ).join('') : '<div class="cal-empty">—</div>'}
      </div>`;
    }
    return `<div class="cal-week${cur ? ' cal-current' : ''}">
      <div class="cal-week-head">
        <span><b>${fmtWeekDay(w.mon)}</b> – ${fmtWeekDay(addDays(w.mon, 4))} · Mon–Fri</span>
        <span class="cal-w">W${isoWeekNo(w.mon)}</span>
        <span class="cal-h">${fmtFull(hrs)}</span>
      </div>
      <div class="cal-week-days">${cells}</div>
    </div>`;
  }).join('');

  if (unscheduled.length) {
    const hrs = Math.round(unscheduled.reduce((s, t) => s + hoursOf(t), 0) * 10) / 10;
    html += `<div class="cal-week">
      <div class="cal-week-head"><span>Unscheduled</span><span class="cal-h">${fmtFull(hrs)}</span></div>
      <div class="cal-week-days">
        <div class="cal-day cal-day-full">${unscheduled.map((t) =>
          `<div class="cal-task" data-id="${t.id}" title="${esc(t.title)}"><b>${esc(t.title)}</b><span class="rm">${t.assignee ? esc(t.assignee) : ''}${t.hours ? ' · ' + esc(t.hours) : ''}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  if (!html) html = '<div class="cal-empty">No tasks yet — add tasks with a due date to plan week-wise (Mon–Fri).</div>';
  $('calWeeks').innerHTML = html;
  $('calWeeks').querySelectorAll('.cal-task').forEach((el) => {
    el.onclick = () => {
      closeModal('calendarModal');
      openTaskView(Number(el.dataset.id));
    };
  });
}

/* ---------- sprints ---------- */
function currentSprint() {
  const id = Number($('sprintSelect').value) || 0;
  return (board.settings.sprints || []).find((s2) => s2.id === id) || null;
}

let applyTimer = null;
function applyActive(id) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    api(`/api/sprints/${id}`, { method: 'PATCH', body: { select: true } })
      .then(() => loadBoard())
      .catch((e) => toast(e.message, true));
  }, 400);
}

function renderSprintControl() {
  const sprints = board.settings.sprints || [];
  const active = Number(board.settings.active_sprint_id) || 0;
  let cur = Number($('sprintSelect').value) || 0;
  if (!sprints.some((s2) => s2.id === cur)) {
    const pick = sprints.find((s2) => s2.id === active)
      || sprints.find((s2) => s2.status !== 'complete')
      || sprints[0];
    cur = pick ? pick.id : 0;
  }
  $('sprintSelect').innerHTML = sprints.length
    ? sprints.map((s2) => `<option value="${s2.id}"${s2.id === cur ? ' selected' : ''}>${esc(s2.name)}${s2.status === 'complete' ? ' ✓' : s2.status === 'active' ? ' ●' : ''}</option>`).join('')
    : '<option value="0">No sprint yet</option>';
  const sp = sprints.find((s2) => s2.id === cur) || null;
  const btn = $('btnSprint');
  btn.textContent = !sp ? 'New Sprint'
    : sp.status === 'active' ? 'End Sprint'
    : sp.status === 'complete' ? 'New Sprint'
    : 'Start Sprint';
  btn.disabled = false;
  $('btnSprintEdit').hidden = !canEdit() || !sp || !!$('btnNewSprint').hidden;
  if (!$('btnNewSprint').hidden && !active && sp) applyActive(sp.id);
}

function selectSprint(id) {
  api(`/api/sprints/${id}`, { method: 'PATCH', body: { select: true } })
    .then(() => { toast('Sprint selected'); return loadBoard(); })
    .catch((e) => toast(e.message, true));
}

function defaultSprintDates() {
  const mon = mondayOf(new Date());
  mon.setDate(mon.getDate() + 7);
  return { start: dayKey(mon), end: dayKey(addDays(mon, 4)) };
}

function openSprintModal(sp) {
  if (!canEdit()) return;
  editingSprintId = sp ? sp.id : null;
  $('sprintModalTitle').textContent = sp ? 'Edit Sprint' : 'New Sprint';
  $('spDelete').hidden = !sp || sp.status === 'complete';
  $('spName').value = sp ? sp.name : '';
  const dts = sp ? { start: sp.start, end: sp.end } : defaultSprintDates();
  $('spStart').value = dts.start;
  $('spEnd').value = dts.end;
  openModal('sprintModal');
  $('spName').focus();
}

async function saveSprint() {
  const name = $('spName').value.trim();
  if (!name) { toast('Sprint name is required', true); return; }
  const body = { name, start_date: $('spStart').value, end_date: $('spEnd').value };
  try {
    if (editingSprintId != null) {
      await api(`/api/sprints/${editingSprintId}`, { method: 'PATCH', body });
    } else {
      await api('/api/sprints', { method: 'POST', body });
    }
    closeModal('sprintModal');
    toast('Sprint saved');
    await loadBoard();
  } catch (e) { toast(e.message, true); }
}

async function deleteSprint() {
  if (editingSprintId == null) return;
  if (!confirm('Delete this sprint? Its tasks will go back to the Backlog.')) return;
  try {
    await api(`/api/sprints/${editingSprintId}`, { method: 'DELETE' });
    closeModal('sprintModal');
    toast('Sprint deleted');
    await loadBoard();
  } catch (e) { toast(e.message, true); }
}

async function sprintAction() {
  if (!canEdit()) return;
  const sp = currentSprint();
  if (sp && sp.status === 'active') { openEndSprint(sp); return; }
  if (sp && sp.status === 'future') {
    try {
      await api(`/api/sprints/${sp.id}`, { method: 'PATCH', body: { status: 'active' } });
      toast('Sprint started');
      await loadBoard();
    } catch (e) { toast(e.message, true); }
    return;
  }
  openSprintModal(null);
}

function openEndSprint(sp) {
  const doneCol = board.columns.find((c) => c.stage === 'done');
  const doneId = doneCol ? doneCol.id : -1;
  const spTasks = board.tasks.filter((t) => t.sprint_id === sp.id);
  const done = spTasks.filter((t) => t.column_id === doneId).length;
  const un = spTasks.length - done;
  const planned = Math.round(spTasks.reduce((s, t) => s + hoursOf(t), 0) * 10) / 10;
  $('esSummary').innerHTML = `Sprint <b>${esc(sp.name)}</b> ·
    <span class="week-pill">${done} done</span>
    <span class="week-pill">${un} open</span>
    <span class="week-pill">${fmtFull(planned)} planned</span>`;
  $('esUnfinished').textContent = un > 0
    ? 'Open tasks will carry over as SPILLED. Move them to the next sprint (they stay in their columns) or back to the Backlog.'
    : 'No open tasks in this sprint. End to record it in history.';
  $('esBacklog').hidden = un <= 0;
  if (un <= 0) {
    $('esNext').textContent = 'End sprint';
  } else {
    $('esNext').textContent = 'Move to next sprint';
  }
  window.__endSprintId = sp.id;
  openModal('endSprintModal');
}

async function endSprint(mode) {
  const id = window.__endSprintId;
  if (!id) return;
  try {
    await api(`/api/sprints/${id}/end`, { method: 'POST', body: { unfinished: mode } });
    closeModal('endSprintModal');
    toast(mode === 'next' ? 'Sprint ended — open tasks moved to the next sprint' : 'Sprint ended — open tasks moved back to the Backlog');
    await loadBoard();
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
    refreshTimer = setTimeout(async () => {
      await loadBoard().catch(() => {});
      if (document.getElementById('employeesModal')?.classList.contains('show')) {
        loadEmployees().catch(() => {});
      }
    }, 150);
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
  $('navEmployees').onclick = openEmployees;
  $('navCalendar').onclick = () => { $('sidebar').classList.remove('open'); openCalendar(); };
  $('calClose').onclick = () => closeModal('calendarModal');
  $('navReports').onclick = openReports;
  $('repClose').onclick = () => closeModal('reportsModal');
  $('srPrint').onclick = () => window.print();
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
  $('btnNewSprint').onclick = () => openSprintModal(null);
  $('sprintSelect').onchange = () => {
    const v = Number($('sprintSelect').value);
    if (v) selectSprint(v);
  };
  $('btnSprint').onclick = sprintAction;
  $('btnSprintEdit').onclick = () => { const sp = currentSprint(); if (sp) openSprintModal(sp); };
  $('spSave').onclick = saveSprint;
  $('spCancel').onclick = () => closeModal('sprintModal');
  $('spDelete').onclick = deleteSprint;
  $('esNext').onclick = () => endSprint('next');
  $('esBacklog').onclick = () => endSprint('backlog');
  $('esCancel').onclick = () => closeModal('endSprintModal');
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
  $('empClose').onclick = () => closeModal('employeesModal');
  $('empX').onclick = () => closeModal('employeesModal');
  $('empAdd').onclick = openEmpAdd;
  $('eaX').onclick = () => closeModal('empAddModal');
  $('eaCancel').onclick = () => closeModal('empAddModal');
  $('eaSave').onclick = async () => {
    const name = $('eaName').value.trim();
    if (name.length < 2) { toast('Employee name is required', true); return; }
    try {
      const r = await api('/api/employees', { method: 'POST', body: {
        employeeId: $('eaId').value.trim(),
        name,
        department: $('eaDept').value,
        title: $('eaTitle').value.trim(),
        manager: $('eaManager').value.trim(),
        dailyCapacity: Number($('eaDaily').value) || 0,
        password: $('eaPass').value,
      } });
      closeModal('empAddModal');
      $('eaId').value = ''; $('eaName').value = ''; $('eaTitle').value = '';
      $('eaManager').value = ''; $('eaDaily').value = 6; $('eaPass').value = '';
      toast(r.generated ? `Created. Login password: ${r.password} — share it with them` : 'Employee added');
      await loadEmployees().catch(() => {});
    } catch (e) { toast(e.message, true); }
  };
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
