// Reads a tar (cbt) for the comic reader. A tar has no index, so the whole file is fetched once
// (as the official reader does), then its headers are walked. Gzipped tars are unpacked first.
// Same calls as RemoteZip: entries, find(name), read(entry), blob(entry), text(entry).
import { mimeOf } from './zip.js';

export class RemoteTar {
  /** onProgress(fraction) while downloading, when the size is known. */
  constructor(url, { signal, onProgress } = {}) {
    this.url = url;
    this.signal = signal;
    this.onProgress = onProgress;
    this.entries = [];
    this.byName = new Map();
  }

  async open() {
    const r = await fetch(this.url, { signal: this.signal });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Not allowed to open this book' : `Book file: HTTP ${r.status}`);
    let buf = await readAll(r, this.onProgress);
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const out = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf = new Uint8Array(await new Response(out).arrayBuffer());
    }
    this.parse(buf);
    if (!this.entries.length) throw new Error('Not a tar file');
    return this;
  }

  parse(buf) {
    const ascii = new TextDecoder('utf-8');
    const str = (o, n) => { const s = buf.subarray(o, o + n); const z = s.indexOf(0); return ascii.decode(z < 0 ? s : s.subarray(0, z)); };
    let p = 0;
    let longName = null;   // GNU 'L' entry: the next entry's name
    let paxPath = null;    // PAX 'x' entry: path= for the next entry
    while (p + 512 <= buf.length) {
      if (buf[p] === 0 && buf.subarray(p, p + 512).every(b => b === 0)) break; // end of archive
      if (str(p + 257, 5) !== 'ustar' && !checksumOk(buf, p)) throw new Error('Damaged tar file');
      const size = sizeOf(buf, p + 124);
      const type = String.fromCharCode(buf[p + 156] || 0x30);
      const data = p + 512;
      if (data + size > buf.length) throw new Error('Damaged tar file (cut short)');
      if (type === 'L') {
        longName = str(data, size);
      } else if (type === 'x') {
        const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(ascii.decode(buf.subarray(data, data + size)));
        paxPath = m ? m[1] : null;
      } else if (type === 'g') {
        // global PAX header: nothing a comic needs
      } else {
        const prefix = str(p + 157 + 188, 155); // ustar prefix (bytes 345-500)
        const name = paxPath || longName || (prefix ? `${prefix}/${str(p, 100)}` : str(p, 100));
        if ((type === '0' || type === '7') && !name.endsWith('/')) {
          const entry = { name, size, data: buf.subarray(data, data + size) };
          this.entries.push(entry);
          this.byName.set(name, entry);
        }
        longName = paxPath = null;
      }
      p = data + Math.ceil(size / 512) * 512;
    }
  }

  find(name) {
    if (this.byName.has(name)) return this.byName.get(name);
    const low = name.toLowerCase();
    return this.entries.find(e => e.name.toLowerCase() === low) || null;
  }

  async read(entry) { return entry.data; }
  async blob(entry, type) { return new Blob([entry.data], { type: type || mimeOf(entry.name) }); }
  async text(entry) { return new TextDecoder().decode(entry.data); }
}

/** The response body, reporting progress as it comes. */
async function readAll(r, onProgress) {
  const total = Number(r.headers.get('Content-Length')) || 0;
  if (!r.body || !total || !onProgress) return new Uint8Array(await r.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = r.body.getReader();
  let got = 0;
  let extra = null; // more than Content-Length said (shouldn't happen): fall back to joining
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!extra && got + value.length <= total) out.set(value, got);
    else (extra ||= [out.subarray(0, got)]).push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  if (extra) return new Uint8Array(await new Blob(extra).arrayBuffer());
  return out.subarray(0, got);
}

/** Octal size, or GNU base-256 for files of 8 GB and over. */
function sizeOf(buf, o) {
  if (buf[o] & 0x80) {
    let n = 0;
    for (let i = 1; i < 12; i++) n = n * 256 + buf[o + i];
    return n;
  }
  let s = '';
  for (let i = 0; i < 12 && buf[o + i] && buf[o + i] !== 0x20; i++) s += String.fromCharCode(buf[o + i]);
  return parseInt(s, 8) || 0;
}

/** Old (pre-POSIX) tars have no magic: check the header's checksum instead. */
function checksumOk(buf, p) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[p + i];
  return sum === sizeOf(buf, p + 148);
}
