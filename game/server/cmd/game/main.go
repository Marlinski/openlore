package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/offisims/game/internal/api"
	"github.com/offisims/game/internal/channelstore"
	"github.com/offisims/game/internal/config"
	"github.com/offisims/game/internal/game"
	"github.com/offisims/game/internal/packstore"
)

func main() {
	cfg := config.Load()

	// ── Pack store ────────────────────────────────────────────────────────
	packs := packstore.New(cfg.PacksDir)

	// Discover installed packs
	if err := packs.Scan(); err != nil {
		log.Fatalf("failed to scan packs: %v", err)
	}

	for _, m := range packs.List() {
		log.Printf("pack: %s (%s)", m.Id, m.Name)
	}

	// ── Channel store (persisted channel→pack bindings) ──────────────────
	channels := channelstore.NewFileStore(cfg.ChannelsDir)

	// ── Player store ─────────────────────────────────────────────────────
	players := game.NewPlayerStore()

	// ── World store ──────────────────────────────────────────────────────
	chat := game.NewMemoryChatProvider()
	worlds := game.NewStore(chat, players)

	// Restore saved channels from disk
	saved, err := channels.List()
	if err != nil {
		log.Fatalf("failed to list channels: %v", err)
	}
	for _, ch := range saved {
		p, err := packs.Get(ch.PackID)
		if err != nil {
			log.Printf("skip channel %s: pack %q not found", ch.Channel, ch.PackID)
			continue
		}
		if _, err := worlds.Create(ch.Channel, ch.PackID, p); err != nil {
			log.Printf("skip channel %s: %v", ch.Channel, err)
			continue
		}
		log.Printf("restored channel %s (pack %s)", ch.Channel, ch.PackID)
	}

	// Auto-start a default channel from the --pack flag (convenience for single-world setups).
	// Only if no channels were restored and --pack is set.
	if cfg.DefaultPack != "" && worlds.Count() == 0 {
		p, err := packs.Get(cfg.DefaultPack)
		if err != nil {
			log.Fatalf("cannot load default pack %q: %v", cfg.DefaultPack, err)
		}
		channel := "#default"
		world, err := worlds.Create(channel, cfg.DefaultPack, p)
		if err != nil {
			log.Fatalf("cannot create default channel: %v", err)
		}
		// Persist so it survives restart
		if err := channels.Save(channelstore.NewChannelConfig(channel, cfg.DefaultPack)); err != nil {
			log.Printf("warning: could not persist default channel: %v", err)
		}
		log.Printf("auto-started channel %q from pack %q", world.Channel, cfg.DefaultPack)
	}

	// ── HTTP server ──────────────────────────────────────────────────────
	handlers := api.NewHandlers(cfg, packs, worlds, players, channels)
	router := api.NewRouter(cfg, handlers)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("game server listening on http://localhost%s", addr)
	log.Printf("data dir: %s  packs dir: %s  channels dir: %s", cfg.DataDir, cfg.PacksDir, cfg.ChannelsDir)
	log.Printf("packs: %d installed, channels: %d active", packs.Count(), worlds.Count())
	log.Printf("ws endpoint: ws://localhost%s/ws", addr)

	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
