// Package webui embeds the browser client.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// Static returns the files under static/ (index.html at the root).
func Static() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
