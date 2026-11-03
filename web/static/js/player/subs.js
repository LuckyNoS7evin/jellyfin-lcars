// Subtitles the browser draws itself instead of the server burning them into the picture:
//   - ASS/SSA (styled anime subtitles) with libass compiled to WebAssembly (@jellyfin/libass-wasm,
//     the official client's renderer), using the fonts attached to the file
//   - PGS (Blu-ray picture subtitles) with libbitsub, as the official client does
// Both draw on a canvas laid over the video. Plain text subtitles stay <track>s.

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const ASS = new Set(['ass', 'ssa']);
const PGS = new Set(['pgssub', 'pgs']);
const FONT_TYPES = new Set(['application/vnd.ms-opentype', 'application/x-truetype-font', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2', 'application/x-font-ttf', 'application/font-sfnt']);

/** 'ass' | 'pgs' | null: whether this stream needs one of the canvas renderers. */
export function canvasKind(stream) {
  const c = (stream?.Codec || '').toLowerCase();
  if (ASS.has(c)) return 'ass';
  if (PGS.has(c)) return 'pgs';
  return null;
}

/**
 * Subtitle formats to ask the server for as files rather than burned in, by the per-device
 * setting (the official "Burn in subtitles" choice): 'auto' draws both here, 'onlyimageformats'
 * burns in PGS only, 'allcomplexformats' burns in both.
 */
export function externalFormats(burnIn) {
  if (burnIn === 'allcomplexformats') return [];
  if (burnIn === 'onlyimageformats') return ['ass', 'ssa'];
  return ['ass', 'ssa', 'pgssub'];
}

function withKey(api, url) {
  const u = api.url(url.replace(/^\/+/, '/'));
  return /[?&](api_key|ApiKey)=/i.test(u) ? u : `${u}${u.includes('?') ? '&' : '?'}ApiKey=${encodeURIComponent(api.token)}`;
}

let octopusP = null;
function loadOctopus() {
  // A classic script that defines window.SubtitlesOctopus.
  octopusP ||= new Promise((resolve, reject) => {
    if (window.SubtitlesOctopus) { resolve(window.SubtitlesOctopus); return; }
    const s = document.createElement('script');
    s.src = `${VENDOR}libass/subtitles-octopus.js`;
    s.onload = () => (window.SubtitlesOctopus ? resolve(window.SubtitlesOctopus) : reject(new Error('libass did not load')));
    s.onerror = () => { octopusP = null; reject(new Error('libass did not load')); };
    document.head.append(s);
  });
  return octopusP;
}

/**
 * Start drawing `stream` over `video`. Returns {setDelay(seconds), destroy()}. onError(err) is
 * called if the renderer fails, so the player can fall back to burning the subtitles in.
 * delay: seconds to show the subtitles later (negative: earlier), as mpv's sub-delay.
 */
export async function drawSubtitles(api, video, stream, ms, { onError, delay = 0 } = {}) {
  const kind = canvasKind(stream);
  const subUrl = withKey(api, stream.DeliveryUrl);

  if (kind === 'ass') {
    const SubtitlesOctopus = await loadOctopus();
    const fonts = (ms.MediaAttachments || [])
      .filter(a => a.DeliveryUrl && (FONT_TYPES.has((a.MimeType || '').toLowerCase()) || /\.(ttf|otf|ttc|woff2?)$/i.test(a.FileName || '')))
      .map(a => withKey(api, a.DeliveryUrl));
    const vs = (ms.MediaStreams || []).find(s => s.Type === 'Video');
    let failed = false;
    const r = new SubtitlesOctopus({
      video,
      subUrl,
      fonts,
      fallbackFont: `${VENDOR}libass/default.woff2`,
      workerUrl: `${VENDOR}libass/subtitles-octopus-worker.js`,
      // The same tuning as the official client.
      renderMode: 'wasm-blend',
      dropAllAnimations: false,
      libassMemoryLimit: 40,
      libassGlyphLimit: 40,
      targetFps: vs?.ReferenceFrameRate || vs?.RealFrameRate || 24,
      prescaleFactor: 0.8,
      prescaleHeightLimit: 1080,
      maxRenderHeight: 2160,
      resizeVariation: 0.2,
      renderAhead: 90,
      timeOffset: -delay,
      onError: () => { if (!failed) { failed = true; onError?.(new Error('libass failed')); } },
    });
    return {
      kind,
      setDelay: d => { r.timeOffset = -d; },
      destroy: () => { try { r.dispose(); } catch { /* already gone */ } },
    };
  }

  if (kind === 'pgs') {
    const { PgsRenderer } = await import('../../vendor/libbitsub/dist/index.js');
    let r = null;
    let failed = false;
    r = new PgsRenderer({
      video,
      subUrl,
      streamingLoad: true,
      rangeRequests: true,
      prefetchWindow: { before: 1, after: 2 },
      timeOffset: -delay,
      onLoaded: () => r?.updateCanvasSize?.(),
      onError: e => { if (!failed) { failed = true; onError?.(e || new Error('PGS failed')); } },
    });
    requestAnimationFrame(() => r?.updateCanvasSize?.());
    const resize = () => r?.updateCanvasSize?.();
    window.addEventListener('resize', resize);
    video.addEventListener('loadedmetadata', resize);
    return {
      kind,
      setDelay: d => { if (r) r.timeOffset = -d; },
      destroy: () => {
        window.removeEventListener('resize', resize);
        video.removeEventListener('loadedmetadata', resize);
        try { r.dispose(); } catch { /* already gone */ }
        r = null;
      },
    };
  }
  return null;
}
