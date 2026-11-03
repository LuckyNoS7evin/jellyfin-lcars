# Build: a static Go binary. Run: distroless (no shell, no package manager), non-root.
# The build stage runs on the builder's own platform and cross-compiles (Go needs no emulation).
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY . .
# Minify the app's own JS and CSS for the image only (the repo keeps readable source and dev
# serves it as is). esbuild is a Go program, so it runs here without Node. Files stay
# separate ES modules (no bundling); vendor/ is already minified and left alone.
RUN go run github.com/evanw/esbuild/cmd/esbuild@v0.28.2 \
      $(find web/static/js web/static/css -name '*.js' -o -name '*.css') \
      --minify --charset=utf8 --legal-comments=none \
      --outbase=web/static --outdir=web/static --allow-overwrite --log-level=warning
ARG VERSION=dev
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /jflcars ./cmd/jflcars

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/LuckyNoS7evin/jellyfin-lcars" \
      org.opencontainers.image.description="LCARS (Star Trek) web client for Jellyfin" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /jflcars /jflcars
USER nonroot:nonroot
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/jflcars", "-healthcheck"]
ENTRYPOINT ["/jflcars"]
