package config

import (
	"flag"
	"os"
	"path/filepath"
)

type Config struct {
	Port        int
	DataDir     string
	DefaultRoom string
	DefaultPack string

	// Derived paths
	PacksDir string // {DataDir}/packs/
}

func Load() *Config {
	port := flag.Int("port", 3001, "HTTP listen port")
	dataDir := flag.String("data-dir", defaultDataDir(), "path to data directory")
	defaultRoom := flag.String("default-room", "", "default room name for new avatars")
	defaultPack := flag.String("pack", envOr("GAME_DEFAULT_PACK", ""), "auto-start session from this pack ID on boot")
	flag.Parse()

	return &Config{
		Port:        envInt("GAME_PORT", *port),
		DataDir:     *dataDir,
		DefaultRoom: *defaultRoom,
		DefaultPack: *defaultPack,
		PacksDir:    filepath.Join(*dataDir, "packs"),
	}
}

func defaultDataDir() string {
	if d := os.Getenv("GAME_DATA_DIR"); d != "" {
		return d
	}
	// When run from repo root: data/game exists
	if _, err := os.Stat("data/game"); err == nil {
		abs, _ := filepath.Abs("data/game")
		return abs
	}
	// When run from game/server/ (make game-server): two levels up
	if _, err := os.Stat("../../data/game"); err == nil {
		abs, _ := filepath.Abs("../../data/game")
		return abs
	}
	abs, _ := filepath.Abs("data/game")
	return abs
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	// Simple int parse — ignore errors, use fallback
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return fallback
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return fallback
	}
	return n
}
