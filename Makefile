# Offisims — Root orchestrator
#
# Studio targets delegate to studio/Makefile.
# Game targets delegate to game/Makefile.
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

# ─── Game (delegates to game/Makefile) ───────────────────────────

game:
	$(MAKE) -C game dev

game-server:
	$(MAKE) -C game server

game-client:
	$(MAKE) -C game client

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
	$(MAKE) -C game build

# ─── Type checking ───────────────────────────────────────────────

check: pack
	npx buf lint
	$(MAKE) -C studio check
	$(MAKE) -C game check
	cd shared/pack/go && go vet ./...
	@echo "All packages OK"

# ─── Cleanup ─────────────────────────────────────────────────────

clean:
	$(MAKE) -C studio clean
	$(MAKE) -C game clean
	rm -rf shared/pack/js/dist dist/ gen/
	@echo "Cleaned all dist/ and gen/ directories"
