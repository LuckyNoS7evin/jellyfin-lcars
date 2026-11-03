// Package web serves the LCARS client and proxies /jf/* to the Jellyfin server, so the
// browser only ever talks to one origin (no CORS, one reverse proxy host, one CSP).
package web

import (
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"
)

type Options struct {
	Jellyfin     *url.URL
	AllowedCIDRs []netip.Prefix
	Static       fs.FS
	Version      string
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
	mux.Handle("/jf/", http.StripPrefix("/jf", s.proxy))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	return s.guard(mux)
}

// blob: is for hls.js (MediaSource object URLs and its worker) and libbitsub's worker.
// 'wasm-unsafe-eval' lets the subtitle renderers (libass, libbitsub) compile WebAssembly;
// it does not allow eval() of JavaScript.
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; " +
	"media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; connect-src 'self'; " +
	"manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// maxBody caps request bodies sent through to Jellyfin (playback reports, logins).
const maxBody = 1 << 20

// guard applies the peer allowlist, the method allowlist and the security headers.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/jf/") {
			hd.Set("Content-Security-Policy", csp)
			hd.Set("X-Frame-Options", "DENY")
			hd.Set("Cross-Origin-Opener-Policy", "same-origin")
			hd.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		}

		if !s.peerAllowed(r.RemoteAddr) {
			slog.Warn("rejected peer", "addr", r.RemoteAddr)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/jf/") {
			// Jellyfin authenticates with the Authorization header, not cookies, so a
			// cross-site request can't act as the user; the body cap is just hygiene.
			r.Body = http.MaxBytesReader(w, r.Body, maxBody)
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
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
			pr.SetXForwarded()
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

// peerAllowed checks the direct TCP peer (a reverse proxy, a LAN client, a VPN peer).
func (s *Server) peerAllowed(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	// Unmap ::ffff:a.b.c.d, and drop an IPv6 zone (fe80::1%eth0): a prefix never contains an
	// address with a zone.
	ip = ip.Unmap().WithZone("")
	for _, p := range s.o.AllowedCIDRs {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}
