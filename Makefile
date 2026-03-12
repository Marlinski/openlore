# Offisims — Root orchestrator
#
# Studio targets delegate to studio/Makefile (single source of truth).
# Game targets are defined here (no game/Makefile yet).
#
# Ports:
#   studio/server → http://localhost:4000  (Go, data API + RAG)
#   studio/app    → http://localhost:5173  (Preact, proxies /api + /data to :4000)
#   game/server   → http://localhost:3001  (Go, WebSocket game server)
#   game/client   → http://localhost:3002  (Preact, proxies to game server)

.PHONY: install proto pack \
        studio studio-server studio-app \
        game game-server game-client \
        dev build check clean

# ─── Setup ───────────────────────────────────────────────────────

install:
	yarn install
	cd studio/server && go mod download
	cd game/server && go mod download
	cd shared/pack/go && go mod download

proto:
	npx buf generate
	@mkdir -p shared/pack/go/pb/packv1 game/server/internal/game/pb/protocolv1 shared/pack/js/pb game/client/src/pb
	cp gen/go/offisims/pack/v1/pack.pb.go shared/pack/go/pb/packv1/
	cp gen/go/offisims/protocol/v1/protocol.pb.go game/server/internal/game/pb/protocolv1/
	cp gen/ts/offisims/pack/v1/pack_pb.ts shared/pack/js/pb/
	cp gen/ts/offisims/protocol/v1/protocol_pb.ts game/client/src/pb/
	rm -rf gen/
	@echo "Proto generated and copied"

pack:
	yarn workspace @offisims/pack build

# ─── Studio (delegates to studio/Makefile) ───────────────────────

studio:
	$(MAKE) -C studio dev

studio-server:
	$(MAKE) -C studio server

studio-app:
	$(MAKE) -C studio app

# ─── Game ────────────────────────────────────────────────────────

game-server:
	cd game/server && go run ./cmd/game

game-client: pack
	yarn workspace @offisims/client dev

game:
	@echo "Starting Game..."
	@echo "  Server: http://localhost:3001"
	@echo "  Client: http://localhost:3002"
	@trap 'kill 0' INT TERM; \
		$(MAKE) game-server & \
		while ! curl -sf http://localhost:3001/api/status > /dev/null 2>&1; do sleep 0.2; done; \
		$(MAKE) game-client & \
		wait

# ─── All together ────────────────────────────────────────────────

dev:
	@trap 'kill 0' INT TERM; \
		$(MAKE) studio-server & \
		$(MAKE) game-server & \
		$(MAKE) studio-app & \
		$(MAKE) game-client & \
		wait

# ─── Build ───────────────────────────────────────────────────────

build: pack
	$(MAKE) -C studio build
	yarn workspace @offisims/client build
	cd game/server && go build -o ../../dist/game-server ./cmd/game

# ─── Type checking ───────────────────────────────────────────────

check: pack
	npx buf lint
	$(MAKE) -C studio check
	npx tsc -p game/client/tsconfig.json --noEmit
	cd shared/pack/go && go vet ./...
	cd game/server && go vet ./...
	@echo "All packages OK"

# ─── Cleanup ─────────────────────────────────────────────────────

clean:
	$(MAKE) -C studio clean
	rm -rf shared/pack/js/dist game/server/dist game/client/dist dist/ gen/
	@echo "Cleaned all dist/ and gen/ directories"
