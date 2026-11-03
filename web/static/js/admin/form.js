// Settings pages: a draft copy of what the server sent, controls bound to keys in it, and a Save
// bar that appears once something changed (Save, Revert). Server settings affect everyone, so
// nothing is saved until Save, unlike the user's own settings. Leaving with unsaved changes asks.
import { h, fill } from '../h.js';
import { btn, toast } from '../ui.js';
import { dialog, confirmDialog } from '../menu.js';

const copy = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const getAt = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setAt(o, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const parent = ks.reduce((x, k) => (x[k] ??= {}), o);
  parent[last] = v;
}

/**
 * editForm({load, save, restartKeys}) -> form. load() resolves to the settings object; save(draft)
 * stores it. restartKeys: keys that only apply after a restart (a note appears after saving).
 * form: {ready, draft, get(key), set(key, v), toggle/select/num/text(key, ...), bar, dirty()}.
 */
export function editForm({ load, save, restartKeys = [], app }) {
  let orig = null;
  const f = { draft: null, controls: [] };
  guard.forms.add(f);
  if (app) app.leaveGuard = guard;
  const msg = h('span.eng-save-msg');
  const saveBtn = btn('Save', () => f.save(), { color: 'orange' });
  const revertBtn = btn('Revert', () => f.revert(), { color: 'lilac', ghost: true });
  f.bar = h('div.eng-savebar', { hidden: true, attrs: { role: 'region', 'aria-label': 'Unsaved changes' } },
    h('b', 'Unsaved changes'), msg, h('span.grow'), revertBtn, saveBtn);

  f.dirty = () => orig != null && JSON.stringify(orig) !== JSON.stringify(f.draft);
  f.changed = () => {
    f.bar.hidden = !f.dirty();
    msg.textContent = '';
  };
  f.get = key => getAt(f.draft, key);
  f.set = (key, v) => { setAt(f.draft, key, v); f.changed(); };
  f.refresh = () => { for (const c of f.controls) c.sync(); f.changed(); };
  f.revert = () => { f.draft = copy(orig); f.refresh(); };
  f.save = async () => {
    saveBtn.disabled = true;
    try {
      await save(f.draft);
      const needRestart = restartKeys.filter(k => JSON.stringify(getAt(orig, k)) !== JSON.stringify(getAt(f.draft, k)));
      orig = copy(f.draft);
      f.changed();
      toast('Saved', needRestart.length ? 'Restart the server for some of these to apply' : '', needRestart.length ? 'red' : 'sky', needRestart.length ? 6000 : 1800);
      if (needRestart.length) app?.refresh();
    } catch (e) {
      msg.textContent = e.message;
      toast('Not saved', e.message, 'red');
    } finally { saveBtn.disabled = false; }
  };
  f.ready = Promise.resolve(load()).then(v => { orig = copy(v); f.draft = copy(v); f.refresh(); return f; });

  // ---- controls: each keeps a sync() so Revert puts it back ---------------------------------
  // Controls made after the settings have loaded (the usual case: pages await f.ready first)
  // show their value straight away; ones made before are filled in when the load finishes.
  const control = (el, sync) => { f.controls.push({ sync }); if (f.draft != null) sync(); return el; };

  f.toggle = (key, { invert = false } = {}) => {
    const b = h('button.toggle', { type: 'button', attrs: { role: 'switch' } });
    const sync = () => {
      const on = !!f.get(key) !== invert;
      b.classList.toggle('on', on);
      b.textContent = on ? 'On' : 'Off';
      b.setAttribute('aria-checked', String(on));
    };
    b.addEventListener('click', () => { f.set(key, !f.get(key)); sync(); });
    return control(b, sync);
  };

  /** options: [[label, value], ...]; values compare as strings, and come back typed. */
  f.select = (key, options) => {
    const s = h('select.sel', options.map(([t, v]) => h('option', { value: String(v) }, t)));
    const sync = () => { s.value = String(f.get(key) ?? ''); };
    s.addEventListener('change', () => { const o = options.find(([, v]) => String(v) === s.value); f.set(key, o ? o[1] : s.value); });
    return control(s, sync);
  };

  /**
   * A number. scale: the stored value is shown divided by it (bits as Mbps: 1e6). zero: what an
   * empty box stores (and a stored value of this shows as empty), for "0 = no limit" fields.
   */
  f.num = (key, { min, max, step = 1, scale = 1, zero = null, int = true, placeholder } = {}) => {
    const i = h('input.inp.num', { type: 'number', attrs: { min, max, step, inputmode: 'decimal', placeholder } });
    const sync = () => {
      const v = f.get(key);
      i.value = v == null || (zero != null && v === zero) ? '' : String(+(v / scale).toFixed(6));
    };
    i.addEventListener('input', () => {
      if (i.value === '') { f.set(key, zero); return; }
      let v = Number(i.value) * scale;
      if (!Number.isFinite(v)) return;
      if (int) v = Math.round(v);
      f.set(key, v);
    });
    return control(i, sync);
  };

  /** Ticks in a list: the value is an array of the chosen ids. items: [[label, id], ...]. */
  f.checklist = (key, items, { disabledBy } = {}) => {
    const el = h('div.eng-checks');
    const sync = () => {
      const on = new Set(f.get(key) || []);
      const off = disabledBy ? !!f.get(disabledBy) : false;
      el.classList.toggle('off', off);
      fill(el, items.length ? items.map(([label, id]) => {
        const b = h('button.eng-check', { type: 'button', class: on.has(id) || off ? 'on' : '', disabled: off, attrs: { role: 'checkbox', 'aria-checked': String(on.has(id) || off) } }, label);
        b.addEventListener('click', () => {
          const cur = new Set(f.get(key) || []);
          if (cur.has(id)) cur.delete(id); else cur.add(id);
          f.set(key, items.map(([, i]) => i).filter(i => cur.has(i)));
          sync();
        });
        return b;
      }) : h('span.dlg-note', 'None'));
    };
    return control(el, sync);
  };

  /** "All" with a checklist under it that only counts when All is off (folders, devices...). */
  f.allOr = (allKey, listKey, items, label = 'All') => {
    const list = f.checklist(listKey, items, { disabledBy: allKey });
    const t = f.toggle(allKey);
    t.addEventListener('click', () => f.refresh());
    return h('div.eng-allor', h('div.eng-allor-h', t, h('span', label)), list);
  };

  /** Free-form tags: chips with ✕, and a box to add one (Enter). */
  f.tags = (key, { placeholder = 'Add a tag' } = {}) => {
    const chips = h('div.eng-tags');
    const add = h('input.inp', { attrs: { placeholder, spellcheck: 'false' } });
    const sync = () => fill(chips, (f.get(key) || []).map(t => h('span.eng-tag', t,
      h('button', { type: 'button', title: `Remove ${t}`, onclick: () => { f.set(key, (f.get(key) || []).filter(x => x !== t)); sync(); } }, '✕'))));
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = add.value.trim();
      if (v && !(f.get(key) || []).includes(v)) { f.set(key, [...(f.get(key) || []), v]); sync(); }
      add.value = '';
    });
    return control(h('div.eng-tagbox', chips, add), sync);
  };

  f.text = (key, { placeholder, area = false } = {}) => {
    const i = h(area ? 'textarea.inp.area' : 'input.inp', { attrs: { placeholder, spellcheck: 'false' } });
    const sync = () => { i.value = f.get(key) ?? ''; };
    i.addEventListener('input', () => f.set(key, i.value));
    return control(i, sync);
  };

  /** A path with a Browse button (the folder picker). */
  f.path = (key, api) => {
    const i = h('input.inp', { attrs: { spellcheck: 'false' } });
    const sync = () => { i.value = f.get(key) ?? ''; };
    i.addEventListener('input', () => f.set(key, i.value));
    const pick = btn('Browse', async () => {
      const p = await pickFolder(api, i.value);
      if (p != null) { f.set(key, p); sync(); }
    }, { color: 'blue', small: true });
    return control(h('div.eng-path', i, pick), sync);
  };

  return f;
}

/** A settings row: label (and a note) on the left, the control on the right. */
export const row = (label, control, note) => h('div.set-row', h('div.set-l', h('span', label), note ? h('small', note) : null), h('div.set-c', control));

// ---- leaving with unsaved changes -------------------------------------------------------------
// The forms on the current page. app.js asks app.leaveGuard before a route change and clears it
// after one; closing the tab with unsaved changes gets the browser's own question.
const pageForms = new Set();
export const guard = {
  forms: pageForms,
  dirty() { return [...pageForms].some(f => f.dirty()); },
  async confirmLeave() {
    if (!this.dirty()) return true;
    return confirmDialog('Unsaved changes', 'Leave this page and lose the changes you haven’t saved?', 'Leave');
  },
  clear() { pageForms.clear(); },
};
window.addEventListener('beforeunload', e => { if (guard.dirty()) e.preventDefault(); });

// ---- folder picker ------------------------------------------------------------------------------

/** Pick a folder on the server (as the official directory browser). Resolves to a path or null. */
export function pickFolder(api, start = '') {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; d.close(); resolve(v); } };
    const pathIn = h('input.inp', { value: start, attrs: { spellcheck: 'false', 'aria-label': 'Folder' } });
    const list = h('div.eng-dirs', { attrs: { role: 'listbox' } });
    const note = h('p.dlg-note');

    async function open(path) {
      fill(list, h('p.loading', 'Reading…'));
      note.textContent = '';
      try {
        let entries;
        if (!path) {
          entries = (await api.get('/Environment/Drives')).map(x => ({ Name: x.Name || x.Path, Path: x.Path }));
          // Linux servers have one root: show its folders straight away.
          if (entries.length === 1 && entries[0].Path === '/') { path = '/'; entries = null; }
        }
        if (!entries) {
          entries = await api.get('/Environment/DirectoryContents', { path, includeDirectories: true, includeFiles: false });
        }
        pathIn.value = path || '';
        let parent = null;
        if (path) { try { parent = await api.get('/Environment/ParentPath', { path }); } catch { /* top */ } }
        fill(list,
          path ? h('button.eng-dir.up', { type: 'button', onclick: () => open(parent || '') }, '↑ Up') : null,
          entries.length ? entries.map(e => h('button.eng-dir', { type: 'button', onclick: () => open(e.Path) }, e.Name)) : h('p.empty', 'No folders here'));
      } catch (e) {
        fill(list);
        note.textContent = `Unable to read ${path}: ${e.message}`;
      }
    }
    const d = dialog('Choose a folder', [
      h('div.eng-path', pathIn, btn('Go', () => open(pathIn.value.trim()), { color: 'blue', small: true })),
      list, note,
    ], [
      btn('Cancel', () => finish(null), { color: 'lilac', ghost: true }),
      btn('Choose', () => finish(pathIn.value.trim() || null), { color: 'orange' }),
    ], { color: 'blue', wide: true });
    d.el.addEventListener('close', () => finish(null));
    pathIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); open(pathIn.value.trim()); } });
    open(start);
  });
}
