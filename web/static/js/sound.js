// LCARS panel chirps, synthesised with Web Audio (original sounds, nothing copied).
// Off by default; the choice is saved per browser.
import { store } from './api.js';

const KEY = 'jfl.sound';

export function startSound() {
  let on = store.get(KEY) === 'on';
  let ctx = null;

  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  };

  function tone(freqs, { len = 0.07, gap = 0.055, vol = 0.07, type = 'sine' } = {}) {
    if (!on) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + 0.01;
    freqs.forEach((fr, i) => {
      const t = t0 + i * gap;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      g.connect(c.destination);
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(fr, t);
      o.connect(g);
      o.start(t);
      o.stop(t + len + 0.02);
    });
  }

  const SOUNDS = {
    tap: () => tone([1480, 1980]),
    nav: () => tone([880, 1320], { len: 0.09 }),
    engage: () => tone([660, 990, 1480], { len: 0.1, gap: 0.07 }),
    deny: () => tone([440, 330], { len: 0.14, gap: 0.12, type: 'square', vol: 0.04 }),
  };

  // Every LCARS control chirps.
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest?.('.pill:not(.filler):not(.link), .btn, .tab, .card, .trk, .act, .user-btn');
    if (!el) return;
    if (el.classList.contains('pill')) SOUNDS.nav();
    else if (el.classList.contains('btn') && /engage|play|resume/i.test(el.textContent)) SOUNDS.engage();
    else SOUNDS.tap();
  }, { capture: true, passive: true });

  return {
    get on() { return on; },
    toggle() { on = !on; store.set(KEY, on ? 'on' : 'off'); if (on) SOUNDS.engage(); },
    play(name) { SOUNDS[name]?.(); },
  };
}
