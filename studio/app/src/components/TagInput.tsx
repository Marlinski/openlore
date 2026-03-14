/**
 * TagInput — single-field tag editor with full autocomplete.
 *
 * Tags are "key:value" strings (e.g. "entity:character", "action:idle").
 * The user types the full string including the colon themselves.
 * If a tag has no colon, it gets a default "extra:" prefix on commit.
 *
 * Autocomplete suggests full "key:value" strings from the API,
 * so frequently-used tags are easy to reuse.
 *
 * Pills are rendered *above* the input in a separate row when `showPills`
 * is true (default). Set `showPills={false}` to render them externally.
 *
 * Props:
 *   tags        — current tag list (e.g. ["entity:character", "name:adam"])
 *   onChange    — called with updated tag list
 *   placeholder — placeholder text
 *   showPills   — whether to render pills inline (default true)
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks'
import { useTags } from '../api/search'

/** Parse a "key:value" tag string into parts. Exported for external pill rendering. */
export function parseTagString(tag: string): { key: string; value: string } {
  const idx = tag.indexOf(':')
  if (idx > 0) return { key: tag.slice(0, idx), value: tag.slice(idx + 1) }
  return { key: '', value: tag }
}

/** Default namespace for tags entered without a colon. */
const DEFAULT_KEY = 'extra'

export interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  /** Additional CSS class */
  class?: string
  /** Whether to render tag pills inline (default true). Set false to render them externally. */
  showPills?: boolean
}

export function TagInput(props: TagInputProps) {
  const { tags, onChange, placeholder = 'tag...', showPills = true } = props

  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // ─── Autocomplete query ───────────────────────────────────────

  // Query with the raw input — the API matches against "key:value" strings
  const { data: rawSuggestions = [] } = useTags(input, 20)

  // Filter out already-used tags
  const suggestions = useMemo(() => {
    return rawSuggestions.filter((s) => !tags.includes(s))
  }, [rawSuggestions, tags])

  // ─── Commit a tag ─────────────────────────────────────────────

  const commitTag = useCallback(
    (raw: string) => {
      let tag = raw.trim().toLowerCase()
      if (!tag) return

      // If no colon, add default namespace
      if (!tag.includes(':')) {
        tag = `${DEFAULT_KEY}:${tag}`
      }
      // If colon at end (e.g. "entity:"), don't commit
      if (tag.endsWith(':')) return

      if (tags.includes(tag)) return
      onChange([...tags, tag])
      setInput('')
      setFocusIdx(-1)
      setShowSuggestions(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    [tags, onChange],
  )

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag))
    },
    [tags, onChange],
  )

  // ─── Input handlers ───────────────────────────────────────────

  const handleInput = useCallback((e: Event) => {
    const val = (e.target as HTMLInputElement).value
    setInput(val)
    setFocusIdx(-1)
    setShowSuggestions(val.length > 0)
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusIdx >= 0 && focusIdx < suggestions.length) {
          commitTag(suggestions[focusIdx])
        } else {
          commitTag(input)
        }
      } else if (e.key === 'Tab' && !e.shiftKey && input.trim()) {
        // Tab commits the tag
        e.preventDefault()
        if (focusIdx >= 0 && focusIdx < suggestions.length) {
          commitTag(suggestions[focusIdx])
        } else {
          commitTag(input)
        }
      } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
        onChange(tags.slice(0, -1))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, suggestions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        setShowSuggestions(false)
        setFocusIdx(-1)
      }
    },
    [input, tags, suggestions, focusIdx, commitTag, onChange],
  )

  // ─── Close suggestions on outside click ───────────────────────

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ─── Focus input when clicking the container ──────────────────

  const handleContainerClick = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      class={`tag-input-wrap ${props.class ?? ''}`}
    >
      {/* Tag pills — above the input, outside the bordered area */}
      {showPills && tags.length > 0 && (
        <div class="tag-input-pills">
          {tags.map((tag) => {
            const { key, value } = parseTagString(tag)
            return (
              <span key={tag} class="tag-input-pill">
                {key && <span class="tag-input-pill-key">{key}</span>}
                {key && <span class="tag-input-pill-sep">:</span>}
                <span class="tag-input-pill-value">{value}</span>
                <span
                  class="tag-input-pill-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTag(tag)
                  }}
                >
                  &times;
                </span>
              </span>
            )
          })}
        </div>
      )}

      {/* Bordered input area */}
      <div class="tag-input" onClick={handleContainerClick}>
        <input
          ref={inputRef}
          type="text"
          class="tag-input-field tag-input-field--single"
          placeholder={placeholder}
          value={input}
          onInput={handleInput}
          onKeyDown={handleKeyDown as any}
          onFocus={() => {
            if (input.length > 0) setShowSuggestions(true)
          }}
        />

        {showSuggestions && suggestions.length > 0 && (
          <div class="tag-input-suggestions">
            {suggestions.map((s, i) => {
              const { key, value } = parseTagString(s)
              return (
                <div
                  key={s}
                  class={`tag-input-suggestion${i === focusIdx ? ' focused' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commitTag(s)
                  }}
                >
                  {key ? (
                    <span>
                      <span class="tag-input-suggestion-key">{key}:</span>
                      {value}
                    </span>
                  ) : (
                    <span>{s}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
