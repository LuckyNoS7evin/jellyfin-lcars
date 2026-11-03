#!/bin/sh
# Builds jellyfin-lcars and runs it on this machine against your Jellyfin server.
#   JELLYFIN_URL=http://<your-jellyfin>:8096 deploy/dev.sh
# Open http://localhost:8080 (or set JFL_LISTEN). Uses a local Go toolchain if there is one,
# otherwise the golang image in podman.
set -eu
cd "$(dirname "$0")/.."
GO_IMAGE=docker.io/library/golang:1.27-alpine
if command -v go >/dev/null 2>&1; then
	CGO_ENABLED=0 go build -o bin/jflcars ./cmd/jflcars
else
	podman run --rm -v "$PWD":/src:Z -w /src -v jfl-gomod:/go/pkg/mod -v jfl-gocache:/root/.cache/go-build \
		-e CGO_ENABLED=0 "$GO_IMAGE" go build -o bin/jflcars ./cmd/jflcars
fi
: "${JELLYFIN_URL:?set JELLYFIN_URL to your Jellyfin server, e.g. http://jellyfin:8096}"
exec ./bin/jflcars
