# Jellyfin with LCARS as its web client: the official Jellyfin image, with jellyfin-web replaced by
# LCARS (served by Jellyfin itself under /web/) and the LCARS plugin installed on start.
# Rebuilt for each Jellyfin release; JELLYFIN_TAG is the official image's tag, JELLYFIN_VERSION
# the matching NuGet packages the plugin builds against.
ARG JELLYFIN_TAG=12.4.20261026-211555
ARG JELLYFIN_VERSION=12.4.0

# LCARS's files, minified as for the standalone image, written out as a web client folder.
FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27-alpine AS web
WORKDIR /src
COPY . .
RUN go run github.com/evanw/esbuild/cmd/esbuild@v0.28.2 \
      $(find web/static/js web/static/css -name '*.js' -o -name '*.css') \
      --minify --charset=utf8 --legal-comments=none \
      --outbase=web/static --outdir=web/static --allow-overwrite --log-level=warning
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /jflcars ./cmd/jflcars \
 && /jflcars -export /webdir

# The plugin (plain .NET, so one build serves every architecture).
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS plugin
ARG JELLYFIN_VERSION
WORKDIR /src
COPY plugin/ plugin/
RUN dotnet build plugin/Jellyfin.Plugin.Lcars/Jellyfin.Plugin.Lcars.csproj -c Release -p:JellyfinVersion=${JELLYFIN_VERSION} -o /out \
 && dotnet msbuild plugin/Jellyfin.Plugin.Lcars/Jellyfin.Plugin.Lcars.csproj -getProperty:Version > /out/version

FROM docker.io/jellyfin/jellyfin:${JELLYFIN_TAG}
LABEL org.opencontainers.image.source="https://github.com/LuckyNoS7evin/jellyfin-lcars" \
      org.opencontainers.image.description="Jellyfin with the LCARS (Star Trek) web client" \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-only"
RUN rm -rf /jellyfin/jellyfin-web
COPY --from=web /webdir /jellyfin/jellyfin-web
COPY --from=plugin /out/Jellyfin.Plugin.Lcars.dll /out/version /usr/share/lcars/plugin/
COPY deploy/jellyfin-entrypoint.sh /usr/local/bin/lcars-entrypoint
ENTRYPOINT ["/usr/local/bin/lcars-entrypoint"]
