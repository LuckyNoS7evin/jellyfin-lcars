// The app around LCARS, when there is one. Jellyfin's iPhone app (jellyfin-expo) and LG TV app
// (jellyfin-webos) show the server's web client inside them and offer it a `window.NativeShell`,
// as they do for jellyfin-web (official components/apphost.js, scripts/shell.js): who the device
// is, a native video player on the iPhone, fullscreen (which turns the iPhone to landscape),
// opening links, and leaving the app. The LG app adds it after the page starts, so it's looked
// up each time, never once at load.

const shell = () => window.NativeShell || null;
const host = () => shell()?.AppHost || null;
const call = (fn, ...a) => { try { return fn?.(...a); } catch (e) { console.warn('NativeShell:', e); return undefined; } };

export const native = {
  get present() { return !!shell(); },
  /** "tv" (the LG app), "mobile" (the iPhone app), or null. */
  layout: () => call(host()?.getDefaultLayout?.bind(host())) || null,
  supports: cmd => !!call(host()?.supports?.bind(host()), cmd),
  deviceName: () => call(host()?.deviceName?.bind(host())) || null,
  appName: () => call(host()?.appName?.bind(host())) || null,
  enableFullscreen: () => call(shell()?.enableFullscreen?.bind(shell())),
  disableFullscreen: () => call(shell()?.disableFullscreen?.bind(shell())),
  /** Opens a link in the app's browser; false when there's no app to ask. */
  openUrl(url) {
    const s = shell();
    if (!s?.openUrl) return false;
    call(s.openUrl.bind(s), url, '_blank');
    return true;
  },
  /** An outside link: the app's browser when in an app, else a new tab. */
  openExternal(url) { if (!native.openUrl(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
  canExit: () => !!host()?.exit && native.supports('exit'),
  exit: () => call(host()?.exit?.bind(host())),
  canSelectServer: () => typeof shell()?.selectServer === 'function',
  selectServer: () => call(shell()?.selectServer?.bind(shell())),
};

/**
 * The app's own video player (the iPhone app's, when its "native video player" setting is on),
 * as a player plugin made the way jellyfin-web makes them (official pluginManager.js): the
 * shell names plugins in getPlugins(), `window[name]()` returns the class, and the class is
 * given an events hub and a playbackManager it calls back.
 */
let videoPlugin;
export async function nativeVideoPlayer(hooks) {
  const s = shell();
  if (!s?.getPlugins) return null;
  if (videoPlugin === undefined) {
    videoPlugin = null;
    for (const name of call(s.getPlugins.bind(s)) || []) {
      try {
        const make = window[name];
        if (typeof make !== 'function') continue;
        const Cls = await make();
        if (typeof Cls !== 'function') continue;
        const p = new Cls({ events, playbackManager, loading: { show() {}, hide() {} }, appSettings: {}, globalize: { translate: k => k } });
        // Only the iPhone app's player for now: engine-native.js follows its interface. The desktop
        // app (Jellyfin Media Player) offers an mpv player that works differently; it keeps
        // LCARS's own player until that's built and tested.
        if (p.type === 'mediaplayer' && p.name === 'ExpoVideoPlayer' && p.canPlayMediaType?.('Video')) { videoPlugin = p; break; }
      } catch (e) { console.warn('NativeShell plugin', name, e); }
    }
  }
  if (!videoPlugin) return null;
  if (hooks) playbackManager.onStop = hooks.onStop;
  return videoPlugin;
}
/** The plugin found by nativeVideoPlayer(), once it has looked (null until then, or if none). */
export const readyVideoPlugin = () => videoPlugin || null;

// The events hub plugins fire into (official utils/events.ts): handlers get ({type}, ...args).
const handlers = new Map(); // obj -> Map(type -> Set(fn))
export const events = {
  on(obj, type, fn) {
    if (!handlers.has(obj)) handlers.set(obj, new Map());
    const m = handlers.get(obj);
    if (!m.has(type)) m.set(type, new Set());
    m.get(type).add(fn);
  },
  off(obj, type, fn) { handlers.get(obj)?.get(type)?.delete(fn); },
  trigger(obj, type, args = []) {
    for (const fn of [...(handlers.get(obj)?.get(type) || [])]) {
      try { fn({ type }, ...(Array.isArray(args) ? args : [args])); } catch (e) { console.warn(e); }
    }
  },
};
// The part of jellyfin-web's playbackManager a plugin calls: stop(player) when someone closes the
// native player.
const playbackManager = { onStop: null, stop(player) { this.onStop?.(player); } };

/**
 * window.Emby.Page: the iPhone app's Home tab and back gesture call goHome(), back() and
 * canGoBack() on it (official appRouter.js, used by the app's ExpoRouterShim).
 */
export function exposeRouter({ canGoBack, back, goHome }) {
  window.Emby = window.Emby || {};
  window.Emby.Page = { canGoBack, back, goHome };
}
