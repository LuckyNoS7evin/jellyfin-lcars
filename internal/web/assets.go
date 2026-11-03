package web

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
)

// assets holds the embedded static files in memory, pre-compressed, with content-hash ETags.
type assets struct {
	files   map[string]*asset
	version string
}

type asset struct {
	data, gz []byte
	ctype    string
	etag     string
}

// .wasm: the subtitle renderers' WebAssembly (libass is 2.2 MB, 0.9 MB gzipped).
var compressible = map[string]bool{".html": true, ".css": true, ".js": true, ".mjs": true, ".svg": true, ".json": true, ".webmanifest": true, ".wasm": true}

// The app's entry module; index.html preloads everything it imports statically.
const entryModule = "js/app.js"

// Static imports and re-exports of relative modules, in readable or minified code:
// `import { a } from './x.js'`, `import"./x.js"`, `export * from './x.js'`. Dynamic
// `import('./x.js')` doesn't match (a parenthesis follows "import"), so lazy modules stay lazy.
var importRe = regexp.MustCompile(`(?:\bimport|\bexport)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["'](\.{1,2}/[^"']+?\.m?js)["']`)

func loadAssets(fsys fs.FS, version string) (*assets, error) {
	a := &assets{files: map[string]*asset{}, version: version}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		a.files["/"+p] = newAsset(p, b)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// index.html last: it lists the modules to preload, so they must all be loaded first.
	if idx, ok := a.files["/index.html"]; ok {
		b := bytes.ReplaceAll(idx.data, []byte("{{PRELOAD}}"), []byte(a.preloadLinks()))
		// Cache-bust module URLs with the build version.
		b = bytes.ReplaceAll(b, []byte("{{VERSION}}"), []byte(version))
		a.files["/index.html"] = newAsset("index.html", b)
	}
	return a, nil
}

func newAsset(p string, b []byte) *asset {
	ext := path.Ext(p)
	sum := sha256.Sum256(b)
	f := &asset{data: b, ctype: mime.TypeByExtension(ext), etag: `"` + hex.EncodeToString(sum[:8]) + `"`}
	switch ext {
	case ".woff2":
		f.ctype = "font/woff2"
	case ".js", ".mjs":
		f.ctype = "text/javascript; charset=utf-8"
	case ".wasm":
		f.ctype = "application/wasm"
	}
	if f.ctype == "" {
		f.ctype = "application/octet-stream"
	}
	if compressible[ext] && len(b) > 512 {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(b)
		zw.Close()
		f.gz = buf.Bytes()
	}
	return f
}

// preloadModules walks the static imports from the entry module: every module the app needs
// before it can draw. Without the hints the browser finds them one level at a time, a round
// trip per level; with them it asks for all of them at once.
func (a *assets) preloadModules() []string {
	seen := map[string]bool{}
	var walk func(p string)
	walk = func(p string) {
		f, ok := a.files["/"+p]
		if !ok || seen[p] {
			return
		}
		seen[p] = true
		for _, m := range importRe.FindAllSubmatch(f.data, -1) {
			walk(path.Join(path.Dir(p), string(m[1])))
		}
	}
	walk(entryModule)
	delete(seen, entryModule) // the page's own <script> loads it
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func (a *assets) preloadLinks() string {
	var b strings.Builder
	for _, p := range a.preloadModules() {
		b.WriteString(`<link rel="modulepreload" href="/static/{{VERSION}}/` + p + "\">\n")
	}
	return b.String()
}

func (a *assets) serveIndex(w http.ResponseWriter, r *http.Request) {
	a.write(w, r, a.files["/index.html"])
}

// serve handles /static/<version>/<file>. Every asset URL carries the build version, so a
// deploy changes every URL and no cache (the browser, or a reverse proxy's asset cache) can serve a
// stale file. Files for the current version are cached for a year; a request naming another
// version (an old page during a deploy) gets today's file but must not be cached under it.
func (a *assets) serve(w http.ResponseWriter, r *http.Request) {
	ver, file, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/static/"), "/")
	f, found := a.files["/"+file]
	if !ok || !found || file == "index.html" {
		http.NotFound(w, r)
		return
	}
	// Fonts are fetched in CORS mode, and the plugin settings sandbox (plugin-host.html) has an
	// opaque origin, so it can only use Antonio if the font says anyone may. Fonts are public.
	if strings.HasPrefix(file, "fonts/") {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	if ver == a.version && a.version != "dev" && !strings.HasSuffix(a.version, "-dirty") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	a.write(w, r, f)
}

func (a *assets) write(w http.ResponseWriter, r *http.Request, f *asset) {
	if f == nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", f.ctype)
	h.Set("ETag", f.etag)
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "no-cache") // the page itself: always revalidate (ETag -> 304)
	}
	h.Add("Vary", "Accept-Encoding")
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if f.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		h.Set("Content-Encoding", "gzip")
		w.Write(f.gz)
		return
	}
	w.Write(f.data)
}
