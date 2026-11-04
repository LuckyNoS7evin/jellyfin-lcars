// What "Auto" quality means away from home: measure the connection to the server and stay under
// it, as the official client does (utils/bitrateTest.ts). Up to three downloads of
// /Playback/BitrateTest (500 KB, 1 MB, 3 MB), stopping when one is slower than its threshold;
// the result is 70% of the speed, kept for an hour. On the server's own network there's no limit,
// as before (official sets 140 Mbps there).

const TESTS = [[500_000, 500_000], [1_000_000, 20_000_000], [3_000_000, 50_000_000]]; // [bytes, bps threshold]
const TIMEOUT = 5000;
const KEEP = 3_600_000;
const MAX = 2_147_483_647;

let last = null;      // { bps, home, at }
let pending = null;

async function speed(api, bytes) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${api.base}/Playback/BitrateTest?Size=${bytes}`, {
      headers: { Authorization: api.authHeader(), 'Cache-Control': 'no-cache, no-store' },
      cache: 'no-store', signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`bitrate test: ${res.status}`);
    const t0 = performance.now(); // from the headers, as official: leaves out the server's start-up
    const got = (await res.arrayBuffer()).byteLength;
    return Math.round(got / Math.max((performance.now() - t0) / 1000, 0.001) * 8);
  } finally { clearTimeout(t); }
}

async function measure(api) {
  let home = false;
  try { home = !!(await api.get('/System/Endpoint'))?.IsInNetwork; } catch { /* treat as remote */ }
  if (home) return { bps: 0, home, at: Date.now() };
  let bps = 0;
  for (const [bytes, threshold] of TESTS) {
    try { bps = await speed(api, bytes); } catch { break; }
    if (bps < threshold) break;
  }
  // Every test failed: keep the last answer, or no limit.
  if (!bps) return last || { bps: 0, home, at: Date.now() };
  let cap = Math.min(Math.round(bps * 0.7), MAX);
  // Some browsers know the link's top speed (Mbps); official caps at 70% of it too.
  const top = navigator.connection?.downlinkMax;
  if (top > 0 && top < Infinity) cap = Math.min(cap, Math.round(top * 1e6 * 0.7));
  return { bps: cap, home, at: Date.now() };
}

/**
 * The bitrate limit for "Auto": bits per second, or 0 for no limit (home network, or unmeasurable).
 * force measures again even within the hour.
 */
export async function autoBitrate(api, { force = false } = {}) {
  if (!force && last && Date.now() - last.at < KEEP) return last.bps;
  pending ||= measure(api).then(r => { last = r; return r.bps; }).finally(() => { pending = null; });
  return pending;
}

/** The last measurement, for display: { bps, home, at } or null. */
export const lastMeasured = () => last;
