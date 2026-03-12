/**
 * SharedTags — group tag input + shared tag pills.
 *
 * Tags entered here are automatically added to every cut/resource
 * created for the current tileset. Shows as removable pills.
 *
 * Uses the TagInput component for autocomplete.
 */

import type { TilesetMeta } from '../../api/tilesets'
import { TagInput } from '../TagInput'
import { useCutterStore } from '../../store/cutter'

export interface SharedTagsProps {
  tileset: TilesetMeta | null
}

export function SharedTags({ tileset }: SharedTagsProps) {
  const sharedTags = useCutterStore((s) => s.sharedTags)
  const setSharedTags = useCutterStore((s) => s.setSharedTags)

  if (!tileset) return null

  return (
    <div class="cutter-shared-tags">
      <div class="cutter-section-header">Shared Tags</div>
      <TagInput
        tags={sharedTags}
        onChange={setSharedTags}
        placeholder="Group tag (e.g. character name)..."
      />
    </div>
  )
}
