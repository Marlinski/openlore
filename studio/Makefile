# Studio — local development targets
# Run from the studio/ directory, or from repo root via `make -C studio`.

.PHONY: help dev server app embedder build check proto clean pack-js

REPO_ROOT := $(shell cd .. && pwd)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ─── Prerequisites ───────────────────────────────────────────

pack-js: ## Build @offisims/pack (required before app)
	@yarn workspace @offisims/pack build

# ─── Development ─────────────────────────────────────────────

dev: pack-js ## Start server + app + embedder in parallel
	@echo "Studio"
	@echo "  API:      http://localhost:4000"
	@echo "  App:      http://localhost:5173"
	@echo "  Embedder: http://localhost:7997"
	@trap 'kill 0' INT TERM; \
		$(MAKE) embedder & \
		$(MAKE) server & \
		$(MAKE) app & \
		wait

server: ## Start Go API server (port 4000)
	cd server && CGO_ENABLED=1 go run ./cmd/studio serve --studio-dir $(REPO_ROOT)/data/studio

app: ## Start Vite dev server (port 5173, proxies to :4000)
	yarn workspace @offisims/studio dev

embedder: ## Start Rust CLIP embedding server (port 7997, requires cargo)
	cd embedder && cargo run --release --features metal -- --port 7997 --metal

# ─── Build ───────────────────────────────────────────────────

build: pack-js ## Production build (frontend → embedded in Go binary)
	yarn workspace @offisims/studio build
	rm -rf server/cmd/studio/dist
	cp -r app/dist server/cmd/studio/dist
	cd server && CGO_ENABLED=1 go build -o studio ./cmd/studio

# ─── Quality ─────────────────────────────────────────────────

check: pack-js ## Type-check Go + TypeScript
	cd server && go vet ./...
	npx tsc -p app/tsconfig.json --noEmit

# ─── Proto ───────────────────────────────────────────────────

proto: ## Regenerate protobuf code (pack types)
	cd $(REPO_ROOT) && npx buf generate
	@mkdir -p $(REPO_ROOT)/shared/pack/go/pb/packv1 $(REPO_ROOT)/shared/pack/js/pb
	cp $(REPO_ROOT)/gen/go/offisims/pack/v1/pack.pb.go $(REPO_ROOT)/shared/pack/go/pb/packv1/
	cp $(REPO_ROOT)/gen/ts/offisims/pack/v1/pack_pb.ts $(REPO_ROOT)/shared/pack/js/pb/

# ─── Utilities ───────────────────────────────────────────────

reindex: ## Run one-shot RAG reindex (requires embedder running)
	cd server && go run ./cmd/studio reindex --studio-dir $(REPO_ROOT)/data/studio --workspace default

pack: ## Build a .offpack from workspace
	cd server && go run ./cmd/studio pack --studio-dir $(REPO_ROOT)/data/studio --workspace default

clean: ## Remove build artifacts
	rm -rf app/dist server/cmd/studio/dist server/studio
	mkdir -p server/cmd/studio/dist && touch server/cmd/studio/dist/.gitkeep
