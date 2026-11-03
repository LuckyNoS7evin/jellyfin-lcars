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
	"regexp"
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
// img-src https: lets the admin image search and Identify show the metadata providers' artwork
// (TMDb, TVDB, fanart.tv...) as the official client does; images only, no scripts or fetches.
// 'wasm-unsafe-eval' lets the subtitle renderers (libass, libbitsub) compile WebAssembly;
// it does not allow eval() of JavaScript.
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob: https:; " +
	"media-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; " +
	"manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// pluginHostCSP is for plugin-host.html, where the admin dashboard runs a plugin's own settings
// page. Those pages are HTML with inline scripts (written for jellyfin-web), so inline scripts
// and styles are allowed here, and only here. The sandbox directive gives the page an opaque
// origin even if opened on its own: it can't read LCARS's storage or token, and it can't fetch
// anything itself (connect-src 'none'); it asks the dashboard, by postMessage, to make API calls.
const pluginHostCSP = "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; " +
	"frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"

// maxBody caps request bodies sent through to Jellyfin (playback reports, logins, settings).
// Uploads get maxUpload: item images, subtitles, lyrics, the splash screen and avatars.
const (
	maxBody   = 1 << 20
	maxUpload = 64 << 20
)

var uploadPath = regexp.MustCompile(`^/jf/(Items/[^/]+/Images/[^/]+(/\d+)?|Videos/[^/]+/Subtitles|Audio/[^/]+/Lyrics|Branding/Splashscreen|Users/[^/]+/Images/[^/]+|UserImage)$`)

func bodyLimit(r *http.Request) int64 {
	if r.Method == http.MethodPost && uploadPath.MatchString(r.URL.Path) {
		return maxUpload
	}
	return maxBody
}

// guard applies the peer allowlist, the method allowlist and the security headers.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		if strings.HasSuffix(r.URL.Path, "/plugin-host.html") {
			hd.Set("Content-Security-Policy", pluginHostCSP)
			hd.Set("X-Frame-Options", "SAMEORIGIN")
		} else if !strings.HasPrefix(r.URL.Path, "/jf/") {
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
			r.Body = http.MaxBytesReader(w, r.Body, bodyLimit(r))
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
			forwardFor(pr)
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

// forwardFor tells Jellyfin who the client is. The proxy drops incoming X-Forwarded-* headers;
// this puts back what a proxy in front of LCARS (NPM) sent and adds the direct peer, so Jellyfin
// (with LCARS in its Known Proxies) sees the real client: LAN or remote, bitrate limits, the
// activity log. A client can prepend made-up entries, but Jellyfin reads from the right and
// stops at the first address that isn't a known proxy, which is the one added here.
func forwardFor(pr *httputil.ProxyRequest) {
	in := pr.In.Header
	if v := in.Values("X-Forwarded-For"); len(v) > 0 {
		pr.Out.Header["X-Forwarded-For"] = v
	}
	pr.SetXForwarded() // appends the peer; sets Host and Proto from this request
	// Keep the scheme and host the client used at the first proxy (https at NPM).
	if v := in.Get("X-Forwarded-Proto"); v != "" {
		pr.Out.Header.Set("X-Forwarded-Proto", v)
	}
	if v := in.Get("X-Forwarded-Host"); v != "" {
		pr.Out.Header.Set("X-Forwarded-Host", v)
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
