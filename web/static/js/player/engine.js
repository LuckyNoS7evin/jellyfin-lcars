// Playback engines. The player core (video.js) owns everything you see and everything Jellyfin
// is told; an engine only turns a stream URL into pictures and sound. The web app uses the
// browser engine (engine-web.js); the desktop app will add an mpv engine with the same shape,
// so player features are written once, in the core.
//
// Settings: engines read the `playback` object from settings.js (bitrate, subtitle burn-in,
// subtitle appearance...), never their own copies, so a setting means the same on both.
//
// An engine is an object with:
//   el                      element the core puts behind its controls (a <video>, or a
//                           transparent box when mpv draws in its own window)
//   on(event, fn)           events: playing, pause, waiting, seeked, volumechange, ended,
//                           timeupdate, canplaythrough, durationchange, ratechange, click,
//                           dblclick, error ({message, direct}: direct play failed, so the core
//                           can fall back to a transcode), subtitlefailed (a drawn subtitle
//                           failed), pipchange (optional)
//   profile(opts)           the DeviceProfile to send with PlaybackInfo: what this engine can
//                           play directly and which subtitle formats it draws itself, within
//                           the playback settings (max resolution, audio channels, codecs)
//                           (opts: {maxBitrate, burnIn: true to have every subtitle burned in})
//   load({url, hls, direct, startAt, ms, subs})
//                           start a source: url is the direct stream or the server's HLS
//                           transcode (hls: true); subs are the External subtitle streams
//                           (MediaStream objects with absolute `url`s); ms the MediaSource
//   setSubtitle(stream)     show this External subtitle stream, or none (null)
//   subtitleDelay           seconds to show subtitles later (negative: earlier); get/set
//   subtitleStyle(a)        apply a subtitle appearance (settings.js subtitleAppearance)
//                           to text subtitles; styled and picture subtitles keep their own
//   aspect                  'auto' (letterbox), 'cover' (crop to fill) or 'fill' (stretch)
//   frameStep(dir)          pause and step one frame forward (1) or back (-1)
//   stats()                 {width, height, dropped, frames, buffered, player, bandwidth,
//                           levelBitrate} for the playback info overlay (nulls if unknown)
//   play() -> Promise, pause(), seek(seconds)
//   paused, position, duration, rate     getters (rate also a setter)
//   volume (0..1), muted                 getters and setters
//   bufferedTo(position)    how far playback is buffered from `position`, in seconds
//   stop()                  drop the current source (between items)
//   destroy()               free everything (player closed)
//
// Optional, browser only (the core checks before using them):
//   setSecondarySubtitle(stream)   a second text subtitle at the top
//   canPip, pip, togglePip()       picture-in-picture
import { webEngine } from './engine-web.js';

/**
 * The engine for this app: the browser's, until the desktop app supplies mpv.
 * pb: the playback settings (settings.js `playback`), the same object every engine reads.
 */
export function createEngine(app, pb) {
  return webEngine(app, pb);
}
