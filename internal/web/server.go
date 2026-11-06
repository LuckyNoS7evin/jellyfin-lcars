// Package web is LCARS's development server, which serves the client and proxies /jf/* to a
// Jellyfin server (one origin, so no CORS), and its export, which writes the client out as the
// web folder the image gives Jellyfin to serve.
package web

import (
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

type Options struct {
	Jellyfin *url.URL
	Static   fs.FS
	Version  string
}

type Server struct {
	o      Options
	assets *assets
	proxy  http.Handler
}

func New(o Options) (*Server, error) {
	a, err := loadAssets(o.Static, o.Version)
	if err != nil {
		return nil, err
	}
	return &Server{o: o, assets: a, proxy: newProxy(o.Jellyfin)}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.assets.serveIndex)
	mux.HandleFunc("GET /static/", s.assets.serve)
	mux.HandleFunc("GET /manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Write(manifest("static/" + s.o.Version + "/icon.svg"))
	})
	mux.Handle("/jf/", http.StripPrefix("/jf", s.proxy))
	return s.guard(mux)
}

// blob: is for hls.js (MediaSource object URLs and its worker) and libbitsub's worker.
// img-src https: lets the admin image search and Identify show the metadata providers' artwork
// (TMDb, TVDB, fanart.tv...) as the official client does; images only, no scripts or fetches.
// 'wasm-unsafe-eval' lets the subtitle renderers (libass, libbitsub) compile WebAssembly;
// it does not allow eval() of JavaScript.
// frame-src youtube-nocookie.com: remote (YouTube) trailers play in YouTube's own player, framed.
// script-src www.gstatic.com: Google's Cast sender script (cast.js), loaded only on secure pages in Chrome.
// No scheme: it loads its parts with the page's own (https on a real server; http on localhost).
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' www.gstatic.com; style-src 'self'; img-src 'self' data: blob: https:; " +
	"media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self' https://www.youtube-nocookie.com; " +
	"manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// pluginHostCSP is for plugin-host.html, where the admin dashboard runs a plugin's own settings
// page. Those pages are HTML with inline scripts (written for jellyfin-web), so inline scripts
// and styles are allowed here, and only here. The sandbox directive (header only: the
// image's meta tag can't carry it, and the iframe's sandbox attribute does the same job) gives the
// page an opaque origin even if opened on its own: it can't read LCARS's storage or token, and it can't fetch
// anything itself (connect-src 'none'); it asks the dashboard, by postMessage, to make API calls.
const pluginHostCSP = "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; " +
	"frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

// guard sets the security headers the image's pages carry as meta tags (so the dev server
// catches a CSP problem before the image does), and keeps the client's own paths read-only.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		if strings.HasSuffix(r.URL.Path, "/plugin-host.html") {
			hd.Set("Content-Security-Policy", pluginHostCSP)
		} else if !strings.HasPrefix(r.URL.Path, "/jf/") {
			hd.Set("Content-Security-Policy", csp)
		}
		if !strings.HasPrefix(r.URL.Path, "/jf/") && r.Method != http.MethodGet && r.Method != http.MethodHead {
			hd.Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func newProxy(target *url.URL) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Jellyfin doesn't need a reverse proxy's or an auth gateway's cookies.
			pr.Out.Header.Del("Cookie")
		},
		FlushInterval: -1, // stream video and HLS playlists as they arrive
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() == nil {
				slog.Info("jellyfin proxy error", "path", r.URL.Path, "err", err)
			}
			http.Error(w, "jellyfin unreachable", http.StatusBadGateway)
		},
	}
}
