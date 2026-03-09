/**
 * @offisims/shared — shared types and protocol definitions
 *
 * Re-exports everything from types.ts and protocol.ts for convenience.
 * Packages can also import from specific subpaths:
 *   import { TILE_SIZE } from "@offisims/shared/types"
 *   import { ClientMessage } from "@offisims/shared/protocol"
 */

export * from "./types.js";
export * from "./protocol.js";
