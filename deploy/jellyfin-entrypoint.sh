#!/bin/sh
# Jellyfin + LCARS: put the plugins this image carries into Jellyfin's plugins folder (on the
# config volume, so they can't be baked in), replacing older copies, then start Jellyfin as the
# official image does.
#   LCARS        always (the admin dashboard's history).
#   HEIC Photos  iPhone photos in photo libraries; LCARS_HEIC_PHOTOS=false leaves it out. A newer
#                copy installed from a plugin catalogue is left in place.
set -eu
plugins="${JELLYFIN_DATA_DIR:-/config}/plugins"

# install <source dir> <folder name> <newer-wins> <files...>
install_plugin() {
	src=$1 name=$2 newer_wins=$3
	shift 3
	ver=$(tr -d '[:space:]' < "$src/version")
	dest="$plugins/${name}_$ver"
	for old in "$plugins/${name}"_*; do
		[ -d "$old" ] && [ "$old" != "$dest" ] || continue
		have=${old##*_}
		if [ "$newer_wins" = yes ] && [ "$(printf '%s\n%s\n' "$ver" "$have" | sort -V | tail -n 1)" = "$have" ]; then
			echo "LCARS: $name $have is newer than the image's $ver; leaving it"
			[ -d "$dest" ] && rm -rf -- "$dest"
			return 0
		fi
	done
	for old in "$plugins/${name}"_*; do
		[ -d "$old" ] && [ "$old" != "$dest" ] && rm -rf -- "$old"
	done
	if cmp -s "$src/$1" "$dest/$1" 2>/dev/null; then
		return 0
	fi
	mkdir -p "$dest"
	for f in "$@"; do
		cp "$src/$f" "$dest/"
	done
	echo "LCARS: $name plugin $ver installed"
}

install_plugin /usr/share/lcars/plugin LCARS no Jellyfin.Plugin.Lcars.dll
case "${LCARS_HEIC_PHOTOS:-true}" in
	false | 0 | no | off) ;;
	*) install_plugin /usr/share/lcars/heic "HEIC Photos" yes Jellyfin.Plugin.HeicPhotos.dll MetadataExtractor.dll XmpCore.dll ;;
esac
exec /jellyfin/jellyfin "$@"
