// Operations (admin stage A5; official routes/tasks, routes/activity, routes/logs): scheduled tasks
// with their triggers, the activity log, and the server's log files.
import { h, fill } from '../h.js';
import * as f from '../fmt.js';
import { deck, btn, tag, seg, empty, toast, errorBox, loading, numberBox } from '../ui.js';
import { confirmDialog, dialog } from '../menu.js';
import { row } from './form.js';

const TICKS = 1e7;
const INTERVALS = [[15, '15 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, 'hour'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'],
  [360, '6 hours'], [480, '8 hours'], [720, '12 hours'], [1440, '24 hours']].map(([m, l]) => [`Every ${l}`, m * 60 * TICKS]);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMES = Array.from({ length: 48 }, (_, i) => [`${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i * 30 * 60 * TICKS]);
const RESULT = { Completed: ['Done', 'sky'], Failed: ['Failed', 'red'], Cancelled: ['Stopped', 'peach'], Aborted: ['Interrupted (the server stopped)', 'peach'] };

export async function ops(ctx) {
  const [tab = 'tasks', id] = ctx.sub;
  ctx.setParent(id ? '#/admin/ops/tasks' : '#/admin/overview');
  const page = tab === 'tasks' ? (id ? task : tasks) : tab === 'activity' ? activity : tab === 'logs' ? (id ? logFile : logs) : tasks;
  return h('div.eng-edit', subTabs(tab), await page(ctx, id));
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['tasks', 'Scheduled tasks'], ['activity', 'Activity'], ['logs', 'Logs']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/ops/${k}`, class: k === cur ? 'on' : '' }, l)));

const clockOf = ticks => { const m = Math.round((ticks || 0) / TICKS / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const span = (a, b) => { const s = (Date.parse(b) - Date.parse(a)) / 1000; return Number.isFinite(s) && s >= 0 ? f.dur(Math.max(1, Math.round(s))) : ''; };

/** "Daily at 03:00", "Every 12 hours", "When the server starts", with any time limit. */
function describe(t) {
  const lim = t.MaxRuntimeTicks ? ` (stop after ${f.dur(t.MaxRuntimeTicks / TICKS)})` : '';
  if (t.Type === 'DailyTrigger') return `Every day at ${clockOf(t.TimeOfDayTicks)}${lim}`;
  if (t.Type === 'WeeklyTrigger') return `Every ${t.DayOfWeek} at ${clockOf(t.TimeOfDayTicks)}${lim}`;
  if (t.Type === 'IntervalTrigger') return `${INTERVALS.find(([, v]) => v === t.IntervalTicks)?.[0] || `Every ${f.dur(t.IntervalTicks / TICKS)}`}${lim}`;
  if (t.Type === 'StartupTrigger') return `When the server starts${lim}`;
  return t.Type;
}

function lastRun(t) {
  const r = t.LastExecutionResult;
  if (!r) return h('span.eng-ro', 'Never run');
  const [label, color] = RESULT[r.Status] || [r.Status, 'lilac'];
  return h('span.eng-task-last', tag(label, color), h('span', `${f.ago(r.EndTimeUtc)}${span(r.StartTimeUtc, r.EndTimeUtc) ? ` · took ${span(r.StartTimeUtc, r.EndTimeUtc)}` : ''}`));
}

async function run(api, t) {
  try { await api.post(`/ScheduledTasks/Running/${t.Id}`); toast('Task started', t.Name, 'sky', 2000); } catch (e) { toast('Unable to comply', e.message, 'red'); }
}
async function stop(api, t) {
  try { await api.del(`/ScheduledTasks/Running/${t.Id}`); toast('Stopping', t.Name, 'peach', 2000); } catch (e) { toast('Unable to comply', e.message, 'red'); }
}

// ---- tasks ----------------------------------------------------------------------------------------

async function tasks(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Scheduled tasks');
  const body = h('div.eng-stack');
  let list = await api.get('/ScheduledTasks', { isHidden: false }, { signal });
  function draw() {
    const cats = [...new Set(list.map(t => t.Category))].sort();
    fill(body, cats.map((c, i) => deck(c, { color: ['orange', 'sky', 'lilac', 'peach', 'blue', 'salmon'][i % 6], num: i + 1 },
      h('div.eng-tasks', list.filter(t => t.Category === c).sort((a, b) => a.Name.localeCompare(b.Name)).map(t => {
        const running = t.State !== 'Idle';
        return h('div.eng-taskrow', { class: running ? 'running' : '', key: t.Id },
          h('div.eng-taskrow-b',
            h('a.eng-taskrow-n', { href: `#/admin/ops/tasks/${t.Id}` }, t.Name),
            h('span.eng-ro', t.Description || ''),
            running ? h('div.eng-sess-p', seg((t.CurrentProgressPercentage || 0) / 100, { n: 30, tone: 'orange' }),
              h('span', t.State === 'Cancelling' ? 'Stopping…' : `${Math.round(t.CurrentProgressPercentage || 0)}%`)) : lastRun(t)),
          h('div.eng-taskrow-a',
            running ? btn('Stop', () => stop(api, t), { small: true, color: 'red', ghost: true, disabled: t.State === 'Cancelling' })
              : btn('Run', () => run(api, t), { small: true, color: 'orange' }),
            btn('Triggers', () => { location.hash = `#/admin/ops/tasks/${t.Id}`; }, { small: true, color: 'lilac', ghost: true, title: (t.Triggers || []).map(describe).join('; ') || 'No triggers' })));
      })))));
  }
  draw();
  const off = app.subscribe('ScheduledTasksInfo', d => { if (Array.isArray(d)) { list = d.filter(t => !t.IsHidden); draw(); } }, '0,1000');
  signal.addEventListener('abort', off);
  return body;
}

async function task(ctx, id) {
  const { api, app, signal } = ctx;
  let t = await api.get(`/ScheduledTasks/${id}`, undefined, { signal });
  ctx.setTitle(t.Name);
  const head = h('div');
  const trigEl = h('div');
  function drawHead() {
    const r = t.LastExecutionResult;
    const running = t.State !== 'Idle';
    fill(head,
      h('p.dlg-text', t.Description || ''),
      running ? h('div.eng-sess-p', seg((t.CurrentProgressPercentage || 0) / 100, { n: 40, tone: 'orange' }), h('span', `${Math.round(t.CurrentProgressPercentage || 0)}%`)) : null,
      h('div.kv',
        h('span', 'Category'), h('span', t.Category),
        h('span', 'Last run'), h('span', r ? `${new Date(r.StartTimeUtc).toLocaleString()} (${span(r.StartTimeUtc, r.EndTimeUtc)})` : 'Never'),
        h('span', 'Result'), h('span', r ? lastRun(t) : '—')),
      r?.ErrorMessage ? h('div.eng-err', h('b', r.ErrorMessage), r.LongErrorMessage ? h('pre', r.LongErrorMessage) : null) : null,
      h('div.actions', running ? btn('Stop', () => stop(api, t), { color: 'red' }) : btn('Run now', () => run(api, t), { color: 'orange' })));
  }
  async function saveTriggers(list) {
    try {
      await api.post(`/ScheduledTasks/${t.Id}/Triggers`, list);
      t = await api.get(`/ScheduledTasks/${id}`);
      drawTriggers();
      toast('Triggers saved', t.Name, 'sky', 1800);
    } catch (e) { toast('Unable to comply', e.message, 'red'); }
  }
  function drawTriggers() {
    const list = t.Triggers || [];
    fill(trigEl,
      list.length ? h('div.eng-trigs', list.map((tr, i) => h('div.eng-trig', h('span', describe(tr)),
        btn('✕', async () => {
          if (!(await confirmDialog('Remove trigger', `Stop running “${t.Name}” ${describe(tr).replace(/^Every/, 'every').replace(/^When/, 'when')}?`, 'Remove'))) return;
          saveTriggers(list.filter((_, j) => j !== i));
        }, { small: true, ico: true, color: 'red', ghost: true, title: 'Remove' })))) : h('p.dlg-note', 'No triggers: it only runs when you start it.'),
      btn('Add a trigger', () => addTrigger(list), { small: true, color: 'blue' }));
  }
  function addTrigger(list) {
    const type = h('select.sel', [['Daily', 'DailyTrigger'], ['Weekly', 'WeeklyTrigger'], ['On an interval', 'IntervalTrigger'], ['When the server starts', 'StartupTrigger']].map(([l, v]) => h('option', { value: v }, l)));
    const day = h('select.sel', DAYS.map(d => h('option', { value: d }, d)));
    const time = h('select.sel', TIMES.map(([l, v]) => h('option', { value: String(v), attrs: { selected: v === 3 * 3600 * TICKS } }, l)));
    const every = h('select.sel', INTERVALS.map(([l, v]) => h('option', { value: String(v), attrs: { selected: v === 24 * 3600 * TICKS } }, l)));
    const limit = h('input.inp.num', { type: 'number', attrs: { min: 0, step: 0.5, placeholder: 'None' } });
    const rows = { day: row('Day', day), time: row('Time', time), every: row('Every', every) };
    const sync = () => {
      rows.day.hidden = type.value !== 'WeeklyTrigger';
      rows.time.hidden = !['DailyTrigger', 'WeeklyTrigger'].includes(type.value);
      rows.every.hidden = type.value !== 'IntervalTrigger';
    };
    type.addEventListener('change', sync);
    sync();
    let d = null;
    const add = () => {
      const tr = { Type: type.value };
      if (tr.Type === 'DailyTrigger' || tr.Type === 'WeeklyTrigger') tr.TimeOfDayTicks = Number(time.value);
      if (tr.Type === 'WeeklyTrigger') tr.DayOfWeek = day.value;
      if (tr.Type === 'IntervalTrigger') tr.IntervalTicks = Number(every.value);
      if (Number(limit.value) > 0) tr.MaxRuntimeTicks = Math.round(Number(limit.value) * 3600 * TICKS);
      d.close();
      saveTriggers([...list, tr]);
    };
    d = dialog(`Add a trigger · ${t.Name}`, [row('When', type), rows.day, rows.time, rows.every, row('Stop after (hours)', numberBox(limit), 'Empty: no time limit')],
      [btn('Cancel', () => d.close(), { color: 'lilac', ghost: true }), btn('Add', add, { color: 'orange' })], { color: 'blue' });
  }
  drawHead();
  drawTriggers();
  const off = app.subscribe('ScheduledTasksInfo', dd => {
    const n = Array.isArray(dd) && dd.find(x => x.Id === t.Id);
    if (n) { const was = t.State; t = { ...n, Triggers: t.Triggers }; drawHead(); if (was !== 'Idle' && n.State === 'Idle') api.get(`/ScheduledTasks/${id}`).then(x => { t = x; drawHead(); }).catch(() => {}); }
  }, '0,1000');
  signal.addEventListener('abort', off);
  return h('div.eng-grid', h('div.eng-col', deck(t.Name, { color: 'orange', num: 1 }, head)), h('div.eng-col', deck('Triggers', { color: 'blue', num: 2 }, trigEl)));
}

// ---- activity ---------------------------------------------------------------------------------------

const SEVERITIES = [['Any severity', ''], ['Information', 'Information'], ['Warning', 'Warning'], ['Error', 'Error'], ['Critical', 'Critical']];
const SINCE = [['Any time', 0], ['Today', 1], ['This week', 7], ['This month', 30], ['This year', 365]];
const PAGE = 50;

async function activity(ctx) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Activity');
  const params = { who: 'all', severity: '', since: 0, text: '' };
  const listEl = h('div.eng-acts');
  const moreEl = h('div.actions');
  const countEl = h('span.eng-ro');
  let items = [], total = 0, loadingMore = false, token = 0;
  // Who each entry is about, by user id (official activity's User column).
  const people = new Map();
  api.get('/Users', undefined, { signal }).then(us => { for (const u of us) people.set(u.Id.replace(/-/g, ''), u); if (items.length) fill(listEl, items.map(entry)); }).catch(() => {});
  const who = e => {
    const u = e.UserId && people.get(String(e.UserId).replace(/-/g, ''));
    if (!u) return null;
    return h('a.eng-actrow-u', { href: `#/admin/users/${u.Id}`, title: u.Name },
      u.PrimaryImageTag ? h('img', { src: api.url(`/Users/${u.Id}/Images/Primary`, { tag: u.PrimaryImageTag, height: 48, quality: 90 }), alt: '' }) : h('span', u.Name[0]), h('b', u.Name));
  };

  const query = startIndex => {
    const q = { startIndex, limit: PAGE, sortBy: 'DateCreated', sortOrder: 'Descending' };
    if (params.who !== 'all') q.hasUserId = params.who === 'users';
    if (params.severity) q.severity = params.severity;
    if (params.since) q.minDate = new Date(Date.now() - params.since * 86400000).toISOString();
    if (params.text) q.name = params.text;
    return q;
  };
  const entry = e => h('div.eng-actrow', { class: `sev-${(e.Severity || 'Information').toLowerCase()}` },
    h('span.eng-actrow-t', { title: new Date(e.Date).toLocaleString() }, new Date(e.Date).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })),
    h('div.eng-actrow-b', h('span.eng-act-n', e.Name), e.ShortOverview ? h('span.eng-act-o', e.ShortOverview) : null,
      e.ItemId ? h('a.eng-actrow-i', { href: `#/item/${String(e.ItemId).replace(/-/g, '')}` }, 'Open the item') : null,
      e.Overview && e.Overview !== e.ShortOverview ? h('details', h('summary', 'Details'), h('pre', e.Overview)) : null),
    h('span.eng-actrow-k', [who(e), e.Severity && e.Severity !== 'Information' ? tag(e.Severity, e.Severity === 'Warning' ? 'peach' : 'red') : null, h('span', e.Type)]));
  async function load(reset = true) {
    const my = ++token;
    if (reset) { items = []; fill(listEl, loading('Reading the log')); }
    loadingMore = true;
    try {
      const r = await api.get('/System/ActivityLog/Entries', query(items.length), { signal });
      if (my !== token) return;
      items.push(...(r.Items || []));
      total = r.TotalRecordCount || items.length;
    } catch (e) { if (my === token) fill(listEl, errorBox(e)); return; } finally { loadingMore = false; }
    fill(listEl, items.length ? items.map(entry) : empty('Nothing matches.'));
    countEl.textContent = `${f.num(items.length)} of ${f.num(total)}`;
    fill(moreEl, items.length < total ? btn('More', () => load(false), { color: 'lilac', ghost: true }) : null);
  }
  const sel = (opts, key) => h('select.sel', { onchange: e => { params[key] = opts.find(([, v]) => String(v) === e.target.value)[1]; load(); } },
    opts.map(([l, v]) => h('option', { value: String(v) }, l)));
  const text = h('input.inp', { attrs: { placeholder: 'Search the titles', spellcheck: 'false' } });
  let tt = null;
  text.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(() => { params.text = text.value.trim(); load(); }, 350); });
  // Scrolling near the end loads the next page.
  const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting) && !loadingMore && items.length < total) load(false); });
  io.observe(moreEl);
  // New entries while on the first page: read it again.
  let lt = null;
  const off = app.subscribe('ActivityLogEntry', () => { if (items.length <= PAGE) { clearTimeout(lt); lt = setTimeout(() => load(), 500); } }, '0,1000');
  signal.addEventListener('abort', () => { off(); io.disconnect(); clearTimeout(lt); clearTimeout(tt); });
  load();
  return deck('Activity', { color: 'salmon', num: 1, actions: [countEl] },
    h('div.rc-opts.eng-filters',
      h('label.rc-sel', h('span', 'From'), sel([['Users and system', 'all'], ['Users', 'users'], ['System (alerts)', 'system']], 'who')),
      h('label.rc-sel', h('span', 'Severity'), sel(SEVERITIES, 'severity')),
      h('label.rc-sel', h('span', 'When'), sel(SINCE, 'since')),
      h('label.rc-sel.grow', h('span', 'Title'), text)),
    listEl, moreEl);
}

// ---- logs -------------------------------------------------------------------------------------------

async function logs(ctx) {
  const { api, signal } = ctx;
  ctx.setTitle('Logs');
  const files = await api.get('/System/Logs', undefined, { signal });
  files.sort((a, b) => Date.parse(b.DateModified) - Date.parse(a.DateModified));
  return deck('Log files', { color: 'blue', num: 1, code: `${files.length} files` },
    files.length ? h('div.eng-logs', files.map(fl => h('a.eng-logrow', { href: `#/admin/ops/logs/${encodeURIComponent(fl.Name)}` },
      h('b', fl.Name), h('span', f.bytes(fl.Size)), h('span', `changed ${f.ago(fl.DateModified)}`)))) : empty('No log files.'));
}

async function logFile(ctx, encName) {
  const { api, signal } = ctx;
  const name = decodeURIComponent(encName);
  ctx.setTitle(name);
  ctx.setParent('#/admin/ops/logs');
  const pre = h('div.eng-logview');
  const status = h('span.eng-ro');
  const search = h('input.inp', { attrs: { placeholder: 'Show lines containing…', spellcheck: 'false' } });
  let text = '', follow = false, wrap = false, only = 'all', timer = null;
  const levelOf = l => (/\[(ERR|FTL)\]/.test(l) ? 'err' : /\[WRN\]/.test(l) ? 'wrn' : /\[DBG\]|\[VRB\]/.test(l) ? 'dbg' : '');
  function draw() {
    const q = search.value.trim().toLowerCase();
    // A log entry is its first line plus the indented or stack lines after it.
    const lines = text.split('\n');
    const out = [];
    let cur = null;
    for (const l of lines) {
      if (/^\[\d{4}-\d\d-\d\d|^\[\d\d:\d\d:\d\d/.test(l) || !cur) { cur = { head: l, rest: [] }; out.push(cur); } else cur.rest.push(l);
    }
    const shown = out.filter(e => {
      const lv = levelOf(e.head);
      if (only === 'wrn' && lv !== 'wrn' && lv !== 'err') return false;
      if (only === 'err' && lv !== 'err') return false;
      return !q || (e.head + '\n' + e.rest.join('\n')).toLowerCase().includes(q);
    });
    pre.classList.toggle('wrap', wrap);
    fill(pre, shown.slice(-3000).map(e => h('div.eng-logline', { class: levelOf(e.head) }, [e.head, ...e.rest].join('\n'))));
    status.textContent = `${f.num(shown.length)} of ${f.num(out.length)} entries${shown.length > 3000 ? ' (the last 3,000 shown)' : ''} · ${f.bytes(text.length)}`;
    if (follow) pre.scrollTop = pre.scrollHeight;
  }
  async function load() {
    try { text = await api.text('/System/Logs/Log', { name }, { signal }); draw(); } catch (e) { if (e.name !== 'AbortError') fill(pre, errorBox(e)); }
  }
  let st = null;
  search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(draw, 200); });
  const tog = (label, get, set) => { const b = h('button.toggle', { type: 'button' }, 'Off'); b.addEventListener('click', () => { set(!get()); b.classList.toggle('on', get()); b.textContent = get() ? 'On' : 'Off'; draw(); }); return h('label.eng-allor-h', b, h('span', label)); };
  const levelSel = h('select.sel', { onchange: e => { only = e.target.value; draw(); } }, [['Every entry', 'all'], ['Warnings and errors', 'wrn'], ['Errors only', 'err']].map(([l, v]) => h('option', { value: v }, l)));
  const followT = tog('Follow', () => follow, v => {
    follow = v;
    clearInterval(timer);
    if (v) { timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000); pre.scrollTop = pre.scrollHeight; }
  });
  signal.addEventListener('abort', () => clearInterval(timer));
  const download = btn('Download', () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }, { color: 'sky', small: true });
  await load();
  pre.scrollTop = pre.scrollHeight;
  return deck(name, { color: 'blue', num: 1, actions: [status] },
    h('div.rc-opts.eng-filters', h('label.rc-sel.grow', h('span', 'Search'), search), h('label.rc-sel', h('span', 'Show'), levelSel),
      followT, tog('Wrap lines', () => wrap, v => { wrap = v; }), download, btn('Reload', load, { color: 'lilac', small: true, ghost: true })),
    pre);
}
