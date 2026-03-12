# Offisims

A 2D multiplayer office simulation game with a Zelda-like top-down perspective. Includes a full world editor (Studio) and a multiplayer game runtime.

## Quick Start

```bash
yarn install
make dev
```

This starts all services in parallel:

| Service | URL | Description |
|---------|-----|-------------|
| **Studio Server** | http://localhost:4000 | Go API server (CRUD, RAG search, pack compilation) |
| **Studio App** | http://localhost:5173 | World editor (Preact + PixiJS, proxies to :4000) |
| **Game Server** | http://localhost:3001 | Authoritative game server (Go, HTTP + WebSocket) |
| **Game Client** | http://localhost:3002 | Browser game client (Preact + PixiJS, proxies to :3001) |

Press `Ctrl+C` to stop all services.

### Running individually

```bash
# Studio only (server + app + embedder)
make studio

# Game only (server + client)
make game

# Or individual services
make studio-server
make studio-app
make game-server
make game-client
```

## Project Structure

```
offisims/
├── shared/
│   ├── proto/              # Protobuf definitions (source of truth for all data types)
│   └── pack/
│       ├── go/             # Go pack library (reader, writer, atlas compiler)
│       └── js/             # TypeScript pack types (@offisims/pack)
├── studio/
│   ├── app/                # World editor SPA (Preact + PixiJS + Vite)
│   ├── server/             # Go API server (CRUD, RAG, pack compilation)
│   └── embedder/           # Rust CLIP embedding sidecar (candle + Metal GPU)
├── game/
│   ├── client/             # Browser game client (Preact + PixiJS + Vite)
│   ├── server/             # Authoritative game server (Go, WebSocket)
│   └── proto/              # Game protocol protobuf definitions
├── data/                   # Runtime data (gitignored)
│   ├── studio/             # Studio workspaces, tilesets, RAG vectors
│   └── game/packs/         # Compiled .offpack files
├── Makefile
├── buf.yaml                # Protobuf module definitions
└── package.json            # Yarn workspaces root
```

### Packages

**`@offisims/pack`** (`shared/pack/js`) — Protobuf-generated TypeScript types for the `.offpack` format. Source of truth: `shared/proto/`. Build with `make proto && make pack`.

**`@offisims/studio`** (`studio/app`) — Browser-based world editor with tabs for:
1. **Tile Cutter** — Cut tileset PNGs into tagged resources and masks
2. **Resource Browser** — Browse, search, and filter resources by tags
3. **Composite Builder** — Compose tileset regions into multi-tile objects
4. **Room Editor** — Design rooms with walkability grids, textures, doors
5. **Room Tester** — Walk around a room with a character (local preview)
6. **AI Agent** — Multi-turn AI assistant with RAG-powered asset search

**Studio Server** (`studio/server`) — Go HTTP server with:
- Generic filesystem-backed CRUD for resources, composites, rooms, masks
- Tileset discovery and hash-based identity
- RAG semantic search (CLIP embeddings + cosine similarity vector store)
- Pack compilation (atlas shelf-packing, region deduplication)
- CLI: `studio serve`, `studio reindex`, `studio pack`

**Embedder** (`studio/embedder`) — Rust sidecar serving CLIP ViT-B/32 embeddings over an OpenAI-compatible HTTP API. Uses `candle` with optional Metal GPU acceleration.

**Game Server** (`game/server`) — Authoritative Go game server:
- Single-goroutine event loop for all world state mutations (no mutexes)
- WebSocket transport for real-time position updates, chat, room transitions
- Player session management with token-based reconnection
- Loads compiled `.offpack` files from `data/game/packs/`

**Game Client** (`game/client`) — Browser game client:
- Client-side prediction with server reconciliation
- PixiJS rendering with z-sorted layers and smooth camera
- Tag-based character resource resolution at runtime
- WASD/arrow movement, room chat, private messages, door transitions

## Data Pipeline

1. **Author** content in Studio (tilesets, resources, composites, rooms)
2. **Compile** with `studio pack` into `.offpack` files (atlas shelf-packing, binary protobuf)
3. **Load** `.offpack` files in the Game Server for multiplayer sessions

## Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install all dependencies (yarn + go mod download) |
| `make proto` | Generate Go + TypeScript code from protobuf definitions |
| `make pack` | Build the shared @offisims/pack TypeScript library |
| `make studio` | Start Studio (server + app + embedder) |
| `make game` | Start Game (server + client) |
| `make dev` | Start all services in parallel |
| `make build` | Production build (Go binaries + frontend bundles) |
| `make check` | Lint protobuf, type-check Go + TypeScript |
| `make clean` | Remove all build artifacts |

## Technical Details

- **Tile size**: 48x48 pixels
- **Characters**: Tag-based resource system (`entity:character`, `name:adam`, `action:idle`, `dir:down`)
- **Rendering**: Z-sorted at render time (floor bottom-to-top, objects sorted by anchor Y + zBias)
- **Movement**: Client-side prediction with server reconciliation, pixel-granular coordinates
- **Protocol**: Protobuf-defined messages over WebSocket, position updates at ~15/sec
- **Data format**: Protobuf as source of truth, protojson for on-disk storage, binary `.offpack` for game runtime

## Sprites

Uses the [LimeZu Modern Office](https://limezu.itch.io/moderninteriors) asset pack.
