// Sign in with a Jellyfin username and password, or with Quick Connect: this screen shows a
// code, and someone signed in on another device authorises it (official login controller).
import { h, fill } from '../h.js';
import { deck, btn } from '../ui.js';

export function login(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Access control');
  const user = h('input.inp', { name: 'username', value: ctx.username || '', attrs: { autocomplete: 'username', required: true, autocapitalize: 'off', spellcheck: 'false' } });
  const pass = h('input.inp', { name: 'password', type: 'password', attrs: { autocomplete: 'current-password' } });
  const msg = h('p.msg', { attrs: { role: 'status' } });
  const submit = btn('Engage', null, { type: 'submit', color: 'orange' });
  const users = h('div.users');

  api.publicUsers().then(list => {
    fill(users, ...list.map(u => h('button.user-btn', {
      type: 'button',
      onclick: () => { user.value = u.Name; pass.focus(); },
    },
    u.PrimaryImageTag ? h('img', { src: api.url(`/Users/${u.Id}/Images/Primary`, { tag: u.PrimaryImageTag, height: 104 }), alt: '' }) : h('span.ph'),
    h('span.nm', u.Name))));
  }).catch(() => {});

  const qcBtn = btn('Quick Connect', () => startQuickConnect(), { color: 'lilac', ghost: true, title: 'Sign in with a code from another device' });
  qcBtn.hidden = true;
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      submit.disabled = true;
      msg.className = 'msg';
      msg.textContent = 'Verifying…';
      try {
        await api.login(user.value.trim(), pass.value);
        msg.textContent = 'Access granted';
        app.start();
      } catch (err) {
        msg.className = 'msg bad';
        msg.textContent = err.status === 401 ? 'Access denied: check the username and password' : `Unable to comply: ${err.message}`;
        submit.disabled = false;
        pass.select();
      }
    },
  },
  h('label.field', h('span', 'Username'), user),
  h('label.field', h('span', 'Password'), pass),
  h('div.actions', submit, qcBtn),
  msg);

  // ---- Quick Connect (only when an admin has turned it on) ----------------------------------
  const qcBody = h('div.qc');
  const qcDeck = deck('Quick Connect', { color: 'lilac', code: 'Q-C' }, qcBody);
  qcDeck.hidden = true;
  api.quickConnectEnabled().then(on => { qcBtn.hidden = on !== true; }).catch(() => {});

  let qcTimer = null;
  let qcCtrl = null;
  function stopQuickConnect() {
    clearInterval(qcTimer);
    qcCtrl?.abort();
    qcTimer = qcCtrl = null;
    qcDeck.hidden = true;
  }
  async function startQuickConnect() {
    stopQuickConnect();
    qcDeck.hidden = false;
    fill(qcBody, h('p.loading', 'Requesting a code…'));
    let r;
    try { r = await api.quickConnectStart(); } catch (e) {
      fill(qcBody, h('p.msg.bad', `Quick Connect unavailable: ${e.message}`));
      return;
    }
    if (!r?.Code || !r.Secret) { fill(qcBody, h('p.msg.bad', 'Quick Connect unavailable')); return; }
    fill(qcBody,
      h('p.dlg-text', 'On a device that’s already signed in, open Settings → Quick Connect (or the official app’s Quick Connect page) and enter:'),
      h('div.qc-code', { attrs: { 'aria-label': `Code ${r.Code.split('').join(' ')}` } }, r.Code),
      h('p.msg.blink', { attrs: { role: 'status' } }, 'Awaiting authorisation…'),
      h('div.actions', btn('Cancel', stopQuickConnect, { color: 'red', ghost: true }), btn('New code', startQuickConnect, { color: 'lilac', ghost: true })));
    qcCtrl = new AbortController();
    const ctrl = qcCtrl;
    // Every 5 seconds, as official, until it's authorised, the code expires or you leave.
    qcTimer = setInterval(async () => {
      if (!qcDeck.isConnected) { stopQuickConnect(); return; }
      let st;
      try { st = await api.quickConnectState(r.Secret, ctrl.signal); } catch (e) {
        if (ctrl.signal.aborted) return;
        stopQuickConnect();
        qcDeck.hidden = false;
        fill(qcBody, h('p.msg.bad', 'The code expired or Quick Connect was turned off.'), h('div.actions', btn('New code', startQuickConnect, { color: 'lilac' })));
        return;
      }
      if (!st?.Authenticated || ctrl.signal.aborted) return;
      stopQuickConnect();
      try {
        await api.quickConnectLogin(r.Secret);
        msg.className = 'msg';
        msg.textContent = 'Access granted';
        app.start();
      } catch (e) {
        msg.className = 'msg bad';
        msg.textContent = `Unable to comply: ${e.message}`;
      }
    }, 5000);
  }

  setTimeout(() => user.focus(), 0);
  return h('div.login',
    deck('Authorization required', { color: 'orange', code: '0-0-1' },
      users,
      form),
    qcDeck);
}
