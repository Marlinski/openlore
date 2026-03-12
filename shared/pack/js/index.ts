/**
 * @offisims/pack — Pack format library
 *
 * Re-exports generated protobuf types and hand-written helpers.
 */

// Generated protobuf types — type-only re-exports (message types are type aliases)
export type {
  Pack,
  PackManifest,
  TilesetDefinition,
  TilesetRegion,
  CompositeObject,
  CompositePart,
  TexturePlacement,
  RoomDefinition,
  DoorDefinition,
  ResourceFrame,
  Resource,
  MaskCut,
  Mask,
} from "./pb/pack_pb.js";

// Generated protobuf enums & schemas (runtime values)
export {
  PlacementLayer,
  PackSchema,
  PackManifestSchema,
  TilesetDefinitionSchema,
  TilesetRegionSchema,
  CompositeObjectSchema,
  CompositePartSchema,
  TexturePlacementSchema,
  RoomDefinitionSchema,
  DoorDefinitionSchema,
  ResourceFrameSchema,
  ResourceSchema,
  MaskCutSchema,
  MaskSchema,
} from "./pb/pack_pb.js";

// Hand-written helpers
export { deriveCharacters } from "./pack.js";
export type { CharacterGroup } from "./pack.js";
