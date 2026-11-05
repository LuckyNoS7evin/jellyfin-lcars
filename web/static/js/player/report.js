// Playback reporting: tells Jellyfin what is playing, where, and when it stops, so resume
// points, "played" marks and the server dashboard stay right.
import { TICKS } from '../api.js';

export class Reporter {
  /**
   * info: {itemId, mediaSourceId, playSessionId, playMethod, audioIndex, subIndex, live?}
   * state(): {position (s), paused, muted, volume (0..1)}
   */
  constructor(api, info, state) {
    this.api = api;
    this.info = info;
    this.state = state;
    this.timer = null;
    this.stopped = false;
  }

  body(extra = {}) {
    const s = this.state();
    const i = this.info;
    return {
      ItemId: i.itemId,
      MediaSourceId: i.mediaSourceId,
      PlaySessionId: i.playSessionId,
      PlayMethod: i.playMethod,
      AudioStreamIndex: i.audioIndex,
      SubtitleStreamIndex: i.subIndex ?? -1,
      PositionTicks: Math.max(0, Math.round((s.position || 0) * TICKS)),
      IsPaused: !!s.paused,
      IsMuted: !!s.muted,
      VolumeLevel: Math.round((s.volume ?? 1) * 100),
      CanSeek: true,
      PlaylistIndex: i.playlistIndex,
      // Which queue entry is playing (the same track can be queued twice). Jellyfin 12.4 keeps
      // NowPlayingQueue only from stop reports, so a remote sees the queue after the first track.
      PlaylistItemId: i.playlistItemId,
      PlaylistLength: i.playlistLength,
      // Music queue state, so other clients and the dashboard see repeat/shuffle and the queue.
      RepeatMode: s.repeat,
      PlaybackOrder: s.order,
      NowPlayingQueue: s.queue,
      ...extra,
    };
  }

  /** every: ms between progress reports, or 0 to report only when told (book pages). */
  start(every = 10000) {
    this.api.post('/Sessions/Playing', this.body()).catch(() => {});
    if (every) this.timer = setInterval(() => this.progress('TimeUpdate'), every);
  }

  progress(event) {
    if (this.stopped) return;
    this.api.post('/Sessions/Playing/Progress', this.body({ EventName: event })).catch(() => {});
  }

  /** keepalive so the report still goes out when the page is closing. */
  async stop({ failed = false } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    const b = this.body({ Failed: failed });
    try { await this.api.req('POST', '/Sessions/Playing/Stopped', { body: b, keepalive: true }); } catch { /* best effort */ }
    if (this.info.playMethod === 'Transcode') {
      // Stop the server's ffmpeg straight away instead of waiting for it to time out.
      this.api.del('/Videos/ActiveEncodings', { deviceId: this.api.deviceId, playSessionId: this.info.playSessionId }).catch(() => {});
    }
  }
}

/** POST /Items/{id}/PlaybackInfo and pick the media source. */
export async function playbackInfo(api, itemId, { profile, maxBitrate, mediaSourceId, audioIndex, subIndex, startTicks, directPlay = true, alwaysBurnIn = false, signal } = {}) {
  const r = await api.post(`/Items/${itemId}/PlaybackInfo`, {
    UserId: api.userId,
    DeviceProfile: profile,
    MaxStreamingBitrate: maxBitrate,
    StartTimeTicks: startTicks || 0,
    MediaSourceId: mediaSourceId,
    AudioStreamIndex: audioIndex,
    SubtitleStreamIndex: subIndex,
    EnableDirectPlay: directPlay,
    EnableDirectStream: directPlay,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
    AutoOpenLiveStream: true,
    AlwaysBurnInSubtitleWhenTranscoding: alwaysBurnIn,
  }, undefined, { signal });
  if (r.ErrorCode) {
    throw new Error({
      NotAllowed: 'This account isn\'t allowed to play this. An administrator can change it in Users.',
      NoCompatibleStream: 'No stream this device can play, and the server can\'t convert it (transcoding may be off for this account).',
      RateLimitExceeded: 'Too many streams at once for this account.',
    }[r.ErrorCode] || `Playback refused: ${r.ErrorCode}`);
  }
  const ms = (mediaSourceId && r.MediaSources.find(m => m.Id === mediaSourceId)) || r.MediaSources[0];
  if (!ms) throw new Error('No playable media source');
  return { ms, playSessionId: r.PlaySessionId };
}
