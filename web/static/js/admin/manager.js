// The metadata manager (official /metadata, edititemmetadata + editorsidebar): every library as a
// tree down to its items, folders included, so anything can be picked and edited, even what the
// rest of LCARS doesn't browse to (library roots, plain folders). Search finds an item by name.
import { h, fill } from '../h.js';
import { deck, btn, empty, errorBox, loading, epCode } from '../ui.js';
import { toolsFor } from './edit.js';

const PAGE = 200;
const label = it => it.Type === 'Episode' ? [epCode(it), it.Name].filter(Boolean).join(' · ')
  : it.Type === 'Season' ? it.Name : [it.Name, it.ProductionYear].filter(Boolean).join(' · ');
// Types with nothing worth opening below them in the tree.
const LEAF = new Set(['Movie', 'Episode', 'Audio', 'Video', 'MusicVideo', 'Trailer', 'Book', 'Photo', 'AudioBook']);

export async function manager(ctx, tabs) {
  const { api, app, signal } = ctx;
  ctx.setTitle('Metadata manager');
  const tree = h('div.mm-tree');
  const results = h('div.mm-tree');
  const search = h('input.inp', { attrs: { type: 'search', placeholder: 'Find an item by name', spellcheck: 'false' } });

  function node(it, depth) {
    const kids = h('div.mm-kids');
    let open = false, loaded = false, start = 0;
    const leaf = LEAF.has(it.Type) || it.IsFolder === false;
    const tw = leaf ? h('span.mm-tw') : h('button.mm-tw', { type: 'button', attrs: { 'aria-expanded': 'false', 'aria-label': `Open ${it.Name}` }, onclick: () => toggle() }, '▸');
    const tools = toolsFor(it, app.me);
    const row = h('div.mm-row', { style: { '--d': depth } }, tw,
      h('span.mm-n', label(it)), h('span.mm-t', it.Type === 'CollectionFolder' ? 'Library' : it.Type),
      h('span.mm-a', tools.map(([k, l]) => h('a.mm-tool', { href: `#/admin/edit/${it.Id}/${k}` }, l))));
    async function more() {
      try {
        const r = await api.get('/Items', { parentId: it.Id, startIndex: start, limit: PAGE, sortBy: 'IsFolder,ParentIndexNumber,IndexNumber,SortName', sortOrder: 'Descending,Ascending,Ascending,Ascending',
          fields: 'ProductionYear', enableImages: false }, { signal });
        kids.querySelector('.mm-more')?.remove();
        kids.append(...(r.Items || []).map(c => node(c, depth + 1)));
        start += (r.Items || []).length;
        if (start < (r.TotalRecordCount || 0)) kids.append(h('div.mm-more', { style: { '--d': depth + 1 } }, btn(`Show more (${r.TotalRecordCount - start})`, more, { small: true, color: 'lilac', ghost: true })));
        if (!start) kids.append(h('p.mm-empty', { style: { '--d': depth + 1 } }, 'Empty'));
      } catch (e) { if (!signal.aborted) kids.append(errorBox(e)); }
    }
    async function toggle() {
      open = !open;
      tw.textContent = open ? '▾' : '▸';
      tw.setAttribute('aria-expanded', String(open));
      kids.hidden = !open;
      if (open && !loaded) { loaded = true; await more(); }
    }
    kids.hidden = true;
    return h('div.mm-node', row, kids);
  }

  try {
    const libs = (await api.get('/Library/VirtualFolders', undefined, { signal })).filter(l => l.ItemId);
    const roots = libs.length ? (await api.get('/Items', { ids: libs.map(l => l.ItemId).join(','), enableImages: false }, { signal })).Items || [] : [];
    fill(tree, roots.length ? roots.sort((a, b) => a.Name.localeCompare(b.Name)).map(r => node(r, 0)) : empty('No libraries.'));
  } catch (e) { fill(tree, errorBox(e)); }

  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) { fill(results); results.hidden = true; tree.hidden = false; return; }
      results.hidden = false; tree.hidden = true;
      fill(results, loading('Searching'));
      try {
        const r = await api.get('/Items', { searchTerm: q, recursive: true, limit: 100, fields: 'ProductionYear', enableImages: false, includeItemTypes: 'Movie,Series,Season,Episode,MusicAlbum,MusicArtist,Audio,BoxSet,Book,Video,MusicVideo,Folder,Person' }, { signal });
        fill(results, (r.Items || []).length ? r.Items.map(it => node(it, 0)) : empty('Nothing by that name.'));
      } catch (e) { if (!signal.aborted) fill(results, errorBox(e)); }
    }, 250);
  });
  results.hidden = true;
  return h('div.eng-edit', tabs,
    h('div.rc-opts.eng-filters', h('label.rc-sel.grow', h('span', 'Search'), search)),
    deck('Libraries', { color: 'lilac', num: 1 }, tree, results));
}
