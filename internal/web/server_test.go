package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestServer(t *testing.T, upstream *httptest.Server) http.Handler {
	t.Helper()
	u, _ := url.Parse(upstream.URL)
	s, err := New(Options{
		Jellyfin:     u,
		AllowedCIDRs: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")},
		Static: fstest.MapFS{
			"index.html": {Data: []byte(`<script src="/static/{{VERSION}}/js/app.js"></script>`)},
			"js/app.js":  {Data: []byte("console.log(1)")},
		},
		Version: "abc123",
	})
	if err != nil {
		t.Fatal(err)
	}
	return s.Handler()
}

func do(h http.Handler, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestProxyStripsPrefixAndPassesAuth(t *testing.T) {
	var got *http.Request
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte("pong"))
	}))
	defer up.Close()
	h := newTestServer(t, up)

	w := do(h, "POST", "/jf/Sessions/Playing?x=1", `{"a":1}`, map[string]string{
		"Authorization": `MediaBrowser Token="t"`, "Cookie": "proxy_session=secret",
	})
	if w.Code != 200 || w.Body.String() != "pong" {
		t.Fatalf("status %d body %q", w.Code, w.Body.String())
	}
	if got.URL.Path != "/Sessions/Playing" || got.URL.RawQuery != "x=1" {
		t.Errorf("upstream got %s?%s", got.URL.Path, got.URL.RawQuery)
	}
	if got.Header.Get("Authorization") == "" {
		t.Error("Authorization not forwarded")
	}
	if got.Header.Get("Cookie") != "" {
		t.Error("cookies should not reach Jellyfin")
	}
	if gotBody != `{"a":1}` {
		t.Errorf("body %q", gotBody)
	}
}

func TestIndexAndAssets(t *testing.T) {
	up := httptest.NewServer(http.NotFoundHandler())
	defer up.Close()
	h := newTestServer(t, up)

	w := do(h, "GET", "/", "", nil)
	if !strings.Contains(w.Body.String(), "/static/abc123/js/app.js") {
		t.Errorf("version not substituted: %s", w.Body.String())
	}
	if w.Header().Get("Content-Security-Policy") == "" {
		t.Error("missing CSP")
	}
	w = do(h, "GET", "/static/abc123/js/app.js", "", nil)
	if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := do(h, "POST", "/", "", nil); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST / = %d", w.Code)
	}
}

func TestPeerAllowlist(t *testing.T) {
	up := httptest.NewServer(http.NotFoundHandler())
	defer up.Close()
	h := newTestServer(t, up)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.9:1234"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("outside peer got %d", w.Code)
	}
}

func TestBodyLimit(t *testing.T) {
	cases := []struct {
		method, path string
		want         int64
	}{
		{"POST", "/jf/Sessions/Playing", maxBody},
		{"POST", "/jf/System/Configuration", maxBody},
		{"POST", "/jf/Items/abc/Images/Primary", maxUpload},
		{"POST", "/jf/Items/abc/Images/Backdrop/2", maxUpload},
		{"POST", "/jf/Videos/abc/Subtitles", maxUpload},
		{"POST", "/jf/Audio/abc/Lyrics", maxUpload},
		{"POST", "/jf/Branding/Splashscreen", maxUpload},
		{"POST", "/jf/UserImage", maxUpload},
		{"POST", "/jf/Users/abc/Images/Primary", maxUpload},
		{"GET", "/jf/Items/abc/Images/Primary", maxBody},
		{"POST", "/jf/Items/abc/Images/Primary/x/y", maxBody},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		if got := bodyLimit(r); got != c.want {
			t.Errorf("%s %s: limit %d, want %d", c.method, c.path, got, c.want)
		}
	}
}
