/**
 * Pack helpers — hand-written functions that complement the generated pb types.
 */

import type { Resource } from "./pb/pack_pb.js";

/**
 * A character group derived from resources sharing a common group tag.
 * A "character" is not a special type in the data model — it's a convention
 * where resources tagged with the same group name (e.g. "adam") and animation
 * tags (e.g. "idle", "walk", "up", "down") form a playable character.
 */
export interface CharacterGroup {
  /** The shared group tag (e.g. "adam", "amanda") */
  id: string;
  /** Human-readable name (title-cased group tag) */
  name: string;
  /** All resources belonging to this character */
  resources: Resource[];
}

/** Tags that describe animation state, not character identity */
const ANIMATION_TAGS = new Set([
  "idle", "walk", "sit", "sit_office",
  "up", "down", "left", "right",
  "preview",
]);

/** Tags that describe entity type, not character identity */
const SEMANTIC_TAGS = new Set([
  "entity:character", "entity:object", "entity:tile",
]);

/**
 * Derive character groups from a list of resources.
 * A character is any set of resources sharing a common non-animation,
 * non-semantic tag. Resources tagged "entity:character" are preferred,
 * but the grouping works on any tag convention.
 *
 * @param resources - All resources from a pack
 * @returns Character groups sorted by name
 */
export function deriveCharacters(resources: Resource[]): CharacterGroup[] {
  // Filter to character resources (those with entity:character tag)
  const characterResources = resources.filter(r =>
    r.tags.some(t => t === "entity:character")
  );

  // Group by the "name:" tag (e.g. "name:adam" → "adam")
  const groups = new Map<string, Resource[]>();

  for (const resource of characterResources) {
    // Look for a name tag first (e.g. "name:adam")
    const nameTag = resource.tags.find(t => t.startsWith("name:"));
    if (nameTag) {
      const groupId = nameTag.slice(5); // strip "name:" prefix
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId)!.push(resource);
      continue;
    }

    // Fallback: use first non-animation, non-semantic tag as group key
    const groupTag = resource.tags.find(t =>
      !ANIMATION_TAGS.has(t) && !SEMANTIC_TAGS.has(t) && !t.includes(":")
    );
    if (groupTag) {
      if (!groups.has(groupTag)) {
        groups.set(groupTag, []);
      }
      groups.get(groupTag)!.push(resource);
    }
  }

  return Array.from(groups.entries())
    .map(([id, resources]) => ({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      resources,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
