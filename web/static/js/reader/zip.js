// Reads files out of a zip on the server without downloading all of it: the central
// directory comes from the end of the file, then each entry is fetched with a Range request
// and inflated by the browser (DecompressionStream). Small files are fetched whole instead.

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOC64 = 0x07064b50, CEN = 0x02014b50, LOC = 0x04034b50;
const TAIL = 65536 + 22;

export class RemoteZip {
  /** wholeBelow: files up to this size are fetched in one go (EPUBs: many small entries). */
  constructor(url, { signal, wholeBelow = 0 } = {}) {
    this.url = url;
    this.signal = signal;
    this.wholeBelow = wholeBelow;
    this.whole = null;
    this.size = 0;
    this.entries = [];
    this.byName = new Map();
  }

  async fetchRange(start, end) {
    if (this.whole) return this.whole.subarray(start, end + 1);
    const r = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` }, signal: this.signal });
    if (r.status === 200) { // the server ignored the range: keep the whole file
      this.whole = new Uint8Array(await r.arrayBuffer());
      return this.whole.subarray(start, end + 1);
    }
    if (r.status !== 206) throw new Error(`Book file: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async open() {
    const r = await fetch(this.url, { headers: { Range: `bytes=-${TAIL}` }, signal: this.signal });
    let tail, tailStart;
    if (r.status === 200) {
      this.whole = new Uint8Array(await r.arrayBuffer());
      this.size = this.whole.length;
      tail = this.whole; tailStart = 0;
    } else if (r.status === 206) {
      this.size = Number((r.headers.get('Content-Range') || '').split('/')[1]) || 0;
      tail = new Uint8Array(await r.arrayBuffer());
      tailStart = this.size - tail.length;
    } else {
      throw new Error(r.status === 401 || r.status === 403 ? 'Not allowed to open this book' : `Book file: HTTP ${r.status}`);
    }
    if (!this.whole && this.size && this.size <= this.wholeBelow) {
      const all = await fetch(this.url, { signal: this.signal });
      if (!all.ok) throw new Error(`Book file: HTTP ${all.status}`);
      this.whole = new Uint8Array(await all.arrayBuffer());
      tail = this.whole; tailStart = 0;
    }

    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === EOCD) { e = i; break; }
    if (e < 0) throw new Error('Not a zip file (cbr/cb7 are not supported)');
    let count = dv.getUint16(e + 10, true);
    let cdSize = dv.getUint32(e + 12, true);
    let cdOff = dv.getUint32(e + 16, true);
    if ((cdOff === 0xffffffff || count === 0xffff) && e >= 20 && dv.getUint32(e - 20, true) === LOC64) {
      const off64 = Number(dv.getBigUint64(e - 12, true));
      const z = await this.bytes(off64, 56, tail, tailStart);
      const zv = view(z);
      if (zv.getUint32(0, true) === EOCD64) {
        count = Number(zv.getBigUint64(32, true));
        cdSize = Number(zv.getBigUint64(40, true));
        cdOff = Number(zv.getBigUint64(48, true));
      }
    }
    const cd = await this.bytes(cdOff, cdSize, tail, tailStart);
    const cv = view(cd);
    const utf8 = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cv.getUint32(p, true) !== CEN) break;
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      let comp = cv.getUint32(p + 20, true);
      let size = cv.getUint32(p + 24, true);
      const nLen = cv.getUint16(p + 28, true), xLen = cv.getUint16(p + 30, true), cLen = cv.getUint16(p + 32, true);
      let offset = cv.getUint32(p + 42, true);
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nLen));
      // ZIP64 sizes and offset live in the 0x0001 extra field when the 32-bit ones are full.
      let x = p + 46 + nLen;
      const xEnd = x + xLen;
      while (x + 4 <= xEnd) {
        const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (size === 0xffffffff) { size = Number(cv.getBigUint64(q, true)); q += 8; }
          if (comp === 0xffffffff) { comp = Number(cv.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cv.getBigUint64(q, true)); }
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) {
        const entry = { name, method, comp, size, offset, nLen, xLen, encrypted: !!(flags & 1) };
        this.entries.push(entry);
        this.byName.set(name, entry);
      }
      p += 46 + nLen + xLen + cLen;
    }
    return this;
  }

  async bytes(start, len, tail, tailStart) {
    if (start >= tailStart && start + len <= tailStart + tail.length) return tail.subarray(start - tailStart, start - tailStart + len);
    return this.fetchRange(start, start + len - 1);
  }

  /** An entry by path, ignoring case if there's no exact match. */
  find(name) {
    if (this.byName.has(name)) return this.byName.get(name);
    const low = name.toLowerCase();
    return this.entries.find(e => e.name.toLowerCase() === low) || null;
  }

  /** The entry's bytes, inflated. */
  async read(entry) {
    if (entry.encrypted) throw new Error('Encrypted book');
    // The local header's extra field can differ from the central one, so ask for a little more.
    const want = 30 + entry.nLen + entry.xLen + entry.comp + 256;
    let buf = await this.fetchRange(entry.offset, Math.min(this.size, entry.offset + want) - 1);
    let lv = view(buf);
    if (lv.getUint32(0, true) !== LOC) throw new Error(`Damaged zip entry ${entry.name}`);
    const start = 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
    if (start + entry.comp > buf.length) buf = await this.fetchRange(entry.offset, entry.offset + start + entry.comp - 1);
    const data = buf.subarray(start, start + entry.comp);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error(`Unsupported compression in ${entry.name}`);
    const out = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  async blob(entry, type) { return new Blob([await this.read(entry)], { type: type || mimeOf(entry.name) }); }
  async text(entry) { return new TextDecoder().decode(await this.read(entry)); }
}

function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
export function mimeOf(name) { return MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream'; }
export const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
