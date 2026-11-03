# jellyfin-lcars

A standalone LCARS (Star Trek) client for Jellyfin, for the web and (soon) the desktop. It runs alongside the official clients and doesn't change the server.

- **Home** follows your Jellyfin home screen settings: section order, library order, and libraries excluded from "Latest".
- **Libraries**: poster grids with sort and filter, loading more as you scroll. Music has Albums, Artists and Songs tabs.
- **Details**: films, series, seasons, episodes, albums, artists, collections, playlists and people. You can resume, pick audio and subtitle tracks, and mark items watched or favourite.
- **Video player**: direct play when the browser can decode the file, otherwise the server's HLS stream through hls.js. Text subtitles switch instantly. Picture and styled subtitles are burned in by the server. Playback is reported to Jellyfin, so resume points and watched marks stay in sync with the official clients.
- **Music**: one queue for the whole app with a mini player in the footer, so it keeps playing while you browse.
- **Remote control**: the server's dashboard and other clients can control it (play, seek, tracks, volume, full screen, go to a page, messages).
- **Play on**: control your other Jellyfin apps (a TV, a phone, another browser) from LCARS; while one is chosen, whatever you play goes there.
- **Quick Connect**: sign in with a code from another device, or authorise one from Settings.
- Optional synthesised panel chirps (Configuration → Audio cues).

## How it works

A small Go server embeds the client (plain ES modules with no build step and a strict CSP). It proxies `/jf/*` to Jellyfin, including the WebSocket, so the browser only ever talks to one origin. The server holds no credentials: each browser signs in with its own Jellyfin account and keeps its own token.

Jellyfin 12 notes:
- Media and socket URLs take `ApiKey=`. The old `api_key=` is rejected.
- `/Users/Me`, `/UserViews`, `/UserItems/Resume`, `/UserPlayedItems` and `/UserFavoriteItems` are the current endpoint names.

## Run it

The image is on GHCR, for amd64 and arm64:

```sh
docker run -d --name jellyfin-lcars -p 8080:8080 --read-only \
  -e JELLYFIN_URL=http://<your-jellyfin>:8096 \
  ghcr.io/luckynos7evin/jellyfin-lcars:latest
```

Then open `http://<this host>:8080` and sign in with your Jellyfin account. `compose.example.yml` is the same as a Compose service, with the hardening options. Tags: `latest` (newest main), the first 7 characters of each commit on main, and `v*` releases.

| Variable | Default | |
|---|---|---|
| `JELLYFIN_URL` | (required) | your Jellyfin server, as the container reaches it |
| `JFL_LISTEN` | `:8080` | |
| `JFL_ALLOWED_CIDRS` | private, Docker, CGNAT and loopback ranges | direct peers allowed to connect |

Behind a reverse proxy, turn on WebSocket support (remote control and live updates use `/jf/socket`), and allow the proxy's address in `JFL_ALLOWED_CIDRS` if it isn't in a private range.

## Develop

```sh
JELLYFIN_URL=http://<your-jellyfin>:8096 deploy/dev.sh    # builds (local Go, or the golang image in podman), runs on :8080
```

The assets are embedded, so rebuild after changing them. Every push to main runs the tests and publishes an image (`.github/workflows/image.yml`).

## Licences

- jellyfin-lcars: MIT (`LICENSE`).
- Antonio font: SIL OFL 1.1 (`web/static/fonts/Antonio-OFL.txt`).
- hls.js 1.7.3: Apache 2.0 (`web/static/vendor/hls.LICENSE`).
