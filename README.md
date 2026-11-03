# jellyfin-lcars

Jellyfin with an LCARS (Star Trek) web client. The image is the official Jellyfin server with LCARS in place of its web client (jellyfin-web): LCARS is what you see in a browser, its Engineering dashboard runs the server, and everything else about Jellyfin stays the same.

- **Home** follows your Jellyfin home screen settings: section order, library order, and libraries excluded from "Latest".
- **Libraries**: poster grids with sort and filter, loading more as you scroll. Music has Albums, Artists and Songs tabs.
- **Details**: films, series, seasons, episodes, albums, artists, collections, playlists and people. You can resume, pick audio and subtitle tracks, and mark items watched or favourite.
- **Video player**: direct play when the browser can decode the file, otherwise the server's HLS stream through hls.js. Text subtitles switch instantly. Picture and styled subtitles are burned in by the server. Playback is reported to Jellyfin, so resume points and watched marks stay in sync with the official clients.
- **Music**: one queue for the whole app with a mini player in the footer, so it keeps playing while you browse.
- **Remote control**: the server's dashboard and other clients can control it (play, seek, tracks, volume, full screen, go to a page, messages).
- **Play on**: control your other Jellyfin apps (a TV, a phone, another browser) from LCARS; while one is chosen, whatever you play goes there.
- **Quick Connect**: sign in with a code from another device, or authorise one from Settings.
- **Engineering**: the admin dashboard, for everything Jellyfin's does (users, libraries, playback, tasks, logs, server settings, plugins and their own pages, item editing) plus diagnostics: library health, live transcodes and why, viewing stats, and transcode and storage history.
- Optional synthesised panel chirps (Configuration → Audio cues).
- **First-run setup** for a new server: name and language, the administrator, libraries, metadata and remote access.

## Run it

The image is on GHCR, for amd64 and arm64. With Docker Compose (this is `compose.yml`):

```yaml
services:
  jellyfin:
    image: ghcr.io/luckynos7evin/jellyfin-lcars:latest
    container_name: jellyfin
    restart: unless-stopped
    user: "1000:1000"
    environment:
      TZ: Europe/London
      # Any of Jellyfin's own variables work as usual, for example:
      # JELLYFIN_PublishedServerUrl: https://jellyfin.example.org
    volumes:
      - ./jellyfin/config:/config
      - ./jellyfin/cache:/cache
      - /path/to/media:/media:ro
    ports:
      - "8096:8096"
      # - "7359:7359/udp"   # auto-discovery for apps on the LAN
    # Hardware transcoding, as with the official image. Intel or AMD (VA-API, QSV):
    # devices:
    #   - /dev/dri:/dev/dri
    # NVIDIA (NVENC), with the NVIDIA Container Toolkit on the host:
    # runtime: nvidia
    # environment:
    #   NVIDIA_VISIBLE_DEVICES: all
```

Then `docker compose up -d` and open `http://<this host>:8096`. A new server starts with LCARS's first-run setup; an existing one keeps its users, libraries and settings (point the volumes at its config and cache).

It's a drop-in for `jellyfin/jellyfin`: the same volumes, ports, devices, user, command-line options and **all of Jellyfin's environment variables** (`JELLYFIN_PublishedServerUrl`, `JELLYFIN_DATA_DIR`, `JELLYFIN_CACHE_DIR`, `JELLYFIN_CONFIG_DIR`, `JELLYFIN_LOG_DIR`, `JELLYFIN_FFMPEG`, `TZ`, the `NVIDIA_*` ones, and the rest). Two are LCARS's own and best left alone: `JELLYFIN_WEB_DIR` points at LCARS, and `JELLYFIN_hostwebclient=false` (or `--nowebclient`) would turn it off. Going back to the official image is a matter of changing the `image:` line.

- TV, phone and desktop apps (Android TV, Findroid, Swiftfin, Infuse, Kodi...) talk to the server as with any Jellyfin. Apps that show the server's own web pages (the official phone app, Jellyfin Media Player) show LCARS.
- On start the container installs LCARS's plugin (`plugin/`) into Jellyfin's plugins folder. It records transcode and storage history for Engineering → Diagnostics.
- Tags: `latest`, `<jellyfin version>` (e.g. `12.4.0`, the newest LCARS on it), `<first 7 of the commit>` and `<jellyfin version>-<commit>`. Each Jellyfin release gets a new build within a day.

## How it works

The client is plain ES modules with no build step and a strict CSP. `Dockerfile` writes it out as a web client folder (`jflcars -export`) and puts it where the official image keeps jellyfin-web, with the plugin beside it; Jellyfin serves it under `/web/`. Each browser signs in with its own Jellyfin account and keeps its own token.

Jellyfin 12 notes:
- Media and socket URLs take `ApiKey=`. The old `api_key=` is rejected.
- `/Users/Me`, `/UserViews`, `/UserItems/Resume`, `/UserPlayedItems` and `/UserFavoriteItems` are the current endpoint names.

## Develop

```sh
JELLYFIN_URL=http://<your-jellyfin>:8096 deploy/dev.sh    # builds (local Go, or the golang image in podman), runs on :8080
```

For development a small Go server (`cmd/jflcars`) serves the client and proxies `/jf/*` to a Jellyfin server, so you can work against any Jellyfin without rebuilding an image. The assets are embedded, so rebuild after changing them. `JFL_LISTEN` (default `:8080`) sets where it listens; it's for development, not for exposing to the internet. The plugin builds with `dotnet build plugin/Jellyfin.Plugin.Lcars/Jellyfin.Plugin.Lcars.csproj`. Every push to main runs the tests and publishes the image (`.github/workflows/image.yml`).

## Licences

- jellyfin-lcars: MIT (`LICENSE`).
- Antonio font: SIL OFL 1.1 (`web/static/fonts/Antonio-OFL.txt`).
- hls.js 1.7.3: Apache 2.0 (`web/static/vendor/hls.LICENSE`).
- The image is Jellyfin (GPL-2.0, https://github.com/jellyfin/jellyfin) with LCARS added.
