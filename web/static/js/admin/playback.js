// Playback (admin stage A4; official routes/playback): transcoding (the "encoding" named
// configuration), resume and streaming (the server configuration) and trickplay (its
// TrickplayOptions). The transcoding page shows what applies to the chosen hardware acceleration,
// as the official one does, and redraws when that changes.
import { h, fill } from '../h.js';
import { deck, toast } from '../ui.js';
import { editForm, row } from './form.js';

const HWA = [['None (software)', 'none'], ['AMD AMF', 'amf'], ['Nvidia NVENC', 'nvenc'], ['Intel Quick Sync (QSV)', 'qsv'],
  ['Video Acceleration API (VAAPI)', 'vaapi'], ['Rockchip MPP (RKMPP)', 'rkmpp'], ['Apple VideoToolbox', 'videotoolbox'], ['Video4Linux2 (V4L2)', 'v4l2m2m']];
// Official features/playback/constants/codecs.ts.
const CODECS = [['H.264', 'h264', 'amf nvenc qsv vaapi rkmpp videotoolbox v4l2m2m'], ['HEVC', 'hevc', 'amf nvenc qsv vaapi rkmpp videotoolbox'],
  ['MPEG-1', 'mpeg1video', 'rkmpp'], ['MPEG-2', 'mpeg2video', 'amf nvenc qsv vaapi rkmpp'], ['MPEG-4', 'mpeg4', 'nvenc rkmpp'],
  ['VC-1', 'vc1', 'amf nvenc qsv vaapi'], ['VP8', 'vp8', 'nvenc qsv vaapi rkmpp videotoolbox'], ['VP9', 'vp9', 'amf nvenc qsv vaapi rkmpp videotoolbox'],
  ['AV1', 'av1', 'amf nvenc qsv vaapi rkmpp videotoolbox']];
const TEN_BIT = ['amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp'];
const REXT = ['nvenc', 'qsv', 'vaapi'];
const HW_TYPES = ['amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox'];
const TM_ALGO = [['None', 'none'], ['Clip', 'clip'], ['Linear', 'linear'], ['Gamma', 'gamma'], ['Reinhard', 'reinhard'], ['Hable', 'hable'], ['Mobius', 'mobius'], ['BT.2390', 'bt2390']];
const TM_MODE = [['Auto', 'auto'], ['MAX', 'max'], ['RGB', 'rgb'], ['LUM', 'lum'], ['ITP', 'itp']];
const TM_RANGE = [['Auto', 'auto'], ['TV', 'tv'], ['PC', 'pc']];
const THREADS = [['Auto', -1], ...Array.from({ length: 16 }, (_, i) => [String(i + 1), i + 1]), ['Maximum', 0]];
const PRESETS = [['Auto', 'auto'], ...['veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'].map(p => [p, p])];
const DOWNMIX = [['None', 'None'], ['Dave750', 'Dave750'], ['Nightmode dialogue', 'NightmodeDialogue'], ['RFC 7845', 'Rfc7845'], ['AC-4', 'Ac4']];
const SEEK = [['Trim copied audio', 'TrimCopiedAudio'], ['Transcode audio', 'TranscodeAudio']];
const DEINT = [['Yadif', 'yadif'], ['Bwdif', 'bwdif']];
const PRIORITY = [['High', 'High'], ['Above normal', 'AboveNormal'], ['Normal', 'Normal'], ['Below normal', 'BelowNormal'], ['Idle', 'Idle']];
const SCAN = [['Don’t hold up the library scan', 'NonBlocking'], ['Finish before the scan carries on', 'Blocking']];

export async function playback(ctx) {
  const [tab = 'transcoding'] = ctx.sub;
  const page = { transcoding, resume, streaming, trickplay }[tab] || transcoding;
  ctx.setParent('#/admin/overview');
  return h('div.eng-edit', subTabs(tab), await page(ctx));
}

const subTabs = cur => h('div.tabs.eng-subtabs', [['transcoding', 'Transcoding'], ['resume', 'Resume'], ['streaming', 'Streaming'], ['trickplay', 'Trickplay']]
  .map(([k, l]) => h('a.tab', { href: `#/admin/playback/${k}`, class: k === cur ? 'on' : '' }, l)));

// ---- transcoding ---------------------------------------------------------------------------------

async function transcoding(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Transcoding');
  const fo = editForm({ app, load: () => api.get('/System/Configuration/encoding'), save: d => api.post('/System/Configuration/encoding', d) });
  await fo.ready;
  const body = h('div');

  function draw() {
    fo.controls.length = 0; // a redraw makes new controls
    const hw = fo.get('HardwareAccelerationType') || 'none';
    const isHw = HW_TYPES.includes(hw);
    const t = k => fo.toggle(k);
    const show = (c, ...r) => (c ? r : null);
    const hwSel = fo.select('HardwareAccelerationType', HWA);
    hwSel.addEventListener('change', () => {
      draw();
      if (fo.get('HardwareAccelerationType') !== 'none') toast('Hardware acceleration', 'The server needs the GPU passed through to its container, and drivers for it, or transcodes fail', 'peach', 7000);
    });

    const hardware = deck('Hardware acceleration', { color: 'orange', num: 1 },
      row('Acceleration', hwSel, 'Which GPU (or none) ffmpeg uses'),
      show(hw === 'vaapi', row('VAAPI device', fo.text('VaapiDevice', { placeholder: '/dev/dri/renderD128' }))),
      show(hw === 'qsv', row('QSV device', fo.text('QsvDevice', { placeholder: 'Leave empty for the default' }))),
      show(hw !== 'none',
        h('h3.set-h', 'Hardware decoding for'),
        fo.checklist('HardwareDecodingCodecs', CODECS.filter(([, , types]) => types.split(' ').includes(hw)).map(([l, c]) => [l, c])),
        show(TEN_BIT.includes(hw), row('HEVC 10-bit', t('EnableDecodingColorDepth10Hevc')), row('VP9 10-bit', t('EnableDecodingColorDepth10Vp9'))),
        show(REXT.includes(hw), row('HEVC RExt 8/10-bit', t('EnableDecodingColorDepth10HevcRext')), row('HEVC RExt 12-bit', t('EnableDecodingColorDepth12HevcRext')))),
      show(hw === 'nvenc', row('Enhanced NVDEC decoder', t('EnableEnhancedNvdecDecoder'))),
      show(hw === 'qsv', row('Prefer the system’s native decoder', t('PreferSystemNativeHwDecoder'), 'DXVA or VA-API')),
      show(hw !== 'none',
        h('h3.set-h', 'Hardware encoding'),
        row('Hardware encoding', t('EnableHardwareEncoding')),
        show(hw === 'qsv' || hw === 'vaapi', row('Intel low-power H.264 encoder', t('EnableIntelLowPowerH264HwEncoder')),
          row('Intel low-power HEVC encoder', t('EnableIntelLowPowerHevcHwEncoder')))));

    const formats = deck('Encoding formats', { color: 'peach', num: 2 },
      h('p.dlg-note', 'H.264 is always allowed. These can be smaller at the same quality, if the client plays them.'),
      row('Allow HEVC', t('AllowHevcEncoding')),
      row('Allow AV1', t('AllowAv1Encoding')));

    const tone = deck('HDR tone mapping', { color: 'lilac', num: 3 },
      show(hw === 'qsv' || hw === 'vaapi', row('VPP tone mapping', t('EnableVppTonemapping'), 'Intel’s own; HDR10 only'),
        row('VPP brightness', fo.num('VppTonemappingBrightness', { min: 0, max: 100, step: 1, int: false })),
        row('VPP contrast', fo.num('VppTonemappingContrast', { min: 0, max: 2, step: 0.1, int: false }))),
      show(hw === 'videotoolbox', row('VideoToolbox tone mapping', t('EnableVideoToolboxTonemapping'))),
      show(hw === 'none' || isHw,
        row('Tone mapping', t('EnableTonemapping'), 'Turn HDR into SDR when transcoding'),
        row('Algorithm', fo.select('TonemappingAlgorithm', TM_ALGO)),
        row('Mode', fo.select('TonemappingMode', TM_MODE)),
        row('Range', fo.select('TonemappingRange', TM_RANGE)),
        row('Desaturation', fo.num('TonemappingDesat', { min: 0, step: 0.01, int: false }), 'Usually 0'),
        row('Peak (nits)', fo.num('TonemappingPeak', { min: 0, step: 1, int: false }), 'Usually 100'),
        row('Parameter', fo.num('TonemappingParam', { min: 0, step: 0.01, int: false }), 'Usually 0 (the algorithm’s default)')));

    const general = deck('Encoding', { color: 'sky', num: 4 },
      row('Encoder threads', fo.select('EncodingThreadCount', THREADS)),
      row('Encoder preset', fo.select('EncoderPreset', PRESETS), 'Faster: less CPU, bigger or worse pictures'),
      row('H.265 CRF', fo.num('H265Crf', { min: 0, max: 51 }), 'Quality for software HEVC; lower is better (28 is usual)'),
      row('H.264 CRF', fo.num('H264Crf', { min: 0, max: 51 }), 'Quality for software H.264 (23 is usual)'),
      row('Deinterlacing', fo.select('DeinterlaceMethod', DEINT)),
      row('Double-rate deinterlacing', t('DeinterlaceDoubleRate'), 'Smoother motion, more work'),
      row('Variable bitrate audio', t('EnableAudioVbr')),
      row('Stereo downmix boost', fo.num('DownMixAudioBoost', { min: 0.5, max: 3, step: 0.1, int: false }), 'Louder when 5.1 or 7.1 becomes stereo'),
      row('Stereo downmix', fo.select('DownMixStereoAlgorithm', DOWNMIX)),
      row('Seeking in HLS audio', fo.select('HlsAudioSeekStrategy', SEEK)),
      row('Max muxing queue', fo.num('MaxMuxingQueueSize', { min: 128 }), 'Raise if transcodes fail with "Too many packets buffered"'));

    const files = deck('Files and paths', { color: 'blue', num: 5 },
      row('ffmpeg', h('span.eng-ro', fo.get('EncoderAppPathDisplay') || fo.get('EncoderAppPath') || 'built in'), 'Set when the server starts'),
      row('Transcode folder', fo.path('TranscodingTempPath', api), 'Where segments go while streaming'),
      row('Fallback fonts', fo.path('FallbackFontPath', api), 'For subtitles whose fonts aren’t in the file'),
      row('Use the fallback fonts', t('EnableFallbackFont')),
      row('Extract subtitles while playing', t('EnableSubtitleExtraction'), 'Lets players fetch text subtitles from inside the file'),
      h('h3.set-h', 'Throttling and clean-up'),
      row('Throttle transcodes', t('EnableThrottling'), 'Pause ffmpeg when it’s far enough ahead of the player'),
      row('… after (seconds ahead)', fo.num('ThrottleDelaySeconds', { min: 60 })),
      row('Delete old segments', t('EnableSegmentDeletion'), 'Keeps the transcode folder small'),
      row('… keep (seconds)', fo.num('SegmentKeepSeconds', { min: 120 })));

    fill(body, h('div.eng-grid', h('div.eng-col', hardware, formats, tone), h('div.eng-col', general, files)));
  }
  draw();
  return [body, fo.bar];
}

// ---- resume ---------------------------------------------------------------------------------------

async function resume(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Resume');
  const fo = editForm({ app, load: () => api.get('/System/Configuration'), save: d => api.post('/System/Configuration', d) });
  await fo.ready;
  return [deck('Resume', { color: 'orange', num: 1 },
    h('p.dlg-note', 'When something counts as started (so it shows in Continue watching) and when it counts as watched.'),
    row('Started after (%)', fo.num('MinResumePct', { min: 0, max: 100 }), 'Stopping before this leaves it unwatched'),
    row('Watched after (%)', fo.num('MaxResumePct', { min: 1, max: 100 }), 'Stopping after this marks it watched'),
    row('Shortest that can resume (seconds)', fo.num('MinResumeDurationSeconds', { min: 0 }), 'Anything shorter always starts from the beginning'),
    h('h3.set-h', 'Audiobooks'),
    row('Started after (minutes)', fo.num('MinAudiobookResume', { min: 0 })),
    row('Finished with (minutes left)', fo.num('MaxAudiobookResume', { min: 1 }))), fo.bar];
}

// ---- streaming ------------------------------------------------------------------------------------

async function streaming(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Streaming');
  const fo = editForm({ app, load: () => api.get('/System/Configuration'), save: d => api.post('/System/Configuration', d) });
  await fo.ready;
  return [deck('Streaming', { color: 'sky', num: 1 },
    row('Internet streaming limit (Mbps)', fo.num('RemoteClientBitrateLimit', { min: 0, step: 0.1, scale: 1e6, zero: 0, placeholder: 'No limit' }),
      'For every remote client; users can have a lower one of their own. Empty: no limit')), fo.bar];
}

// ---- trickplay ------------------------------------------------------------------------------------

async function trickplay(ctx) {
  const { api, app } = ctx;
  ctx.setTitle('Trickplay');
  const fo = editForm({ app, load: () => api.get('/System/Configuration'), save: d => api.post('/System/Configuration', d) });
  await fo.ready;
  const T = k => `TrickplayOptions.${k}`;
  // Widths as a comma list ("320, 640").
  const widths = h('input.inp', { attrs: { spellcheck: 'false', placeholder: '320' } });
  const syncW = () => { widths.value = (fo.get(T('WidthResolutions')) || []).join(', '); };
  widths.addEventListener('input', () => fo.set(T('WidthResolutions'), widths.value.split(/[,\s]+/).map(Number).filter(n => n > 0)));
  fo.controls.push({ sync: syncW });
  syncW();
  return [deck('Trickplay', { color: 'lilac', num: 1 },
    h('p.dlg-note', 'The preview pictures shown while you scrub. Libraries turn their extraction on (Libraries → a library → Chapters and trickplay).'),
    row('Hardware decoding', fo.toggle(T('EnableHwAcceleration')), 'Uses the transcoding settings’ acceleration'),
    row('Hardware encoding', fo.toggle(T('EnableHwEncoding')), 'MJPEG on the GPU, where it can'),
    row('Key frames only', fo.toggle(T('EnableKeyFrameOnlyExtraction')), 'Much faster; previews land on key frames'),
    row('During library scans', fo.select(T('ScanBehavior'), SCAN)),
    row('ffmpeg priority', fo.select(T('ProcessPriority'), PRIORITY)),
    row('Interval (milliseconds)', fo.num(T('Interval'), { min: 1000, step: 1000 }), 'How often a picture is taken'),
    row('Widths (pixels)', widths, 'One set of pictures per width, comma separated'),
    row('Tile columns', fo.num(T('TileWidth'), { min: 1 })),
    row('Tile rows', fo.num(T('TileHeight'), { min: 1 })),
    row('JPEG quality', fo.num(T('JpegQuality'), { min: 1, max: 100 })),
    row('Qscale', fo.num(T('Qscale'), { min: 2, max: 31 }), '2 to 31; lower is better, bigger files'),
    row('ffmpeg threads', fo.num(T('ProcessThreads'), { min: 0 }), '0: automatic')), fo.bar];
}
