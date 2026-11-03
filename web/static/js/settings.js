// User settings, kept where the official clients keep them so the two stay in step:
//   - the user's Jellyfin configuration (languages, subtitle mode, home libraries...)
//   - display preferences on the server ("usersettings", client "emby"): home sections,
//     skip lengths, Next Up options, per-library sorts
//   - per-device settings in this browser (theme songs/videos, backdrops, bitrate), which
//     the official web client also keeps per device.
import { store } from './api.js';

// Official defaults (userSettings.js defaultSubtitleAppearanceSettings plus the helper's
// fallbacks): medium text, normal weight, drop shadow, white, no background, 3 lines up.
export const SUBTITLE_DEFAULTS = {
  textSize: 'medium', textWeight: 'normal', font: '', textColor: '#FFFFFF',
  textBackground: 'transparent', dropShadow: 'dropshadow', verticalPosition: -3,
};

export class UserSettings {
  // userId: whose settings (an admin may edit another user's; their device settings stay theirs).
  constructor(api, userId = api.userId) {
    this.api = api;
    this.userId = userId;
    this.me = null;
    this.dp = null; // the whole DisplayPreferences object
  }

  async load() {
    const [me, dp] = await Promise.all([
      this.userId === this.api.userId ? this.api.me() : this.api.get(`/Users/${this.userId}`),
      this.api.get('/DisplayPreferences/usersettings', { userId: this.userId, client: 'emby' }).catch(() => null),
    ]);
    this.me = me;
    this.dp = dp || { Id: 'usersettings', Client: 'emby', CustomPrefs: {} };
    this.dp.CustomPrefs ||= {};
  }

  get config() { return this.me?.Configuration || {}; }
  get display() { return this.dp?.CustomPrefs || {}; }

  // ---- server display preferences -------------------------------------------------------

  pref(key, def = null) {
    const v = this.display[key];
    return v == null || v === '' ? def : v;
  }
  bool(key, def = false) {
    const v = this.pref(key);
    return v == null ? def : String(v).toLowerCase() === 'true';
  }
  num(key, def) {
    const v = Number(this.pref(key));
    return Number.isFinite(v) && this.pref(key) != null ? v : def;
  }

  /** Read-modify-write so changes made by another client meanwhile aren't lost. */
  async setPrefs(patch) {
    const q = { userId: this.userId, client: 'emby' };
    let fresh;
    try { fresh = await this.api.get('/DisplayPreferences/usersettings', q); } catch { fresh = this.dp; }
    fresh.CustomPrefs ||= {};
    for (const [k, v] of Object.entries(patch)) fresh.CustomPrefs[k] = v == null ? null : String(v);
    await this.api.post('/DisplayPreferences/usersettings', fresh, q);
    this.dp = fresh;
  }
  setPref(key, value) { return this.setPrefs({ [key]: value }); }

  // ---- the user's Jellyfin configuration --------------------------------------------------

  async saveConfig(patch) {
    const cfg = { ...this.config, ...patch };
    await this.api.post('/Users/Configuration', cfg, { userId: this.userId });
    this.me.Configuration = cfg;
  }

  async changePassword(current, next) {
    await this.api.post('/Users/Password', { CurrentPw: current, NewPw: next }, { userId: this.api.userId });
  }

  // ---- this device ------------------------------------------------------------------------

  local(key, def) {
    const v = store.get(`jfl.${this.api.userId}.${key}`);
    if (v == null) return def;
    try { return JSON.parse(v); } catch { return def; }
  }
  setLocal(key, value) { store.set(`jfl.${this.api.userId}.${key}`, JSON.stringify(value)); }

  // ---- the settings the app reads -----------------------------------------------------------

  get themeSongs() { return this.local('themeSongs', false); }
  get themeVideos() { return this.local('themeVideos', false); }
  // Official defaults: full-page backdrops off, details banner on (both per device).
  get backdrops() { return this.local('backdrops', false); }
  get detailsBanner() { return this.local('detailsBanner', true); }
  get maxBitrate() { return this.local('maxBitrate', 0); }
  // Music over the internet (official "Music quality"): 0 is as the files are.
  get maxMusicBitrate() { return this.local('maxMusicBitrate', 0); }
  get episodeImages() { return this.bool('useEpisodeImagesInNextUpAndResume', false); }
  get skipBack() { return this.num('skipBackLength', 10000) / 1000; }
  get skipForward() { return this.num('skipForwardLength', 30000) / 1000; }
  // Per device, as in the official client (userSettings.js: saved with set(..., false)).
  get maxDaysNextUp() { return this.local('maxDaysForNextUp', 365); }
  get rewatchingNextUp() { return this.local('enableRewatchingInNextUp', false); }
  get autoplayNext() { return this.config.EnableNextEpisodeAutoPlay !== false; }
  // Per device, as in the official client: the "Up next" card, and what to do with each
  // media segment type (mediaSegmentSettings.ts: intros and outros ask by default).
  // Per device, as the official "Burn in subtitles": auto | onlyimageformats | allcomplexformats.
  get subtitleBurnIn() { return this.local('subtitleburnin', 'auto'); }
  get nextVideoInfo() { return this.local('enableNextVideoInfoOverlay', true); }
  segmentAction(type) {
    return this.local(`segmentTypeAction__${type}`, null) || (type === 'Intro' || type === 'Outro' ? 'AskToSkip' : 'None');
  }

  // ---- playback: the one object the player core and every engine read ----------------------
  // Per device, under the official web client's names.

  /** Subtitle look (official subtitleappearancehelper.js values). */
  get subtitleAppearance() {
    return { ...SUBTITLE_DEFAULTS, ...(this.local('localplayersubtitleappearance3', {}) || {}) };
  }
  setSubtitleAppearance(patch) { this.setLocal('localplayersubtitleappearance3', { ...this.subtitleAppearance, ...patch }); }

  get playback() {
    return {
      maxBitrate: this.maxBitrate,                       // 0 = auto
      maxVideoWidth: this.local('maxVideoWidth', 0),     // 0 = no limit (transcodes only)
      // Also refuse direct play above maxVideoWidth (official "Limit maximum supported resolution").
      limitVideoWidth: this.local('limitSupportedVideoResolution', false),
      allowedAudioChannels: this.local('allowedAudioChannels', 0), // 0 = auto
      preferredVideoCodec: this.local('preferredTranscodeVideoCodec', ''),
      preferredAudioCodec: this.local('preferredTranscodeVideoAudioCodec', ''),
      alwaysBurnInWhenTranscoding: this.local('alwaysBurnInSubtitleWhenTranscoding', false),
      subtitleBurnIn: this.subtitleBurnIn,
      skipBack: this.skipBack,
      skipForward: this.skipForward,
      autoplayNext: this.autoplayNext,
      nextVideoInfo: this.nextVideoInfo,
      segmentAction: type => this.segmentAction(type),
      subtitles: this.subtitleAppearance,
      // Trailers and intros from the server before a film (official default: on).
      cinemaMode: this.local('enableCinemaMode', true),
      // Official stillWatching plugin: disabled | short | default | long | veryLong.
      stillWatching: this.local('stillWatchingPrompt', 'disabled'),
    };
  }

  /** Query params the official clients send with /Shows/NextUp. */
  nextUpQuery() {
    const q = { enableRewatching: this.rewatchingNextUp };
    const days = this.maxDaysNextUp;
    if (days > 0) q.nextUpDateCutoff = new Date(Date.now() - days * 86400000).toISOString();
    return q;
  }
}
