package web

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Export writes LCARS as a web client folder for Jellyfin to host (JELLYFIN_WEB_DIR, served
// under /web/): index.html at the top, everything else under static/<version>/. Jellyfin sends
// no CSP, so the pages carry theirs as meta tags; frame-ancestors and sandbox can't go in a meta
// tag and are left out (the plugin frame is sandboxed by its iframe attribute either way).
func Export(fsys fs.FS, version, dir string) error {
	a, err := loadAssets(fsys, version)
	if err != nil {
		return err
	}
	if a.index == nil {
		return fmt.Errorf("export: no index.html")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	base := filepath.Join(dir, "static", version)
	for p, f := range a.files {
		if p == "/index.html" {
			continue
		}
		data := f.data
		if strings.HasSuffix(p, "/plugin-host.html") {
			data = withMeta(data, metaCSP(pluginHostCSP))
		}
		// The plugin frame's origin is opaque, so fonts need CORS, which Jellyfin's static files
		// don't send: its stylesheet carries Antonio inline instead.
		if p == "/css/plugin-host.css" {
			data = inlineFonts(data, a)
		}
		out := filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(p, "/")))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(out, data, 0o644); err != nil {
			return err
		}
	}
	// Jellyfin's LG TV app reads start_url from web/manifest.json to find the web client (it won't
	// connect without one); it's also what lets a phone add LCARS to its home screen.
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), manifest("static/"+version+"/icon.svg"), 0o644); err != nil {
		return err
	}
	// The server sends /robots.txt to web/robots.txt; jellyfin-web's says no to every crawler.
	if err := os.WriteFile(filepath.Join(dir, "robots.txt"), []byte("User-agent: *\nDisallow: /\n"), 0o644); err != nil {
		return err
	}
	// Relative asset URLs: index.html is /web/index.html (or /<base url>/web/...).
	idx := a.render("static/"+version+"/", "same-origin", metaCSP(csp))
	return os.WriteFile(filepath.Join(dir, "index.html"), idx, 0o644)
}

// metaCSP turns a CSP header value into a meta tag, without the directives a meta tag ignores.
func metaCSP(policy string) string {
	var keep []string
	for _, d := range strings.Split(policy, ";") {
		d = strings.TrimSpace(d)
		name, _, _ := strings.Cut(d, " ")
		if d == "" || name == "frame-ancestors" || name == "sandbox" || name == "report-uri" {
			continue
		}
		keep = append(keep, d)
	}
	return `<meta http-equiv="Content-Security-Policy" content="` + strings.Join(keep, "; ") + `">`
}

// withMeta puts a tag straight after <meta charset>, before anything the policy should cover.
func withMeta(page []byte, tag string) []byte {
	const charset = `<meta charset="utf-8">`
	if i := bytes.Index(page, []byte(charset)); i >= 0 {
		i += len(charset)
		return append(append(append([]byte{}, page[:i]...), []byte("\n"+tag)...), page[i:]...)
	}
	return append([]byte(tag+"\n"), page...)
}

// Quoted or not: the image's minifier drops the quotes.
var fontURL = regexp.MustCompile(`url\(["']?\.\./(fonts/[^"')]+\.woff2)["']?\)`)

func inlineFonts(css []byte, a *assets) []byte {
	return fontURL.ReplaceAllFunc(css, func(m []byte) []byte {
		f, ok := a.files["/"+string(fontURL.FindSubmatch(m)[1])]
		if !ok {
			return m
		}
		return []byte(`url("data:font/woff2;base64,` + base64.StdEncoding.EncodeToString(f.data) + `")`)
	})
}

// manifest is the web app manifest, with the icon at iconURL (relative to the manifest).
func manifest(iconURL string) []byte {
	return []byte(`{"name":"LCARS","short_name":"LCARS","start_url":"index.html#/home","display":"standalone",` +
		`"background_color":"#000000","theme_color":"#000000",` +
		`"icons":[{"src":"` + iconURL + `","sizes":"any","type":"image/svg+xml","purpose":"any"}]}` + "\n")
}
