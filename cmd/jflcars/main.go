// Command jflcars serves the LCARS Jellyfin client and proxies /jf/* to Jellyfin.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/LuckyNoS7evin/jellyfin-lcars/internal/web"
	webui "github.com/LuckyNoS7evin/jellyfin-lcars/web"
)

var version = "dev" // set with -ldflags "-X main.version=..."

// Private, Docker, CGNAT (Tailscale and the like) and loopback ranges.
const defaultCIDRs = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,127.0.0.0/8,::1/128,fc00::/7"

func main() {
	health := flag.Bool("healthcheck", false, "probe the local server and exit (for the container healthcheck)")
	flag.Parse()
	if *health {
		os.Exit(healthcheck())
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
	var cidrs []netip.Prefix
	for _, c := range strings.Split(env("JFL_ALLOWED_CIDRS", defaultCIDRs), ",") {
		p, err := netip.ParsePrefix(strings.TrimSpace(c))
		if err != nil {
			return fmt.Errorf("JFL_ALLOWED_CIDRS: %w", err)
		}
		cidrs = append(cidrs, p)
	}

	srv, err := web.New(web.Options{Jellyfin: jf, AllowedCIDRs: cidrs, Static: webui.Static(), Version: version})
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
	slog.Info("jellyfin-lcars listening", "addr", listen, "version", version, "jellyfin", jf.Redacted())

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

func healthcheck() int {
	addr := env("JFL_LISTEN", "127.0.0.1:8080")
	if addr[0] == ':' {
		addr = "127.0.0.1" + addr
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
