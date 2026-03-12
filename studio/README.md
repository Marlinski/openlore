# Studio

Offisims Studio is the world editor and authoring tool for the Offisims 2D office simulation. It provides a browser-based UI for creating and editing game assets (tilesets, resources, composites, rooms, masks) backed by a Go HTTP server with RAG-powered semantic search.

## Architecture

```
studio/
├── app/          # Preact + Vite frontend (port 5173 in dev)
├── server/       # Go HTTP API server (port 4000)
└── embedder/     # Rust CLIP embedding sidecar (port 7997)
```

**Server** — Go binary with three subcommands:
- `studio serve` — HTTP API (CRUD, tilesets, RAG search) + embedded SPA
- `studio reindex` — one-shot RAG vector index rebuild
- `studio pack` — compile game data into a `.offpack` file

**App** — Preact SPA with tabs for tile cutting, resource browsing, composite building, room editing, and an AI agent panel. In dev mode Vite proxies `/api` and `/data` to the Go server.

**Embedder** — Rust sidecar using `candle` (with optional Metal GPU) to serve CLIP ViT-B/32 embeddings over an OpenAI-compatible HTTP API. Required only for RAG search features.

## Quick Start

```bash
make dev
```

This starts the Go server and Vite dev server in parallel. Open http://localhost:5173.

See `make help` for all available targets.

## Prerequisites

- **Go** >= 1.25
- **Node.js** + **Yarn** (for the frontend and shared packages)
- **Rust** (only if you need the embedder for RAG search)
- **buf** (`npx buf`) for protobuf codegen

## Data

Game assets live in `data/` at the repo root:

```
data/
├── game/
│   ├── resources/    # Resource JSON files (one per file)
│   ├── composites/   # Composite object JSON files
│   ├── rooms/        # Room definition JSON files
│   └── masks/        # Mask template JSON files
├── tilesets/         # Tileset PNG images (organized by theme)
└── rag_vectors.json  # Flat vector store (auto-generated)
```

The server auto-detects `data/` relative to the working directory, or set `STUDIO_DATA_DIR`.

## CLI Reference

```
studio [command] [flags]

Commands:
  serve       Start the HTTP server
  reindex     One-shot RAG reindex and exit
  pack        Build a .offpack from game data

Global flags:
  --data-dir  Path to data directory (env: STUDIO_DATA_DIR)

serve flags:
  -p, --port  HTTP listen port (default 4000)

pack flags:
  --id        Pack identifier
  --name      Pack display name
  --output    Output path
  --format    Output format: json, binary, zip (default zip)
```

## API

All entity endpoints follow the same pattern:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/{kind}` | List all entities |
| GET | `/api/{kind}/{id}` | Get one entity |
| PUT | `/api/{kind}/{id}` | Create or update |
| DELETE | `/api/{kind}/{id}` | Delete |

Kinds: `resources`, `composites`, `rooms` (keyed by name), `masks`.

Additional endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tilesets` | List discovered tilesets |
| GET | `/api/tilesets/{hash}` | Tileset metadata |
| GET | `/api/tilesets/{hash}/image` | Tileset PNG |
| GET | `/api/search?q=...` | Semantic text search (RAG) |
| GET | `/api/similar?id=...&kind=...` | Find similar items (RAG) |
| GET | `/api/tags` | List all tags |
| POST | `/api/reindex` | Trigger RAG reindex |
| GET | `/api/status` | Server health + RAG stats |
| GET | `/data/*` | Static data file serving |

All entity JSON uses `protojson` serialization (camelCase fields, numeric enums).
