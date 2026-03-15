# Game — local development targets
# Run from the game/ directory, or from repo root via `make -C game`.

.PHONY: help dev server client build check clean kill

REPO_ROOT := $(shell cd .. && pwd)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ─── Development ─────────────────────────────────────────────

dev: ## Start server + client in parallel
	@echo "Game"
	@echo "  Server: http://localhost:3001"
	@echo "  Client: http://localhost:3002"
	@trap 'kill 0' INT TERM; \
		$(MAKE) server & \
		while ! curl -sf http://localhost:3001/api/status > /dev/null 2>&1; do sleep 0.2; done; \
		$(MAKE) client & \
		wait

server: ## Start Go game server (port 3001)
	cd server && go run ./cmd/game --data-dir $(REPO_ROOT)/data/game --default-room main_office

client: ## Start Vite dev server (port 3002, proxies to :3001)
	VITE_IRC_URL=ws://localhost:8080/ws yarn workspace @offisims/client dev

# ─── Build ───────────────────────────────────────────────────

build: ## Production build
	yarn workspace @offisims/client build
	cd server && go build -o ../../dist/game-server ./cmd/game

# ─── Quality ─────────────────────────────────────────────────

check: ## Type-check Go + TypeScript
	cd server && go vet ./...
	npx tsc -p client/tsconfig.json --noEmit

# ─── Utilities ───────────────────────────────────────────────

clean: ## Remove build artifacts
	rm -rf client/dist server/dist

kill: ## Kill game processes (server + vite)
	@echo "Killing game processes..."
	@-lsof -i :3001 -t 2>/dev/null | xargs kill 2>/dev/null; true
	@-lsof -i :3002 -t 2>/dev/null | xargs kill 2>/dev/null; true
	@echo "Done."
