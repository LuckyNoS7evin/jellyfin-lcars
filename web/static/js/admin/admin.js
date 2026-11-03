// The admin dashboard ("engineering"): loaded on demand the first time an admin opens #/admin,
// so other users never download it. Pages live in this folder; each exports a view taking the
// usual route context. The rail switches to the sections below while you're in here.
import { h } from '../h.js';
import { btn, toast } from '../ui.js';
import { confirmDialog } from '../menu.js';

// The rail: a few groups rather than one pill per settings page. Pages are added as their
// stage is built (admin-plan.md); `load` imports the page module.
export const SECTIONS = [
  { id: 'overview', label: 'Overview', n: 'E-01', color: 'orange', load: () => import('./overview.js').then(m => m.overview) },
  { id: 'users', label: 'Users', n: 'E-02', color: 'sky', load: () => import('./users.js').then(m => m.users) },
  { id: 'libraries', label: 'Libraries', n: 'E-03', color: 'lilac', load: () => import('./libraries.js').then(m => m.libraries) },
  { id: 'playback', label: 'Playback', n: 'E-04', color: 'peach', load: () => import('./playback.js').then(m => m.playback) },
  // Item tools (A8), opened from an item's ⋯ menu rather than the rail. Subtitle managers who
  // aren't admins may use the subtitle tool.
  { id: 'edit', hidden: true, load: () => import('./edit.js').then(m => m.edit),
    allow: (app, rest) => isAdmin(app) || (rest[1] === 'subtitles' && !!app.me?.Policy?.EnableSubtitleManagement) },
];

let cssLoaded = false;
function loadCss(app) {
  if (cssLoaded) return;
  cssLoaded = true;
  document.head.append(h('link', { rel: 'stylesheet', href: `/static/${app.version}/css/admin.css` }));
}

export const isAdmin = app => !!app.me?.Policy?.IsAdministrator;

/** #/admin/<section>[/...]: the shell around a section's page. */
export async function admin(ctx) {
  const { app, params } = ctx;
  loadCss(app);
  const [id = 'overview', ...rest] = (params.sub || '').split('/').filter(Boolean);
  const section = SECTIONS.find(s => s.id === id);
  if (!section) { location.replace(isAdmin(app) ? '#/admin/overview' : '#/home'); return h('div'); }
  if (!(section.allow ? section.allow(app, rest) : isAdmin(app))) { location.replace('#/home'); return h('div'); }
  if (!section.hidden) ctx.setParent(id === 'overview' ? '#/home' : '#/admin/overview');
  const view = await section.load();
  const page = await view({ ...ctx, sub: rest });
  return h('div.eng-page', await restartBanner(ctx), page);
}

/** The rail while in the dashboard (app.js draws it with its own pill helper). */
export function rail(path, app) {
  return SECTIONS.filter(s => !s.hidden && isAdmin(app)).map(s => ({ href: `#/admin/${s.id}`, n: s.n, label: s.label, color: s.color, active: path.startsWith(`/admin/${s.id}`) || (s.id === 'overview' && path === '/admin') }));
}

/** A red banner while the server waits for a restart (some settings only apply after one). */
async function restartBanner(ctx) {
  const { api, signal } = ctx;
  let info;
  try { info = await api.get('/System/Info', undefined, { signal }); } catch { return null; }
  if (!info?.HasPendingRestart) return null;
  return h('div.eng-restart', { attrs: { role: 'alert' } },
    h('b', 'Restart required'), h('span', 'Some changes take effect when the server restarts.'),
    info.CanSelfRestart ? btn('Restart now', () => restartServer(ctx), { color: 'red', small: true }) : null);
}

export async function restartServer(ctx) {
  const ok = await confirmDialog('Restart server', 'Restart Jellyfin now? Everyone watching is interrupted for a minute or so.', 'Restart');
  if (!ok) return;
  await ctx.api.post('/System/Restart');
  toast('Restarting', 'The server is restarting; LCARS reconnects when it’s back', 'red', 8000);
}
