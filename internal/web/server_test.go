package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestServer(t *testing.T, upstream *httptest.Server) http.Handler {
	t.Helper()
	u, _ := url.Parse(upstream.URL)
	s, err := New(Options{
		Jellyfin: u,
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
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("asset: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := do(h, "POST", "/", "", nil); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST / = %d", w.Code)
	}
}

func TestPluginHostCSP(t *testing.T) {
	up := httptest.NewServer(http.NotFoundHandler())
	defer up.Close()
	h := newTestServer(t, up)
	w := do(h, "GET", "/static/abc123/plugin-host.html", "", nil)
	c := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(c, "'unsafe-inline'") || !strings.Contains(c, "sandbox") || !strings.Contains(c, "connect-src 'none'") {
		t.Errorf("plugin host CSP %q", c)
	}
	// Everything else keeps the strict policy.
	w = do(h, "GET", "/", "", nil)
	if c := w.Header().Get("Content-Security-Policy"); strings.Contains(c, "'unsafe-inline'") || !strings.Contains(c, "frame-src 'self'") {
		t.Errorf("main CSP %q", c)
	}
}

func TestExport(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":       {Data: []byte("<head>\n{{CSP}}<meta name=\"lcars-api\" content=\"{{API}}\"><script type=\"module\" src=\"{{ASSETS}}js/app.js\"></script>{{PRELOAD}}</head>")},
		"js/app.js":        {Data: []byte("import './a.js';")},
		"js/a.js":          {Data: []byte("export const a = 1;")},
		"plugin-host.html": {Data: []byte("<meta charset=\"utf-8\"><title>p</title>")},
	}
	dir := t.TempDir()
	if err := Export(fsys, "v1", dir); err != nil {
		t.Fatal(err)
	}
	idx, _ := os.ReadFile(filepath.Join(dir, "index.html"))
	for _, want := range []string{`content="same-origin"`, `src="static/v1/js/app.js"`, `href="static/v1/js/a.js"`, `http-equiv="Content-Security-Policy"`} {
		if !strings.Contains(string(idx), want) {
			t.Errorf("index.html lacks %s:\n%s", want, idx)
		}
	}
	if strings.Contains(string(idx), "frame-ancestors") {
		t.Error("frame-ancestors in a meta CSP")
	}
	host, err := os.ReadFile(filepath.Join(dir, "static", "v1", "plugin-host.html"))
	if err != nil || !strings.Contains(string(host), "connect-src 'none'") || strings.Contains(string(host), "sandbox") {
		t.Errorf("plugin-host.html: %v\n%s", err, host)
	}
	if _, err := os.Stat(filepath.Join(dir, "static", "v1", "js", "a.js")); err != nil {
		t.Error(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "manifest.json")); !strings.Contains(string(b), `"start_url":"index.html#/home"`) {
		t.Errorf("manifest.json: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "robots.txt")); !strings.Contains(string(b), "Disallow: /") {
		t.Errorf("robots.txt: %q", b)
	}
}
