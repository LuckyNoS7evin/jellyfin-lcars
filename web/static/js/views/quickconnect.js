// Quick Connect: let another device sign in by entering the code it shows (official
// routes/quickConnect). An administrator may sign it in as any user; everyone else as themselves.
import { h, fill } from '../h.js';
import { deck, btn, empty } from '../ui.js';

export async function quickConnect(ctx) {
  const { api, app, query } = ctx;
  ctx.setTitle('Quick Connect');
  ctx.setParent('#/settings');
  const enabled = await api.quickConnectEnabled().catch(() => false);
  if (enabled !== true) {
    return deck('Quick Connect', { color: 'lilac', code: 'Q-C' },
      empty('Quick Connect is turned off on this server. An administrator can turn it on in the dashboard (General).'));
  }
  const admin = !!app.me?.Policy?.IsAdministrator;
  const users = admin ? (await api.get('/Users').catch(() => [])).filter(u => !u.Policy?.IsDisabled) : [];

  const code = h('input.inp.qc-in', {
    value: query.get('code') || '',
    attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true, pattern: '[0-9 ]{6,12}', 'aria-label': 'Code', placeholder: '000000' },
  });
  const who = admin ? h('select.sel', users.map(u => h('option', { value: u.Id, attrs: { selected: u.Id === api.userId } }, u.Name))) : null;
  const msg = h('p.msg', { attrs: { role: 'status' } });
  const submit = btn('Authorise', null, { type: 'submit', color: 'lilac' });
  const body = h('div');

  const form = h('form.set-form', {
    onsubmit: async e => {
      e.preventDefault();
      const c = code.value.replace(/\s/g, '');
      if (!/^\d{6,}$/.test(c)) { msg.className = 'msg bad'; msg.textContent = 'Enter the code the other device shows'; code.focus(); return; }
      submit.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Authorising…';
      try {
        await api.quickConnectAuthorize(c, who ? who.value : api.userId);
        const name = who ? who.selectedOptions[0]?.textContent : api.session.userName;
        fill(body,
          h('p.msg', 'Access granted. The other device signs in as ', h('b', name), ' within a few seconds.'),
          h('div.actions', btn('Another code', () => { if (location.hash === '#/quickconnect') app.refresh(); else location.hash = '#/quickconnect'; }, { color: 'lilac', ghost: true }),
            btn('Home', () => { location.hash = '#/home'; }, { color: 'orange' })));
      } catch (err) {
        msg.className = 'msg bad';
        msg.textContent = err.status === 404 || err.status === 400 ? 'Unknown or expired code' : `Unable to comply: ${err.message}`;
        submit.disabled = false;
        code.select();
      }
    },
  },
  h('p.dlg-text', 'Sign another device in without typing a password: choose Quick Connect on its sign-in screen and enter the code it shows here.'),
  h('label.field', h('span', 'Code'), code),
  who ? h('label.field', h('span', 'Sign it in as'), who) : null,
  h('div.actions', submit),
  msg);
  fill(body, form);
  setTimeout(() => code.focus(), 0);
  return deck('Quick Connect', { color: 'lilac', code: 'Q-C' }, body);
}
