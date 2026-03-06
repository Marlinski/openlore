# Offisims

A 2D office simulation game with a Zelda-like top-down perspective, built with PixiJS.

This project includes a set of standalone tools for building rooms (annotating sprites, designing floor plans, previewing rooms) and a shared rendering engine that will be reused by the game itself.

## Getting Started

```bash
npm install
```

## Tools

Three standalone browser tools for building game content. Each runs as a Vite dev server.

### Sprite Annotator

```bash
npm run annotator    # http://localhost:3001
```

Browse all 339 office sprite tiles and compose them into **composite objects**. Each composite defines:

- **Display size** — total visual footprint in tiles (e.g. 2x3 for a tall bookshelf)
- **Occupancy** — how many floor tiles it actually blocks (e.g. 2x1 for the bookshelf base)
- **Category** — floor, wall, furniture, decor, electronics, plant, door, window, other
- **Walkable** — whether characters can walk through it

Workflow:
1. Click a sprite in the left browser panel to select it
2. Set display size and occupancy in the toolbar
3. Click grid cells to place sprites (right-click or shift+click to remove)
4. Name it, pick a category, hit **Save Composite**
5. Export composites as JSON for use in the editor

The red-tinted cells in the grid show the occupancy zone (always anchored at the bottom-left of the display area).

### Floor Plan Editor

```bash
npm run editor       # http://localhost:3002
```

Design rooms by painting floors, walls, and placing composite objects onto a tile grid.

Tools:
- **Floor** — paint floor tiles from a palette
- **Wall** — paint wall tiles
- **Object** — place composites (load them from the annotator's JSON export)
- **Erase** — remove floor, wall, and objects
- **Select** — inspect placed objects

Click-drag to paint. Right-click or shift+click to erase. Zoom with the dropdown. Toggle grid and occupancy overlays.

Export rooms as `.room.json` files.

### Room Preview

```bash
npm run preview      # http://localhost:3003
```

Renders a room using the shared PixiJS engine — the same renderer the game will use. Load a room file and composites, then:

- Toggle grid and occupancy overlays
- Adjust render scale (1x–4x)
- Add animated characters (idle breathing animation)
- Drag characters around the room

Automatically loads data from localStorage if the editor has been used in the same browser.

## Architecture

```
offisims/
├── src/shared/          # Shared engine code (used by tools and game)
│   ├── types.ts         # Data models
│   ├── renderer.ts      # PixiJS room renderer
│   └── data.ts          # Save/load/export utilities
├── tools/
│   ├── annotator/       # Sprite Annotator
│   ├── editor/          # Floor Plan Editor
│   └── preview/         # Room Preview
└── data/
    ├── sprites/         # Office sprite assets (48x48 tiles)
    └── characters/      # Character sprite sheets (idle + walk)
```

### Rendering Model

- **Tile size**: 48x48 pixels
- **Camera**: top-down, slightly angled (Zelda-like)
- **Render order**: top-left to bottom-right, row by row — objects in front naturally overlap objects behind them
- **Composite anchoring**: every composite anchors at the bottom-left of its occupancy area and draws upward. A flower pot with 1x1 occupancy but 1x3 display will visually extend two tiles above its floor position, overlapping whatever is behind it.

### Data Flow

```
Annotator  ──(composites.json)──>  Editor  ──(room.json)──>  Preview / Game
```

All three tools also share data via localStorage during development, so changes in the annotator and editor are immediately available in the preview without manual file export.

### Data Formats

**composites.json** — array of composite definitions:
```json
[
  {
    "id": "comp_abc123",
    "name": "Tall Bookshelf",
    "category": "furniture",
    "displaySize": { "w": 2, "h": 3 },
    "occupancy": { "w": 2, "h": 1 },
    "tiles": [
      { "dx": 0, "dy": 0, "sprite": { "id": 120, "collection": "office_singles" } },
      { "dx": 1, "dy": 0, "sprite": { "id": 121, "collection": "office_singles" } }
    ],
    "walkable": false
  }
]
```

**room.json** — a room plan:
```json
{
  "name": "Office",
  "width": 16,
  "height": 12,
  "floor": [[ { "id": 30, "collection": "office_singles" }, null, ... ]],
  "walls": [[ null, ... ]],
  "objects": [
    { "compositeId": "comp_abc123", "gridX": 3, "gridY": 5 }
  ]
}
```

## Sprites

Uses the [LimeZu Modern Office](https://limezu.itch.io/moderninteriors) asset pack:

- **339 individual office tiles** at 16x16, 32x32, and 48x48 (we use 48x48)
- **Room builder sheet** with floor and wall tiles
- **4 characters** (Adam, Alex, Amelia, Bob) with idle and walk sprite sheets

## Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Escape` | Annotator | Deselect current sprite |
| `Ctrl+S` / `Cmd+S` | Annotator | Save current composite |
| Right-click | Annotator / Editor | Remove tile from cell |
| Shift+click | Annotator / Editor | Remove tile from cell |
