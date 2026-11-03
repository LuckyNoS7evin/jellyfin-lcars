// A Jellyfin DeviceProfile describing what this browser can play, so the server can decide
// between direct play, remux and transcode. Anything we can't play natively goes through
// HLS (hls.js on top of Media Source Extensions).

const v = document.createElement('video');
const can = t => !!v.canPlayType(t).replace('no', '');
const mse = t => !!window.MediaSource?.isTypeSupported?.(t);
const either = t => can(t) || mse(t);

export function caps() {
  return {
    h264: either('video/mp4; codecs="avc1.640029"'),
    hevc: either('video/mp4; codecs="hvc1.1.6.L120.90"') || either('video/mp4; codecs="hev1.1.6.L120.90"'),
    av1: either('video/mp4; codecs="av01.0.08M.08"'),
    vp9: either('video/webm; codecs="vp9"'),
    aac: either('audio/mp4; codecs="mp4a.40.2"'),
    mp3: can('audio/mpeg'),
    opus: either('audio/webm; codecs="opus"') || either('audio/mp4; codecs="opus"'),
    flac: can('audio/flac') || either('audio/mp4; codecs="flac"'),
    ac3: either('audio/mp4; codecs="ac-3"'),
    eac3: either('audio/mp4; codecs="ec-3"'),
    vorbis: either('audio/webm; codecs="vorbis"'),
    nativeHls: can('application/vnd.apple.mpegurl'),
  };
}

// Put a preferred codec first in a comma list, if it's there (official apphost.js).
const prefer = (list, codec) => {
  const a = list.split(',');
  const i = codec ? a.indexOf(codec) : -1;
  if (i > 0) { a.splice(i, 1); a.unshift(codec); }
  return a.join(',');
};

/**
 * external: subtitle formats the browser draws itself (player/subs.js externalFormats).
 * The rest are the playback settings (settings.js `playback`): maxWidth caps transcodes, and
 * direct play too with limitWidth; audioChannels caps channels (0 = up to 5.1);
 * videoCodec/audioCodec are tried first when transcoding.
 */
export function deviceProfile({ maxBitrate, external = [], maxWidth = 0, limitWidth = false, audioChannels = 0, videoCodec = '', audioCodec = '' } = {}) {
  const c = caps();
  const vMp4 = ['h264', c.hevc && 'hevc', c.av1 && 'av1', c.vp9 && 'vp9'].filter(Boolean).join(',');
  const aMp4 = ['aac', 'mp3', c.opus && 'opus', c.flac && 'flac', c.ac3 && 'ac3', c.eac3 && 'eac3'].filter(Boolean).join(',');
  const vWebm = ['vp8', c.vp9 && 'vp9', c.av1 && 'av1'].filter(Boolean).join(',');
  const aWebm = ['vorbis', c.opus && 'opus'].filter(Boolean).join(',');
  // fMP4 HLS lets the server copy HEVC/AV1 instead of re-encoding when the browser decodes it.
  const hlsV = ['h264', c.hevc && 'hevc', c.av1 && 'av1'].filter(Boolean).join(',');
  const hlsA = ['aac', 'mp3', c.opus && 'opus', c.flac && 'flac', c.ac3 && 'ac3', c.eac3 && 'eac3'].filter(Boolean).join(',');
  const channels = audioChannels > 0 ? audioChannels : 6;
  const width = maxWidth > 0 ? [{ Condition: 'LessThanEqual', Property: 'Width', Value: String(maxWidth), IsRequired: false }] : [];

  return {
    Name: 'LCARS Web',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: 200_000_000,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: vMp4, AudioCodec: aMp4 },
      // Chromium plays Matroska through its WebM demuxer when the codecs are supported.
      ...(/Chrome\//.test(navigator.userAgent) ? [{ Container: 'mkv', Type: 'Video', VideoCodec: vMp4, AudioCodec: aMp4 }] : []),
      { Container: 'webm', Type: 'Video', VideoCodec: vWebm, AudioCodec: aWebm },
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac' },
      ...(c.flac ? [{ Container: 'flac', Type: 'Audio' }] : []),
      ...(c.opus ? [{ Container: 'webm,ogg,opus', Type: 'Audio', AudioCodec: 'opus' }] : []),
      ...(c.vorbis ? [{ Container: 'ogg,webm', Type: 'Audio', AudioCodec: 'vorbis' }] : []),
      { Container: 'wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: 'mp4', Type: 'Video', Protocol: 'hls', Context: 'Streaming',
        VideoCodec: prefer(hlsV, videoCodec), AudioCodec: prefer(hlsA, audioCodec), MaxAudioChannels: String(channels),
        MinSegments: 1, BreakOnNonKeyFrames: true, CopyTimestamps: false, Conditions: width,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming', MaxAudioChannels: '2' },
      { Container: 'aac', Type: 'Audio', AudioCodec: 'aac', Protocol: 'http', Context: 'Static', MaxAudioChannels: '2' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      // Browsers can't decode 10-bit H.264 (common in older anime releases).
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }] },
      // No browser decodes interlaced H.264 cleanly.
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true', IsRequired: false }] },
      ...(limitWidth && width.length ? [{ Type: 'Video', Conditions: width }] : []),
      // More channels than allowed: the server downmixes.
      ...(audioChannels > 0 ? [{ Type: 'VideoAudio', Conditions: [{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(audioChannels), IsRequired: false }] }] : []),
    ],
    SubtitleProfiles: [
      // <track> only reads WebVTT: the server converts SRT and other text formats to it.
      { Format: 'vtt', Method: 'External' },
      // Styled (ASS/SSA) and Blu-ray picture (PGS) subtitles are drawn here (player/subs.js)
      // unless the device setting or a failed render says to burn them in.
      ...['ass', 'ssa', 'pgssub'].map(f => ({ Format: f, Method: external.includes(f) ? 'External' : 'Encode' })),
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
    ],
    ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
  };
}
