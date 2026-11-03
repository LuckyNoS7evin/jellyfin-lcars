// Formatting helpers shared by both themes.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(n, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  const v = n / 1000 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${UNITS[i]}`;
}

export function speed(bps) {
  return bps > 0 ? `${bytes(bps)}/s` : '0 B/s';
}

export function num(n) {
  if (!Number.isFinite(n)) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return n.toLocaleString();
}

export function pct(f, digits = 0) {
  return Number.isFinite(f) ? `${f.toFixed(digits)}%` : '–';
}

/** dur(seconds) -> "1h 23m", "4m 05s", "2d 3h" */
export function dur(s) {
  if (!Number.isFinite(s) || s < 0) return '–';
  s = Math.round(s);
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** clock(seconds) -> "1:02:03" or "2:03" for media positions. */
export function clock(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : m;
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

const day = 86400000;
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** dayLabel(iso) -> "Today", "Tomorrow", "Yesterday", "Sat 2 Nov" */
export function dayLabel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.round((startOfDay(t) - startOfDay(Date.now())) / day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function time(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** True when the timestamp is exactly midnight UTC: a date with no real time (releases). */
export function dateOnly(iso) { return /T00:00:00(\.0+)?Z$/.test(iso || ''); }

/** ago(iso or ms) -> "5m ago", "3h ago", "2d ago" */
export function ago(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Level colour class from a 0..1 fraction (VoStack thresholds: 0.6 / 0.85). */
export function level(f) {
  return f < 0.6 ? 'ok' : f < 0.85 ? 'warn' : 'bad';
}

/**
 * Star Trek Online's stardate: 1000 stardates per (mean Gregorian) year, counted from
 * 25 May 1922 (the game launched on stardate 86088.58).
 */
const STO_EPOCH = Date.UTC(1922, 4, 25);
const YEAR_MS = 365.2425 * 86400000;
export function stardate(d = new Date()) {
  return ((d.getTime() - STO_EPOCH) / YEAR_MS * 1000).toFixed(2);
}
