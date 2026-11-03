// PDF books through pdf.js (vendor/pdfjs, Mozilla's renderer, as the official client uses): the
// file is read in ranges as pages are needed, each page drawn to a canvas at the screen's
// resolution and handed to the page reader as an image, so PDFs turn, pair and read
// right-to-left like comics. Scanned manga and novels are pages of pictures; text PDFs draw too.
import { pagedEngine } from './comic.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url).href;
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import(`${VENDOR}pdf.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;
  }
  return lib;
}

export async function pdfEngine(ctx) {
  const { url, signal } = ctx;
  const { getDocument } = await pdfjs();
  const task = getDocument({
    url,
    // Only the parts of the file a page needs, in 256 KB ranges, rather than all of it first.
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 << 10,
    // The page's CSP has no 'unsafe-eval'; pdf.js has a slower path that doesn't need it.
    isEvalSupported: false,
    enableXfa: false,
    wasmUrl: `${VENDOR}wasm/`,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
  });
  signal?.addEventListener('abort', () => task.destroy());
  const doc = await task.promise;

  // Right-to-left isn't something a PDF says; the reader remembers it per series instead.
  async function blob(i) {
    const page = await doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    // Sharp on this screen at full height, without huge canvases for huge pages.
    const want = Math.max(innerHeight, innerWidth / 2) * (devicePixelRatio || 1);
    const scale = Math.min(Math.max(want / base.height, 0.5), 4000 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
    const b = await new Promise((resolve, reject) => canvas.toBlob(x => (x ? resolve(x) : reject(new Error('Page could not be drawn'))), 'image/jpeg', 0.92));
    canvas.width = canvas.height = 0;
    return b;
  }

  return pagedEngine(ctx, { n: doc.numPages, format: 'PDF', manga: null, blob, destroy: () => task.destroy() });
}
