// Command jflcars is LCARS's development server (the client, with /jf/* proxied to a Jellyfin
// server) and, with -export, writes the client out as the web folder for the Jellyfin image.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/LuckyNoS7evin/jellyfin-lcars/internal/web"
	webui "github.com/LuckyNoS7evin/jellyfin-lcars/web"
)

var version = "dev" // set with -ldflags "-X main.version=..."

func main() {
	export := flag.String("export", "", "write LCARS as a web client folder for Jellyfin (JELLYFIN_WEB_DIR) to this path and exit")
	flag.Parse()
	if *export != "" {
		if err := web.Export(webui.Static(), version, *export); err != nil {
			fmt.Fprintln(os.Stderr, "export:", err)
			os.Exit(1)
		}
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	listen := env("JFL_LISTEN", ":8080")
	raw := os.Getenv("JELLYFIN_URL")
	if raw == "" {
		return fmt.Errorf("JELLYFIN_URL is not set: point it at your Jellyfin server, e.g. http://jellyfin:8096")
	}
	jf, err := url.Parse(raw)
	if err != nil || jf.Host == "" {
		return fmt.Errorf("JELLYFIN_URL: not a URL")
	}
	srv, err := web.New(web.Options{Jellyfin: jf, Static: webui.Static(), Version: version})
	if err != nil {
		return err
	}
	// No ReadTimeout/WriteTimeout: video streams and WebSockets are long-lived.
	hs := &http.Server{
		Addr:              listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	slog.Info("LCARS dev server listening", "addr", listen, "version", version, "jellyfin", jf.Redacted())

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return hs.Shutdown(sctx)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
