/**
 * SharedTags — group tag input + shared tag pills.
 *
 * Tags entered here are automatically added to every cut.
 * Shared tags are derived from the intersection of all cuts' tags.
 *
 * NOTE: This component is currently unused — the toolbar handles
 * shared tag display and editing. Kept for reference.
 */

import { useMemo } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import { TagInput } from '../TagInput'
import { useCutterStore, getSharedTags } from '../../store/cutter'

export interface SharedTagsProps {
  tileset: TilesetMeta | null
}

export function SharedTags({ tileset }: SharedTagsProps) {
  const cuts = useCutterStore((s) => s.cuts)
  const addSharedTag = useCutterStore((s) => s.addSharedTag)
  const removeSharedTag = useCutterStore((s) => s.removeSharedTag)
  const sharedTags = useMemo(() => getSharedTags(cuts), [cuts])

  if (!tileset) return null

  const handleChange = (newTags: string[]) => {
    for (const t of newTags) {
      if (!sharedTags.includes(t)) addSharedTag(t)
    }
    for (const t of sharedTags) {
      if (!newTags.includes(t)) removeSharedTag(t)
    }
  }

  return (
    <div class="cutter-shared-tags">
      <div class="cutter-section-header">Shared Tags</div>
      <TagInput
        tags={sharedTags}
        onChange={handleChange}
        placeholder="Group tag (e.g. character name)..."
      />
    </div>
  )
}
