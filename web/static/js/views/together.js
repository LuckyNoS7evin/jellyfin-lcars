// Watch together (SyncPlay): the groups on the server, a new one, and the group you're in (the
// official client's SyncPlay group menu as a page). syncplay.js does the work.
import { h, fill } from '../h.js';
import { deck, btn, empty, tag, toast } from '../ui.js';

const STATE = { Idle: ['Idle', 'lilac'], Waiting: ['Waiting for everyone', 'salmon'], Paused: ['Paused', 'sky'], Playing: ['Playing', 'orange'] };

export async function together(ctx) {
  const { app, signal } = ctx;
  const sp = app.sync;
  ctx.setTitle('Watch together');
  const body = h('div');
  let groups = [];
  let nowName = '';
  let nowFor = '';

  const fail = e => toast('Unable to comply', e.message, 'red');

  async function loadGroups() {
    try { groups = await sp.list(); } catch { groups = []; }
    if (!signal.aborted) draw();
  }

  // The name of what the group is on (the queue only has ids).
  async function nameNow() {
    const q = sp.queue;
    const id = q && q.PlayingItemIndex >= 0 ? q.Playlist[q.PlayingItemIndex]?.ItemId : null;
    if (!id) { nowName = ''; nowFor = ''; return; }
    if (id === nowFor) return;
    nowFor = id;
    try {
      const it = await app.api.get(`/Users/${app.api.userId}/Items/${id}`);
      nowName = [it.SeriesName, it.Name].filter(Boolean).join(' · ');
    } catch { nowName = ''; }
    if (!signal.aborted) draw();
  }

  function stateTag(s) { const [t, c] = STATE[s] || [s, 'lilac']; return s ? tag(t, c) : null; }

  function inGroup() {
    const g = sp.group;
    return [
      h('div.dev.on',
        h('div.dev-n', h('b', g.GroupName), stateTag(sp.state || g.State)),
        h('div.dev-s', nowName ? ['Now: ', h('b', nowName)] : 'Nothing playing yet: play a video and it starts for everyone.'),
        h('div.dev-b',
          !sp.following && sp.queue?.Playlist?.length ? btn('Back to the group', () => sp.resume().catch(fail), { color: 'orange', small: true }) : null,
          btn('Leave group', () => sp.leave().catch(fail), { color: 'red', small: true, ghost: true }))),
      h('h3.set-h', 'In the group'),
      h('div.tags', (g.Participants || []).map(u => tag(u, 'peach'))),
      h('p.dlg-note', sp.following
        ? 'Play, pause, seek, next and previous here happen for everyone. Closing the player stops following the group without leaving it.'
        : 'You closed the player, so the group carries on without you. Back to the group picks up where it is.'),
    ];
  }

  function groupRow(g) {
    return h('div.dev', { key: g.GroupId },
      h('div.dev-n', h('b', g.GroupName), stateTag(g.State)),
      h('div.dev-s', (g.Participants || []).join(', ') || 'Nobody yet'),
      h('div.dev-b', btn('Join', () => sp.join(g.GroupId).catch(fail), { color: 'sky', small: true })));
  }

  function draw() {
    if (sp.group) { fill(body, inGroup()); return; }
    if (sp.access === 'None') { fill(body, empty('Your account may not watch together. An administrator can allow it under Users.')); return; }
    const canCreate = sp.access === 'CreateAndJoinGroups';
    fill(body,
      h('div.devs', groups.map(groupRow)),
      groups.length ? null : empty(canCreate ? 'No groups yet. Start one and others can join it.' : 'No groups to join yet.'),
      canCreate ? h('div.dev-b', btn('New group', () => sp.create(`${app.api.session?.userName || 'My'}’s group`).catch(fail), { color: 'orange' })) : null,
      h('p.dlg-note', 'Everyone in a group sees the same thing at the same time: whoever plays, pauses or seeks does it for all.'));
  }

  const off = sp.on(() => { if (!signal.aborted) { draw(); nameNow(); if (!sp.group) loadGroups(); } });
  const poll = setInterval(() => { if (!sp.group) loadGroups(); }, 5000);
  signal.addEventListener('abort', () => { off(); clearInterval(poll); });
  await loadGroups();
  nameNow();
  return deck('Groups', { color: 'sky', code: 'S-01' }, body);
}
