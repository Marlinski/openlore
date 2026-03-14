/**
 * TesterCanvas — PixiJS v8 room player.
 *
 * Renders compiled room data with WASD movement, character animation,
 * door transitions, and debug overlays.
 *
 * Consumes protojson format from the pack compiler:
 *   - TilesetRegion: { tilesetId, srcCol, srcRow, w, h } (pixel coords since tile_width=1)
 *   - ResourceFrame: same shape
 *   - Placements: layer as string enum "PLACEMENT_LAYER_FLOOR" / "PLACEMENT_LAYER_OBJECT"
 *   - Composites: resolved from compositeId via composite cache
 */

import { useRef, useEffect, useCallback } from 'preact/hooks'
import { Application, Container, Sprite, Texture, Rectangle, Graphics } from 'pixi.js'
import {
  useTesterStore,
  getAtlasImage,
  getComposite,
  normalizeLayer,
  type RoomJSON,
  type ResourceJSON,
  type TilesetRegionJSON,
  type PlacementJSON,
} from '../../store/tester'

const TILE_SIZE = 48
const CHAR_RENDER_W = 48 // 1 tile wide
const CHAR_RENDER_H = 96 // 2 tiles tall
const MOVE_SPEED = 4 // tiles per second
const WALK_FPS = 8
const IDLE_FPS = 4
const COLLISION_MARGIN = 0.05

type Dir = 'up' | 'down' | 'left' | 'right'

interface GameState {
  charX: number
  charY: number
  charDir: Dir
  animState: 'idle' | 'walk'
  animFrame: number
  animTimer: number
  keys: Set<string>
  lastDoorTile: string | null
  mounted: boolean
}

export interface TesterCanvasHandle {
  getGameState: () => {
    charX: number
    charY: number
    charDir: Dir
    animState: string
    animFrame: number
    doorInfo: string
  }
}

export interface TesterCanvasProps {
  onHandle: (handle: TesterCanvasHandle) => void
}

/**
 * Convert a TilesetRegion (protojson) to a PixiJS Texture.
 * Uses getAtlasImage(tilesetId) to find the loaded atlas image.
 * All coords are pixels since atlas tilesets use tile_width=1.
 */
function regionToTexture(region: TilesetRegionJSON): Texture | null {
  const tilesetId = region.tilesetId || ''
  if (!tilesetId) return null
  const img = getAtlasImage(tilesetId)
  if (!img) return null
  const baseTex = Texture.from(img)
  baseTex.source.scaleMode = 'nearest'
  const x = region.srcCol || 0
  const y = region.srcRow || 0
  const w = region.w || 0
  const h = region.h || 0
  if (w === 0 || h === 0) return null
  return new Texture({
    source: baseTex.source,
    frame: new Rectangle(x, y, w, h),
  })
}

function findCharResource(
  resources: ResourceJSON[],
  animState: string,
  dir: Dir,
): ResourceJSON | null {
  const hasTags = (r: ResourceJSON, ...tags: string[]) =>
    tags.every((t) => (r.tags ?? []).includes(t))

  // Try exact match: state:{animState} + dir:{dir}
  let found = resources.find((r) =>
    hasTags(r, `state:${animState}`, `dir:${dir}`),
  )
  if (found) return found

  // Fallback: state:{animState} + dir:down
  found = resources.find((r) =>
    hasTags(r, `state:${animState}`, 'dir:down'),
  )
  if (found) return found

  // Fallback: state:idle + dir:{dir}
  found = resources.find((r) =>
    hasTags(r, 'state:idle', `dir:${dir}`),
  )
  if (found) return found

  // Fallback: state:idle + dir:down
  found = resources.find((r) =>
    hasTags(r, 'state:idle', 'dir:down'),
  )
  if (found) return found

  // Last resort: first resource with any frames
  return resources.find((r) => (r.frames ?? []).length > 0) ?? null
}

function getCharTexture(
  resources: ResourceJSON[],
  animState: string,
  dir: Dir,
  frameIdx: number,
): Texture | null {
  const res = findCharResource(resources, animState, dir)
  if (!res) return null
  const frames = res.frames ?? []
  if (frames.length === 0) return null
  const frame = frames[frameIdx % frames.length]
  const tilesetId = frame.tilesetId || ''
  if (!tilesetId) return null
  const img = getAtlasImage(tilesetId)
  if (!img) return null
  const baseTex = Texture.from(img)
  baseTex.source.scaleMode = 'nearest'
  const x = frame.srcCol || 0
  const y = frame.srcRow || 0
  const w = frame.w || 0
  const h = frame.h || 0
  if (w === 0 || h === 0) return null
  return new Texture({
    source: baseTex.source,
    frame: new Rectangle(x, y, w, h),
  })
}

function getCharFrameCount(
  resources: ResourceJSON[],
  animState: string,
  dir: Dir,
): number {
  const res = findCharResource(resources, animState, dir)
  return res ? (res.frames ?? []).length : 1
}

export function TesterCanvas({ onHandle }: TesterCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const gameRef = useRef<GameState>({
    charX: 1,
    charY: 1,
    charDir: 'down',
    animState: 'idle',
    animFrame: 0,
    animTimer: 0,
    keys: new Set(),
    lastDoorTile: null,
    mounted: true,
  })

  // Store subscriptions
  const currentRoom = useTesterStore((s) => s.currentRoom)
  const charResources = useTesterStore((s) => s.charResources)
  const zoom = useTesterStore((s) => s.zoom)
  const showGrid = useTesterStore((s) => s.showGrid)
  const showWalkability = useTesterStore((s) => s.showWalkability)
  const loaded = useTesterStore((s) => s.loaded)

  // Expose game state for info panel
  useEffect(() => {
    onHandle({
      getGameState: () => {
        const g = gameRef.current
        const tileX = Math.floor(g.charX + 0.5)
        const tileY = Math.floor(g.charY + 0.5)
        const room = useTesterStore.getState().currentRoom
        let doorInfo = ''
        if (room) {
          const door = (room.doors ?? []).find(
            (d) => (d.col || 0) === tileX && (d.row || 0) === tileY,
          )
          if (door) doorInfo = `${door.id || ''} -> ${door.target || ''}`
        }
        return {
          charX: g.charX,
          charY: g.charY,
          charDir: g.charDir,
          animState: g.animState,
          animFrame: g.animFrame,
          doorInfo,
        }
      },
    })
  }, [onHandle])

  // Key listeners
  useEffect(() => {
    const game = gameRef.current
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept keys when typing in an input/select/textarea
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      const key = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        e.preventDefault()
        game.keys.add(key)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      game.keys.delete(e.key.toLowerCase())
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // Ctrl/Cmd+scroll zoom (multiplicative, matches other tabs)
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const store = useTesterStore.getState()
      const delta = -e.deltaY * 0.001
      store.setZoom(store.zoom * (1 + delta))
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  // Main PixiJS lifecycle
  useEffect(() => {
    if (!loaded || !currentRoom) return

    const wrap = wrapRef.current
    if (!wrap) return

    const game = gameRef.current
    game.mounted = true

    const room = currentRoom
    const resources = charResources
    const roomWidth = room.width || 0
    const roomHeight = room.height || 0
    const doors = room.doors ?? []
    const placements = room.placements ?? []
    const walkability = room.walkability ?? []

    // Check if we arrived via a door transition
    const pendingDoor = useTesterStore.getState().consumePendingDoor()

    // Find starting position
    let startX = 1
    let startY = 1
    let startDoorKey: string | null = null

    if (pendingDoor) {
      // Arrived via door transition — spawn at the matching door
      const arrivalDoor = doors.find((d) => d.id === pendingDoor)
      if (arrivalDoor) {
        startX = arrivalDoor.col || 0
        startY = arrivalDoor.row || 0
        // Pre-set lastDoorTile so we don't immediately re-trigger this door
        startDoorKey = `${arrivalDoor.col || 0},${arrivalDoor.row || 0}`
      }
    } else if (doors.length > 0) {
      startX = doors[0].col || 0
      startY = doors[0].row || 0
      // Also guard the spawn door to prevent immediate transition
      startDoorKey = `${doors[0].col || 0},${doors[0].row || 0}`
    } else {
      // Find first walkable tile
      for (let row = 0; row < roomHeight; row++) {
        for (let col = 0; col < roomWidth; col++) {
          if (walkability[row * roomWidth + col]) {
            startX = col
            startY = row
            row = roomHeight // break outer
            break
          }
        }
      }
    }
    game.charX = startX
    game.charY = startY
    game.charDir = 'down'
    game.animState = 'idle'
    game.animFrame = 0
    game.animTimer = 0
    game.lastDoorTile = startDoorKey

    let app: Application | null = null
    let worldContainer: Container
    let floorContainer: Container
    let objectContainer: Container
    let overlayContainer: Container
    let charSprite: Sprite
    let walkOverlay: Graphics
    let gridOverlay: Graphics
    let doorOverlay: Graphics

    // Track object sprites for z-sorting
    interface ObjSprite {
      sprite: Sprite
      anchorY: number
    }
    let objectSprites: ObjSprite[] = []

    const init = async () => {
      app = new Application()
      await app.init({
        backgroundColor: 0x1a1a2e,
        antialias: false,
        roundPixels: true,
      })

      appRef.current = app

      // Remove any old canvas
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild)
      wrap.appendChild(app.canvas)
      app.canvas.style.display = 'block'
      app.canvas.style.imageRendering = 'pixelated'

      // Stage hierarchy
      worldContainer = new Container()
      app.stage.addChild(worldContainer)

      floorContainer = new Container()
      objectContainer = new Container()
      overlayContainer = new Container()
      worldContainer.addChild(floorContainer)
      worldContainer.addChild(objectContainer)
      worldContainer.addChild(overlayContainer)

      // Build floor sprites (layer 1 = PLACEMENT_LAYER_FLOOR)
      for (const p of placements) {
        if (normalizeLayer(p.layer) !== 1) continue
        buildPlacementSprites(p, floorContainer, null)
      }

      // Build object sprites (layer 2 = PLACEMENT_LAYER_OBJECT)
      objectSprites = []
      for (const p of placements) {
        if (normalizeLayer(p.layer) !== 2) continue
        buildPlacementSprites(p, objectContainer, objectSprites)
      }

      // Character sprite
      charSprite = new Sprite()
      charSprite.width = CHAR_RENDER_W
      charSprite.height = CHAR_RENDER_H
      const charTex = getCharTexture(resources, 'idle', 'down', 0)
      if (charTex) charSprite.texture = charTex
      objectContainer.addChild(charSprite)

      // Overlays
      walkOverlay = new Graphics()
      gridOverlay = new Graphics()
      doorOverlay = new Graphics()
      overlayContainer.addChild(walkOverlay)
      overlayContainer.addChild(gridOverlay)
      overlayContainer.addChild(doorOverlay)

      buildOverlays(room, walkOverlay, gridOverlay, doorOverlay)

      // Initial zoom & sizing
      applyZoom(useTesterStore.getState().zoom)

      // Game loop
      app.ticker.add((ticker) => {
        if (!game.mounted) return
        const dt = ticker.deltaTime / 60 // convert to seconds

        // Movement
        let dx = 0
        let dy = 0
        if (game.keys.has('w') || game.keys.has('arrowup')) dy -= 1
        if (game.keys.has('s') || game.keys.has('arrowdown')) dy += 1
        if (game.keys.has('a') || game.keys.has('arrowleft')) dx -= 1
        if (game.keys.has('d') || game.keys.has('arrowright')) dx += 1

        // Diagonal normalization
        if (dx !== 0 && dy !== 0) {
          const len = Math.sqrt(dx * dx + dy * dy)
          dx /= len
          dy /= len
        }

        const moving = dx !== 0 || dy !== 0

        if (moving) {
          // Direction: vertical preferred when |dy| >= |dx|
          if (Math.abs(dy) >= Math.abs(dx)) {
            game.charDir = dy > 0 ? 'down' : 'up'
          } else {
            game.charDir = dx > 0 ? 'right' : 'left'
          }

          const speed = MOVE_SPEED * dt
          const newX = game.charX + dx * speed
          const newY = game.charY + dy * speed

          // Axis-separated collision
          if (canMoveTo(roomWidth, roomHeight, walkability, newX, game.charY)) {
            game.charX = newX
          }
          if (canMoveTo(roomWidth, roomHeight, walkability, game.charX, newY)) {
            game.charY = newY
          }

          game.animState = 'walk'
        } else {
          game.animState = 'idle'
        }

        // Animation timing
        const fps = game.animState === 'walk' ? WALK_FPS : IDLE_FPS
        game.animTimer += dt
        const frameCount = getCharFrameCount(
          resources,
          game.animState,
          game.charDir,
        )
        if (game.animTimer >= 1 / fps) {
          game.animTimer -= 1 / fps
          game.animFrame = (game.animFrame + 1) % Math.max(1, frameCount)
        }

        // Update character sprite texture
        const tex = getCharTexture(
          resources,
          game.animState,
          game.charDir,
          game.animFrame,
        )
        if (tex) charSprite.texture = tex

        // Character position: character occupies 1x2 tiles
        // Position at (charX * TILE_SIZE, (charY - 1) * TILE_SIZE)
        charSprite.x = game.charX * TILE_SIZE
        charSprite.y = (game.charY - 1) * TILE_SIZE
        charSprite.width = CHAR_RENDER_W
        charSprite.height = CHAR_RENDER_H

        // Z-sort objects
        const charAnchorY = game.charY + 1 // bottom of 2-tile character
        const allObj: { sprite: Sprite | typeof charSprite; sortY: number; sortX: number }[] = objectSprites.map(
          (o) => ({
            sprite: o.sprite,
            sortY: o.anchorY,
            sortX: o.sprite.x,
          }),
        )
        allObj.push({
          sprite: charSprite,
          sortY: charAnchorY,
          sortX: charSprite.x,
        })
        allObj.sort((a, b) => a.sortY - b.sortY || a.sortX - b.sortX)
        for (let i = 0; i < allObj.length; i++) {
          const idx = objectContainer.getChildIndex(allObj[i].sprite)
          if (idx !== i) {
            objectContainer.setChildIndex(allObj[i].sprite, i)
          }
        }

        // Door detection
        const tileX = Math.floor(game.charX + 0.5)
        const tileY = Math.floor(game.charY + 0.5)
        const doorKey = `${tileX},${tileY}`
        const door = doors.find(
          (d) => (d.col || 0) === tileX && (d.row || 0) === tileY,
        )
        if (door && door.target && doorKey !== game.lastDoorTile) {
          game.lastDoorTile = doorKey
          // Parse target: "roomName#doorId"
          const target = door.target || ''
          const [targetRoom, targetDoor] = target.includes('#')
            ? target.split('#', 2)
            : [target, '']
          if (targetRoom) {
            handleDoorTransition(targetRoom, targetDoor)
          }
        } else if (!door) {
          game.lastDoorTile = null
        }
      })
    }

    const handleDoorTransition = async (targetRoom: string, _targetDoor: string) => {
      game.mounted = false
      await useTesterStore.getState().transitionToRoom(targetRoom, _targetDoor)
      // The useEffect will re-run with the new room data.
      // pendingDoor is set in the store so the effect spawns at the right door.
    }

    const applyZoom = (z: number) => {
      if (!app || !worldContainer) return
      worldContainer.scale.set(z)
      const w = roomWidth * TILE_SIZE * z
      const h = roomHeight * TILE_SIZE * z
      app.renderer.resize(w, h)
      app.canvas.style.width = w + 'px'
      app.canvas.style.height = h + 'px'
    }

    init()

    // Subscribe to zoom/overlay changes
    const unsub = useTesterStore.subscribe((state, prevState) => {
      if (!app || !game.mounted) return

      if (state.zoom !== prevState.zoom) {
        applyZoom(state.zoom)
      }

      if (
        state.showGrid !== prevState.showGrid ||
        state.showWalkability !== prevState.showWalkability
      ) {
        if (walkOverlay && gridOverlay && doorOverlay) {
          buildOverlays(
            room,
            walkOverlay,
            gridOverlay,
            doorOverlay,
            state.showWalkability,
            state.showGrid,
          )
        }
      }
    })

    // Initial overlay state
    const storeState = useTesterStore.getState()
    // wait a tick for pixi to finish init
    setTimeout(() => {
      if (walkOverlay && gridOverlay && doorOverlay) {
        buildOverlays(
          room,
          walkOverlay,
          gridOverlay,
          doorOverlay,
          storeState.showWalkability,
          storeState.showGrid,
        )
      }
    }, 50)

    return () => {
      game.mounted = false
      game.keys.clear()
      unsub()
      if (app) {
        app.destroy(true, { children: true })
        appRef.current = null
      }
    }
  }, [loaded, currentRoom, charResources])

  // React to zoom changes outside the game loop subscription
  // (handled by the subscribe above)

  return <div ref={wrapRef} class="tester-canvas-inner" />
}

// ─── Helpers ────────────────────────────────────────────────────────

function canMoveTo(
  roomWidth: number,
  roomHeight: number,
  walkability: boolean[],
  x: number,
  y: number,
): boolean {
  // Check character center tile with margin
  const checkX = x + 0.5
  const checkY = y + 0.5
  const margin = COLLISION_MARGIN

  // Check all 4 corners of a small area around the center
  const corners = [
    [checkX - margin, checkY - margin],
    [checkX + margin, checkY - margin],
    [checkX - margin, checkY + margin],
    [checkX + margin, checkY + margin],
  ]

  for (const [cx, cy] of corners) {
    const col = Math.floor(cx)
    const row = Math.floor(cy)
    if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) {
      return false
    }
    if (!walkability[row * roomWidth + col]) {
      return false
    }
  }
  return true
}

function buildPlacementSprites(
  p: PlacementJSON,
  container: Container,
  objectSprites: { sprite: Sprite; anchorY: number }[] | null,
) {
  const gridX = p.gridX || 0
  const gridY = p.gridY || 0
  const zBias = p.zBias || 0

  // Direct region placement
  if (p.region) {
    const tex = regionToTexture(p.region)
    if (tex) {
      const sprite = new Sprite(tex)
      sprite.x = gridX * TILE_SIZE
      sprite.y = gridY * TILE_SIZE
      // Region w/h are atlas pixels (= display pixels for compiled atlas)
      const rw = p.region.w || 0
      const rh = p.region.h || 0
      sprite.width = rw
      sprite.height = rh
      container.addChild(sprite)

      if (objectSprites) {
        const heightTiles = rh / TILE_SIZE
        objectSprites.push({
          sprite,
          anchorY: gridY + heightTiles + zBias,
        })
      }
    }
  }

  // Composite placement: resolve parts from composite cache
  if (p.compositeId) {
    const comp = getComposite(p.compositeId)
    if (comp) {
      for (const part of comp.parts ?? []) {
        if (!part.region) continue
        const tex = regionToTexture(part.region)
        if (tex) {
          const sprite = new Sprite(tex)
          const offsetX = part.offsetX || 0
          const offsetY = part.offsetY || 0
          // Offsets are in tile units, region w/h are in atlas pixels
          sprite.x = gridX * TILE_SIZE + offsetX * TILE_SIZE
          sprite.y = gridY * TILE_SIZE + offsetY * TILE_SIZE
          const rw = part.region.w || 0
          const rh = part.region.h || 0
          sprite.width = rw
          sprite.height = rh
          container.addChild(sprite)

          if (objectSprites) {
            const heightTiles = rh / TILE_SIZE
            const partZBias = part.zBias || 0
            objectSprites.push({
              sprite,
              anchorY:
                gridY +
                offsetY +
                heightTiles +
                partZBias +
                zBias,
            })
          }
        }
      }
    }
  }
}

function buildOverlays(
  room: RoomJSON,
  walkOverlay: Graphics,
  gridOverlay: Graphics,
  doorOverlay: Graphics,
  showWalkability?: boolean,
  showGrid?: boolean,
) {
  const roomWidth = room.width || 0
  const roomHeight = room.height || 0
  const walkability = room.walkability ?? []
  const doors = room.doors ?? []

  // Use store state if not provided
  if (showWalkability === undefined) {
    showWalkability = useTesterStore.getState().showWalkability
  }
  if (showGrid === undefined) {
    showGrid = useTesterStore.getState().showGrid
  }

  // Walkability overlay
  walkOverlay.clear()
  if (showWalkability) {
    for (let row = 0; row < roomHeight; row++) {
      for (let col = 0; col < roomWidth; col++) {
        const walkable = walkability[row * roomWidth + col]
        walkOverlay.rect(
          col * TILE_SIZE,
          row * TILE_SIZE,
          TILE_SIZE,
          TILE_SIZE,
        )
        if (walkable) {
          walkOverlay.fill({ color: 0x00ff00, alpha: 0.2 })
        } else {
          walkOverlay.fill({ color: 0xff0000, alpha: 0.25 })
        }
      }
    }
  }

  // Grid overlay
  gridOverlay.clear()
  if (showGrid) {
    gridOverlay.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.1 })
    for (let row = 0; row <= roomHeight; row++) {
      gridOverlay.moveTo(0, row * TILE_SIZE)
      gridOverlay.lineTo(roomWidth * TILE_SIZE, row * TILE_SIZE)
      gridOverlay.stroke()
    }
    for (let col = 0; col <= roomWidth; col++) {
      gridOverlay.moveTo(col * TILE_SIZE, 0)
      gridOverlay.lineTo(col * TILE_SIZE, roomHeight * TILE_SIZE)
      gridOverlay.stroke()
    }
  }

  // Door overlay (always visible)
  doorOverlay.clear()
  for (const door of doors) {
    doorOverlay.rect(
      (door.col || 0) * TILE_SIZE,
      (door.row || 0) * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    )
    doorOverlay.fill({ color: 0x9370db, alpha: 0.35 })
  }
}
