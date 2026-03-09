# Offisims

A 2D office simulation game with a Zelda-like top-down perspective, built with PixiJS and TypeScript.

## Quick Start

```bash
yarn install
make dev
```

This builds the shared package, then starts all three dev servers in parallel:

| Service | URL | Description |
|---------|-----|-------------|
| **Tools** | http://localhost:3000 | Content creation tools (composite builder, room editor, character definer, room tester) |
| **Server** | http://localhost:3001 | Game server (HTTP API + WebSocket + static assets) |
| **Client** | http://localhost:3002 | Game client (Vite dev server, proxies to server) |

Press `Ctrl+C` to stop all three.

### Running individually

If you prefer separate terminals:

```bash
# Terminal 1 — build shared (required first)
make shared

# Terminal 2 — content tools
make tools

# Terminal 3 — game server
make server

# Terminal 4 — game client
make client
```

## Project Structure

Yarn workspaces monorepo with 4 packages:

```
offisims/
├── packages/
│   ├── shared/          # Types, protocol, constants (built first)
│   ├── tools/           # Content creation tools (Vite + PixiJS)
│   ├── server/          # Game server (Express + ws)
│   └── client/          # Game client (Vite + PixiJS)
├── data/
│   ├── sprites/         # Tileset PNGs (LimeZu Modern Office)
│   ├── characters/      # Character sprite sheets (idle + walk)
│   └── game/
│       └── game-data.json  # Current game state (rooms, characters, composites, tilesets)
├── Makefile
└── package.json
```

### Packages

**`@offisims/shared`** — Shared types and protocol definitions used by all other packages. Must be built before anything else (`make shared`).

**`@offisims/tools`** — Browser-based content tools with 4 tabs:
1. **Composite Builder** — Compose tileset sprites into multi-tile objects
2. **Room Editor** — Design rooms with walkability, textures, doors
3. **Character Definer** — Map sprite sheet regions to animation families/directions
4. **Room Tester** — Walk around a room with a character (local preview)

**`@offisims/server`** — Authoritative game server:
- HTTP API: `GET/PUT /api/game-data`, `GET /api/rooms`, `GET /api/rooms/:name`
- WebSocket: position updates, chat, room transitions
- Static file serving for `/data/*` assets

**`@offisims/client`** — Browser game client:
- WebSocket connection with client-side prediction
- PixiJS rendering with z-sorted layers
- WASD/arrow movement, chat, door transitions

## Syncing Tools to Server

The tools and server can sync game data bidirectionally:

- **"Sync to Server"** button in tools topbar — pushes all project data (tilesets, composites, rooms, characters) to the running server via `PUT /api/game-data`. The server saves to disk and hot-reloads.
- **"Load from Server"** button — pulls game data from the server and replaces local tools state.

The tools proxy `/api` requests to `http://localhost:3001`, so the server must be running for sync to work.

## Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install all dependencies |
| `make shared` | Build the shared package |
| `make tools` | Start tools dev server (port 3000) |
| `make server` | Start game server (port 3001) |
| `make client` | Start game client (port 3002) |
| `make dev` | Start all 3 dev servers in parallel |
| `make check` | Type-check all packages |
| `make build` | Production build (all packages) |
| `make clean` | Remove all dist/ directories |

## Technical Details

- **Tile size**: 48x48 pixels
- **Character sprites**: 16x32 source frames, scaled to 48x96 (1x2 tiles) for rendering
- **Rendering**: Z-sorted at render time (floor layer top-to-bottom, then object layer sorted by anchor Y + zBias)
- **Movement**: Client-side prediction with server reconciliation, pixel-granular coordinates
- **Protocol**: Position-based updates at ~15/sec, pixel coordinates, modular message types

## Sprites

Uses the [LimeZu Modern Office](https://limezu.itch.io/moderninteriors) asset pack:
- Room builder sheet with floor and wall tiles
- Office furniture/decor sheets (shadow and shadowless variants)
- 4 characters (Adam, Alex, Amelia, Bob) with idle and walk sprite sheets
