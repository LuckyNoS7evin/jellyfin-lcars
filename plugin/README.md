# LCARS companion plugin

The server-side part of LCARS, as a Jellyfin plugin, for LCARS's admin dashboard. Jellyfin only knows transcodes and disk
space in the moment; this records them so **Engineering → Diagnostics → History** can show:

- every transcode: who, on what, the source and what was sent, the encoder, and why;
- each disk's used space over time, with the trend and roughly when it fills.

It keeps a year (set in the dashboard) as two small JSON files in Jellyfin's data folder
(`data/lcars/`), so updating or reinstalling the plugin keeps the history. Its routes
(`/Lcars/Info`, `/Lcars/History/Transcodes`, `/Lcars/History/Storage`) are for administrators.

## Install

It isn't published on its own: it's part of LCARS. The Jellyfin + LCARS image builds it and
installs it into Jellyfin's plugins folder when the container starts.

## Build

```
dotnet build plugin/Jellyfin.Plugin.Lcars/Jellyfin.Plugin.Lcars.csproj -c Release
```

It's built against one Jellyfin release (`JellyfinVersion` in the project, or
`-p:JellyfinVersion=…`) and targets that release's .NET.
