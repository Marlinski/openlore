# OpenLore — Root orchestrator
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
        landing landing-pack \
        dev kill build check clean

# ─── Setup ───────────────────────────────────────────────────────

install:
	yarn install
	cd studio/server && go mod download
	cd game/server && go mod download
	cd shared/pack/go && go mod download

proto:
	npx buf generate
	@mkdir -p shared/pack/go/pb/packv1 game/server/internal/game/pb/protocolv1 shared/pack/js/pb game/client/src/pb
	cp gen/go/openlore/pack/v1/pack.pb.go shared/pack/go/pb/packv1/
	cp gen/go/openlore/protocol/v1/protocol.pb.go game/server/internal/game/pb/protocolv1/
	cp gen/ts/openlore/pack/v1/pack_pb.ts shared/pack/js/pb/
	cp gen/ts/openlore/protocol/v1/protocol_pb.ts game/client/src/pb/
	rm -rf gen/
	@echo "Proto generated and copied"

pack:
	yarn workspace @openlore/pack build

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

# ─── Landing (openlore.xyz) ──────────────────────────────────────

# The hero runs the real game client renderer, so it needs a JS build.
landing: pack
	yarn workspace @openlore/landing-demo build

# Re-vendor landing/pack/ from a compiled pack (after changing the world).
landing-pack:
	python3 landing/vendor-pack.py

# ─── All together ────────────────────────────────────────────────

dev:
	@echo "OpenLore"
	@echo "  Studio API:      http://localhost:4000"
	@echo "  Studio App:      http://localhost:5173"
	@echo "  Studio Embedder: http://localhost:7997"
	@echo "  Game Server:     http://localhost:3001"
	@echo "  Game Client:     http://localhost:3002"
	@trap 'kill 0' INT TERM; \
		$(MAKE) -C studio dev & \
		$(MAKE) -C game dev & \
		wait

kill:
	$(MAKE) -C studio kill
	$(MAKE) -C game kill

# ─── Build ───────────────────────────────────────────────────────

build: pack
	$(MAKE) -C studio build
	$(MAKE) -C game build
	$(MAKE) landing

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
