package web

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestPreloadFollowsStaticImportsOnly(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":    {Data: []byte(`<script type="module" src="/static/{{VERSION}}/js/app.js"></script>{{PRELOAD}}`)},
		"js/app.js":     {Data: []byte("import { h } from './h.js';\nimport * as f from \"./fmt.js\";\nconst r = () => import('./reader.js');")},
		"js/h.js":       {Data: []byte(`export { x } from './views/x.js';`)},
		"js/fmt.js":     {Data: []byte(`import{a as b}from"./h.js";export const n=1;`)}, // minified, and a cycle
		"js/views/x.js": {Data: []byte(`import "../side.js"; export const x = 1;`)},
		"js/side.js":    {Data: []byte(`export const s = 1;`)},
		"js/reader.js":  {Data: []byte(`export const lazy = 1;`)},
		"vendor/v.wasm": {Data: []byte(strings.Repeat("\x00asm", 300))},
	}
	a, err := loadAssets(fsys, "v1")
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(a.preloadModules(), ",")
	if want := "js/fmt.js,js/h.js,js/side.js,js/views/x.js"; got != want {
		t.Errorf("preload = %s, want %s", got, want)
	}
	idx := string(a.files["/index.html"].data)
	if !strings.Contains(idx, `<link rel="modulepreload" href="/static/v1/js/views/x.js">`) || strings.Contains(idx, "{{") {
		t.Errorf("index.html not filled in:\n%s", idx)
	}
	if w := a.files["/vendor/v.wasm"]; w.gz == nil || w.ctype != "application/wasm" {
		t.Errorf("wasm: gz=%v ctype=%q", w.gz != nil, w.ctype)
	}
}
