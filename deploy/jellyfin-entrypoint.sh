#!/bin/sh
# Jellyfin + LCARS: put the LCARS plugin this image carries into Jellyfin's plugins folder (on
# the config volume, so it can't be baked in), replacing an older copy, then start Jellyfin as
# the official image does.
set -eu
src=/usr/share/lcars/plugin
ver=$(tr -d '[:space:]' < "$src/version")
plugins="${JELLYFIN_DATA_DIR:-/config}/plugins"
dest="$plugins/LCARS_$ver"
if ! cmp -s "$src/Jellyfin.Plugin.Lcars.dll" "$dest/Jellyfin.Plugin.Lcars.dll" 2>/dev/null; then
	mkdir -p "$dest"
	for old in "$plugins"/LCARS_*; do
		[ -d "$old" ] && [ "$old" != "$dest" ] && rm -rf -- "$old"
	done
	cp "$src/Jellyfin.Plugin.Lcars.dll" "$dest/"
	echo "LCARS: plugin $ver installed"
fi
exec /jellyfin/jellyfin "$@"
