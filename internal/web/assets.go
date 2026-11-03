package web

import (
	"bytes"
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

// assets holds the embedded static files in memory, with content-hash ETags.
type assets struct {
	files   map[string]*asset
	version string
	index   []byte // index.html as written, before render fills it in
}

type asset struct {
	data  []byte
	ctype string
	etag  string
}

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
		a.index = idx.data
		// Served by LCARS: assets under /static/<version>/, the API through /jf, the CSP a header.
		a.files["/index.html"] = newAsset("index.html", a.render("/static/"+version+"/", "/jf", ""))
	}
	return a, nil
}

// render fills in index.html: where the assets are (every URL carries the build version, which
// busts caches), where the API is, and a CSP meta tag when no header will carry one.
func (a *assets) render(assetsURL, api, cspMeta string) []byte {
	b := bytes.ReplaceAll(a.index, []byte("{{PRELOAD}}"), []byte(a.preloadLinks()))
	b = bytes.ReplaceAll(b, []byte("{{ASSETS}}"), []byte(assetsURL))
	b = bytes.ReplaceAll(b, []byte("{{VERSION}}"), []byte(a.version))
	b = bytes.ReplaceAll(b, []byte("{{API}}"), []byte(api))
	return bytes.ReplaceAll(b, []byte("{{CSP}}"), []byte(cspMeta))
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
		b.WriteString(`<link rel="modulepreload" href="{{ASSETS}}` + p + "\">\n")
	}
	return b.String()
}

func (a *assets) serveIndex(w http.ResponseWriter, r *http.Request) {
	a.write(w, r, a.files["/index.html"])
}

// serve handles /static/<version>/<file>. Development builds change all the time, so nothing is
// cached without asking (the ETag makes the asking cheap).
func (a *assets) serve(w http.ResponseWriter, r *http.Request) {
	_, file, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/static/"), "/")
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
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(f.data)
}
