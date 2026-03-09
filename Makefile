# Offisims — Development commands
#
# Ports:
#   Tools   → http://localhost:3000
#   Server  → http://localhost:3001 (API + WebSocket + static assets)
#   Client  → http://localhost:3002 (proxies /api, /data, /ws to server)

.PHONY: install shared tools server client dev check build clean

# ─── Setup ───────────────────────────────────────────────────────

## Install all dependencies
install:
	yarn install

## Build the shared package (required before other packages)
shared:
	yarn workspace @offisims/shared build

# ─── Dev servers (run each in its own terminal) ──────────────────

## Start the content tools (port 3000)
tools: shared
	yarn workspace @offisims/tools dev

## Start the game server (port 3001)
server: shared
	yarn workspace @offisims/server dev

## Start the game client (port 3002)
client: shared
	yarn workspace @offisims/client dev

# ─── Run everything ─────────────────────────────────────────────

## Start all 3 dev servers in parallel (tools + server + client)
dev: shared
	@echo "Starting all dev servers..."
	@echo "  Tools:  http://localhost:3000"
	@echo "  Server: http://localhost:3001"
	@echo "  Client: http://localhost:3002"
	@echo ""
	@trap 'kill 0' INT TERM; \
		yarn workspace @offisims/tools dev & \
		yarn workspace @offisims/server dev & \
		yarn workspace @offisims/client dev & \
		wait

# ─── Type checking & building ────────────────────────────────────

## Type-check all packages (no emit)
check: shared
	npx tsc -p packages/server/tsconfig.json --noEmit
	npx tsc -p packages/client/tsconfig.json --noEmit
	npx tsc -p packages/tools/tsconfig.json --noEmit
	@echo "All packages type-check OK"

## Production build (all packages)
build: shared
	yarn workspace @offisims/server build
	yarn workspace @offisims/client build
	yarn workspace @offisims/tools build
	@echo "Build complete"

# ─── Cleanup ─────────────────────────────────────────────────────

## Remove all build artifacts
clean:
	rm -rf packages/shared/dist
	rm -rf packages/server/dist
	rm -rf packages/client/dist
	rm -rf packages/tools/dist
	@echo "Cleaned all dist/ directories"
