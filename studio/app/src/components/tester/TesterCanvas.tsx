/**
 * TesterCanvas — PixiJS v8 room player.
 *
 * Renders compiled room data with WASD movement, character animation,
 * door transitions, and debug overlays.
 */

import { useRef, useEffect, useCallback } from 'preact/hooks'
import { Application, Container, Sprite, Texture, Rectangle, Graphics } from 'pixi.js'
import {
  useTesterStore,
  getAtlasImage,
  type CompiledRoom,
  type CompiledResource,
  type CompiledRegionRef,
  type CompiledPlacement,
} from '../../store/tester'

const TILE_SIZE = 48
const CHAR_SRC_W = 16
const CHAR_SRC_H = 32
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

function regionToTexture(region: CompiledRegionRef): Texture | null {
  const img = getAtlasImage(region.atlas)
  if (!img) return null
  const baseTex = Texture.from(img)
  baseTex.source.scaleMode = 'nearest'
  return new Texture({
    source: baseTex.source,
    frame: new Rectangle(region.x, region.y, region.w, region.h),
  })
}

function findCharResource(
  resources: CompiledResource[],
  animState: string,
  dir: Dir,
): CompiledResource | null {
  // Try exact match: state:{animState} + dir:{dir}
  let found = resources.find(
    (r) =>
      r.tags.includes(`state:${animState}`) && r.tags.includes(`dir:${dir}`),
  )
  if (found) return found

  // Fallback: state:{animState} + dir:down
  found = resources.find(
    (r) =>
      r.tags.includes(`state:${animState}`) && r.tags.includes('dir:down'),
  )
  if (found) return found

  // Fallback: state:idle + dir:{dir}
  found = resources.find(
    (r) => r.tags.includes('state:idle') && r.tags.includes(`dir:${dir}`),
  )
  if (found) return found

  // Fallback: state:idle + dir:down
  found = resources.find(
    (r) => r.tags.includes('state:idle') && r.tags.includes('dir:down'),
  )
  if (found) return found

  // Last resort: first resource with any frames
  return resources.find((r) => r.frames.length > 0) ?? null
}

function getCharTexture(
  resources: CompiledResource[],
  animState: string,
  dir: Dir,
  frameIdx: number,
): Texture | null {
  const res = findCharResource(resources, animState, dir)
  if (!res || res.frames.length === 0) return null
  const frame = res.frames[frameIdx % res.frames.length]
  const img = getAtlasImage(frame.atlas)
  if (!img) return null
  const baseTex = Texture.from(img)
  baseTex.source.scaleMode = 'nearest'
  return new Texture({
    source: baseTex.source,
    frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
  })
}

function getCharFrameCount(
  resources: CompiledResource[],
  animState: string,
  dir: Dir,
): number {
  const res = findCharResource(resources, animState, dir)
  return res ? res.frames.length : 1
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
          const door = room.doors.find(
            (d) => d.col === tileX && d.row === tileY,
          )
          if (door) doorInfo = `${door.id} -> ${door.target}`
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

  // Ctrl+scroll zoom
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const store = useTesterStore.getState()
      const delta = e.deltaY > 0 ? -0.25 : 0.25
      store.setZoom(store.zoom + delta)
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

    // Find a starting position (first walkable tile or first door)
    let startX = 1
    let startY = 1
    if (room.doors.length > 0) {
      startX = room.doors[0].col
      startY = room.doors[0].row
    } else {
      // Find first walkable tile
      for (let row = 0; row < room.height; row++) {
        for (let col = 0; col < room.width; col++) {
          if (room.walkability[row * room.width + col]) {
            startX = col
            startY = row
            row = room.height // break outer
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
    game.lastDoorTile = null

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

      // Build floor sprites
      for (const p of room.placements) {
        if (p.layer !== 'floor') continue
        buildPlacementSprites(p, floorContainer, null)
      }

      // Build object sprites
      objectSprites = []
      for (const p of room.placements) {
        if (p.layer !== 'object') continue
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
          if (canMoveTo(room, newX, game.charY)) {
            game.charX = newX
          }
          if (canMoveTo(room, game.charX, newY)) {
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
        const door = room.doors.find(
          (d) => d.col === tileX && d.row === tileY,
        )
        if (door && door.target && doorKey !== game.lastDoorTile) {
          game.lastDoorTile = doorKey
          // Parse target: "roomName#doorId"
          const [targetRoom, targetDoor] = door.target.includes('#')
            ? door.target.split('#', 2)
            : [door.target, '']
          if (targetRoom) {
            handleDoorTransition(targetRoom, targetDoor)
          }
        } else if (!door) {
          game.lastDoorTile = null
        }
      })
    }

    const handleDoorTransition = async (targetRoom: string, targetDoor: string) => {
      game.mounted = false
      await useTesterStore.getState().transitionToRoom(targetRoom, targetDoor)
      // The useEffect will re-run with the new room data
      // Position at target door
      const newRoom = useTesterStore.getState().currentRoom
      if (newRoom && targetDoor) {
        const door = newRoom.doors.find((d) => d.id === targetDoor)
        if (door) {
          game.charX = door.col
          game.charY = door.row
          game.lastDoorTile = `${door.col},${door.row}`
        }
      }
    }

    const applyZoom = (z: number) => {
      if (!app || !worldContainer) return
      worldContainer.scale.set(z)
      const w = room.width * TILE_SIZE * z
      const h = room.height * TILE_SIZE * z
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

function canMoveTo(room: CompiledRoom, x: number, y: number): boolean {
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
    if (col < 0 || col >= room.width || row < 0 || row >= room.height) {
      return false
    }
    if (!room.walkability[row * room.width + col]) {
      return false
    }
  }
  return true
}

function buildPlacementSprites(
  p: CompiledPlacement,
  container: Container,
  objectSprites: { sprite: Sprite; anchorY: number }[] | null,
) {
  if (p.region) {
    const tex = regionToTexture(p.region)
    if (tex) {
      const sprite = new Sprite(tex)
      sprite.x = p.gridX * TILE_SIZE
      sprite.y = p.gridY * TILE_SIZE
      sprite.width = p.region.w * (TILE_SIZE / 16) // scale from source to display
      sprite.height = p.region.h * (TILE_SIZE / 16)
      // Actually: region w/h are in source pixels, we need to figure out tile coverage
      // The region covers (w/16) x (h/16) tiles at 16px source tile size
      // But we don't know the source tile size. Use the region dimensions directly.
      // The compiled region should map to gridX,gridY placement.
      // For floor: 1 tile = TILE_SIZE rendered. Source region might be 16x16 for a tile.
      // Let's just set width/height based on how many tiles the region covers.
      // Since the region is from a compiled pack, w/h are source pixels.
      // We'll scale to fill the tile grid appropriately.
      sprite.width = (p.region.w / 16) * TILE_SIZE
      sprite.height = (p.region.h / 16) * TILE_SIZE
      container.addChild(sprite)

      if (objectSprites) {
        const heightTiles = p.region.h / 16
        objectSprites.push({
          sprite,
          anchorY: p.gridY + heightTiles + (p.zBias ?? 0),
        })
      }
    }
  }

  if (p.parts) {
    for (const part of p.parts) {
      const tex = regionToTexture(part.region)
      if (tex) {
        const sprite = new Sprite(tex)
        sprite.x = p.gridX * TILE_SIZE + part.offsetX * (TILE_SIZE / 16)
        sprite.y = p.gridY * TILE_SIZE + part.offsetY * (TILE_SIZE / 16)
        sprite.width = (part.region.w / 16) * TILE_SIZE
        sprite.height = (part.region.h / 16) * TILE_SIZE
        container.addChild(sprite)

        if (objectSprites) {
          const heightTiles = part.region.h / 16
          const tileOffsetY = part.offsetY / 16
          objectSprites.push({
            sprite,
            anchorY:
              p.gridY +
              tileOffsetY +
              heightTiles +
              (part.zBias ?? 0) +
              (p.zBias ?? 0),
          })
        }
      }
    }
  }
}

function buildOverlays(
  room: CompiledRoom,
  walkOverlay: Graphics,
  gridOverlay: Graphics,
  doorOverlay: Graphics,
  showWalkability?: boolean,
  showGrid?: boolean,
) {
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
    for (let row = 0; row < room.height; row++) {
      for (let col = 0; col < room.width; col++) {
        const walkable = room.walkability[row * room.width + col]
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
    for (let row = 0; row <= room.height; row++) {
      gridOverlay.moveTo(0, row * TILE_SIZE)
      gridOverlay.lineTo(room.width * TILE_SIZE, row * TILE_SIZE)
      gridOverlay.stroke()
    }
    for (let col = 0; col <= room.width; col++) {
      gridOverlay.moveTo(col * TILE_SIZE, 0)
      gridOverlay.lineTo(col * TILE_SIZE, room.height * TILE_SIZE)
      gridOverlay.stroke()
    }
  }

  // Door overlay (always visible)
  doorOverlay.clear()
  for (const door of room.doors) {
    doorOverlay.rect(
      door.col * TILE_SIZE,
      door.row * TILE_SIZE,
      TILE_SIZE,
      TILE_SIZE,
    )
    doorOverlay.fill({ color: 0x9370db, alpha: 0.35 })
  }
}
