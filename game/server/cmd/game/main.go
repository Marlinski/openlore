package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/offisims/game/internal/api"
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

	// ── Player store ─────────────────────────────────────────────────────
	players := game.NewPlayerStore()

	// ── World store ──────────────────────────────────────────────────────
	chat := game.NewMemoryChatProvider()
	worlds := game.NewStore(chat, players)

	// Auto-start a world from the --pack flag (convenience for single-world setups)
	if cfg.DefaultPack != "" {
		p, err := packs.Get(cfg.DefaultPack)
		if err != nil {
			log.Fatalf("cannot load default pack %q: %v", cfg.DefaultPack, err)
		}
		id := worlds.GenerateID()
		world, err := worlds.Create(id, "", cfg.DefaultPack, p)
		if err != nil {
			log.Fatalf("cannot create default world: %v", err)
		}
		log.Printf("auto-started world %q from pack %q", world.ID, cfg.DefaultPack)
	}

	// ── HTTP server ──────────────────────────────────────────────────────
	handlers := api.NewHandlers(cfg, packs, worlds, players)
	router := api.NewRouter(cfg, handlers)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("game server listening on http://localhost%s", addr)
	log.Printf("data dir: %s  packs dir: %s", cfg.DataDir, cfg.PacksDir)
	log.Printf("packs: %d installed, worlds: %d active", packs.Count(), worlds.Count())
	log.Printf("ws endpoint: ws://localhost%s/ws", addr)

	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
