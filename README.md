# Offisims

A 2D multiplayer office simulation game with a Zelda-like top-down perspective. Includes a full world editor (Studio) and a multiplayer game runtime with channel-based rooms.

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

## Architecture

### Studio → Game Pipeline

Studio is a pure design tool that produces **packs** — immutable visual artifacts containing tilesets, rooms, and resources. Packs are compiled into `.offpack` files and published to the game server.

```
Studio (design) → .offpack → Game Server (runtime)
```

The publish flow is server-to-server: the Studio Go backend compiles the workspace and POSTs the `.offpack` directly to the Game Server's pack install API. The game server URL defaults to `https://app.openlore.xyz` and can be overridden with the `GAME_SERVER_URL` environment variable.

### Channels

The game server organizes multiplayer sessions into **channels** (e.g. `#lobby`, `#office`). Each channel is bound to a pack and runs its own world instance. Players browse available channels after logging in and join one to enter the game.

Channel state is persisted to disk — the server restores all channels on restart.

### IRC Integration (planned)

The target architecture uses **IRC as the source of truth** for rooms and presence. Each game channel maps to an IRC channel. The game server (`@offisim`) is a privileged IRC service user that manages visual/spatial state only. Channel lifecycle, chat, presence, modes, and passwords are IRC's domain.

- Walking through a door = `PART #room1` + `JOIN #room2`
- Chat goes through IRC; the game renders it visually
- Player presence = IRC `NAMES`/`WHO` queries
- The game server observes and relays — it doesn't own communication

Players connect to IRC independently via WebSocket (aircd). The `ChatProvider` interface in the game server is designed to swap from the current in-memory implementation to an IRC-backed one.

## Docker

Both services have multi-stage Dockerfiles. Build from the repo root:

```bash
# Game (Go server + Preact client behind nginx)
docker build -f game/Dockerfile -t offisims-game .
docker run -p 80:80 -v ./data/game:/data offisims-game

# Studio (single Go binary with embedded frontend)
docker build -f studio/Dockerfile -t offisims-studio .
docker run -p 4000:4000 -v ./data/studio:/data offisims-studio
```

| Env Variable | Default | Description |
|---|---|---|
| `GAME_DATA_DIR` | `/data` | Game server data directory (packs, channels) |
| `GAME_PORT` | `3001` | Internal game server port (nginx proxies to it) |
| `GAME_DEFAULT_PACK` | *(none)* | Auto-start a channel with this pack ID |
| `STUDIO_DIR` | `/data` | Studio data directory (workspaces) |
| `GAME_SERVER_URL` | `https://app.openlore.xyz` | Where Studio publishes packs to |

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
│   ├── embedder/           # Rust CLIP embedding sidecar (candle + Metal GPU)
│   └── Dockerfile
├── game/
│   ├── client/             # Browser game client (Preact + PixiJS + Vite)
│   ├── server/             # Authoritative game server (Go, WebSocket)
│   ├── proto/              # Game protocol protobuf definitions
│   └── Dockerfile
├── data/                   # Runtime data (gitignored)
│   ├── studio/             # Studio workspaces, tilesets, RAG vectors
│   └── game/
│       ├── packs/          # Installed .offpack files
│       └── channels/       # Persisted channel configs (JSON)
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
- Pack publishing to the game server
- CLI: `studio serve`, `studio reindex`, `studio pack`

**Embedder** (`studio/embedder`) — Rust sidecar serving CLIP ViT-B/32 embeddings over an OpenAI-compatible HTTP API. Uses `candle` with optional Metal GPU acceleration.

**Game Server** (`game/server`) — Authoritative Go game server:
- Channel-based room management (each channel = one world instance with a pack)
- Single-goroutine event loop per channel (no mutexes)
- WebSocket transport for real-time position updates, chat, room transitions
- Player registration with token-based reconnection
- Channel persistence via a `Store` interface (FileStore writes JSON to disk)
- `ChatProvider` interface designed for future IRC swap
- Loads compiled `.offpack` files from `data/game/packs/`

**Game Client** (`game/client`) — Browser game client:
- Three-screen flow: join → channel browser → game
- Channel browser with player counts and create-channel form
- Status bar with Game WS / IRC WS connection indicators
- Client-side prediction with server reconciliation
- PixiJS rendering with z-sorted layers and smooth camera
- Tag-based character resource resolution at runtime
- WASD/arrow movement, room chat, private messages, door transitions

## Data Pipeline

1. **Author** content in Studio (tilesets, resources, composites, rooms)
2. **Compile** with `studio pack` into `.offpack` files (atlas shelf-packing, binary protobuf)
3. **Publish** from Studio to Game Server (server-to-server `.offpack` upload)
4. **Play** — players join channels, each bound to a pack, for multiplayer sessions

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
- **Protocol**: JSON messages over WebSocket, position updates at ~15/sec
- **Data format**: Protobuf as source of truth, protojson for on-disk storage, binary `.offpack` for game runtime
- **Persistence**: Interface-based stores (`channelstore.Store`, `ChatProvider`) so backends can be swapped (e.g. to SQL or IRC later)

## Sprites

Uses the [LimeZu Modern Office](https://limezu.itch.io/moderninteriors) asset pack.
