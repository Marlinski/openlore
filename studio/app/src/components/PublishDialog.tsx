/**
 * PublishDialog — modal for publishing the built .offpack to the game server.
 * User enters a pack name and optional tags, then confirms.
 */

import { useState, useCallback, useRef, useEffect } from 'preact/hooks'
import { usePackStore } from '../store/pack'

export function PublishDialog() {
  const open = usePackStore((s) => s.publishDialogOpen)
  const status = usePackStore((s) => s.publishStatus)
  const error = usePackStore((s) => s.publishError)
  const result = usePackStore((s) => s.publishResult)
  const close = usePackStore((s) => s.closePublishDialog)
  const publish = usePackStore((s) => s.publish)

  const [name, setName] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const nameRef = useRef<HTMLInputElement>(null)

  // Focus name input when dialog opens
  useEffect(() => {
    if (open) {
      setTimeout(() => nameRef.current?.focus(), 50)
    } else {
      // Reset form when closed
      setName('')
      setTagInput('')
      setTags([])
    }
  }, [open])

  const addTag = useCallback(() => {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }, [tagInput, tags])

  const removeTag = useCallback((tag: string) => {
    setTags(tags.filter((t) => t !== tag))
  }, [tags])

  const handleTagKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      addTag()
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      setTags(tags.slice(0, -1))
    }
  }, [tagInput, tags, addTag])

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return
    publish(name.trim(), tags)
  }, [name, tags, publish])

  const handleNameKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit])

  if (!open) return null

  const isPublishing = status === 'publishing'
  const isDone = status === 'done'
  const isError = status === 'error'

  return (
    <div class="publish-backdrop" onClick={close}>
      <div class="publish-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="publish-dialog-header">
          <span class="publish-dialog-title">
            {isDone ? 'Published' : 'Publish to Game Server'}
          </span>
          <button class="pack-panel-close" onClick={close} title="Close">
            &times;
          </button>
        </div>

        <div class="publish-dialog-body">
          {isDone && result ? (
            <div class="publish-success">
              <div class="publish-success-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 12l3 3 5-5" />
                </svg>
              </div>
              <div class="publish-success-text">
                Pack <strong>{result.name}</strong> published as <code>{result.packId}</code>
              </div>
              {result.tags.length > 0 && (
                <div class="publish-success-tags">
                  {result.tags.map((t) => (
                    <span key={t} class="publish-tag-pill">{t}</span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Name field */}
              <label class="publish-label">Pack Name</label>
              <input
                ref={nameRef}
                type="text"
                class="publish-input"
                placeholder="my-office-pack"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
                onKeyDown={handleNameKeyDown as any}
                disabled={isPublishing}
              />
              <div class="publish-hint">
                Used as the pack identifier on the game server
              </div>

              {/* Tags field */}
              <label class="publish-label publish-label--tags">Tags</label>
              {tags.length > 0 && (
                <div class="publish-tags">
                  {tags.map((t) => (
                    <span key={t} class="publish-tag-pill">
                      {t}
                      <span
                        class="publish-tag-remove"
                        onClick={() => removeTag(t)}
                      >
                        &times;
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <input
                type="text"
                class="publish-input"
                placeholder="Add tag and press Enter..."
                value={tagInput}
                onInput={(e) => setTagInput((e.target as HTMLInputElement).value)}
                onKeyDown={handleTagKeyDown as any}
                disabled={isPublishing}
              />

              {/* Error */}
              {isError && error && (
                <div class="publish-error">{error}</div>
              )}
            </>
          )}
        </div>

        <div class="publish-dialog-footer">
          {isDone ? (
            <button class="publish-btn" onClick={close}>
              Close
            </button>
          ) : (
            <>
              <button
                class="publish-btn publish-btn--cancel"
                onClick={close}
                disabled={isPublishing}
              >
                Cancel
              </button>
              <button
                class="publish-btn publish-btn--confirm"
                onClick={handleSubmit}
                disabled={isPublishing || !name.trim()}
              >
                {isPublishing ? 'Publishing...' : 'Publish'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
