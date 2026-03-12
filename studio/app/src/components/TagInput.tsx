/**
 * TagInput — multi-value tag editor with autocomplete.
 *
 * Displays tags as removable pills. The text input triggers autocomplete
 * via the `useTags` hook (debounced server-side prefix search).
 * Enter or comma commits the current input as a new tag.
 * Backspace on empty input removes the last tag.
 *
 * Props:
 *   tags      — current tag list
 *   onChange  — called with updated tag list
 *   placeholder — input placeholder
 */

import { useState, useRef, useCallback, useEffect } from 'preact/hooks'
import { useTags } from '../api/search'

export interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  /** Additional CSS class */
  class?: string
}

export function TagInput(props: TagInputProps) {
  const { tags, onChange, placeholder = 'Add tag...' } = props

  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Autocomplete from server
  const { data: suggestions = [] } = useTags(input, 10)

  // Filter out already-applied tags
  const filtered = suggestions.filter((s) => !tags.includes(s))

  // ─── Commit a tag ─────────────────────────────────────────────

  const commitTag = useCallback(
    (value: string) => {
      const trimmed = value.trim().toLowerCase()
      if (!trimmed) return
      if (tags.includes(trimmed)) return
      onChange([...tags, trimmed])
      setInput('')
      setFocusIdx(-1)
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
    // Comma acts as a separator
    if (val.includes(',')) {
      const parts = val.split(',')
      for (const part of parts) {
        const trimmed = part.trim()
        if (trimmed) commitTag(trimmed)
      }
      setInput('')
      return
    }
    setInput(val)
    setFocusIdx(-1)
    setShowSuggestions(val.length > 0)
  }, [commitTag])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (focusIdx >= 0 && focusIdx < filtered.length) {
          commitTag(filtered[focusIdx])
        } else {
          commitTag(input)
        }
      } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
        onChange(tags.slice(0, -1))
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        setShowSuggestions(false)
        setFocusIdx(-1)
      }
    },
    [input, tags, filtered, focusIdx, commitTag, onChange],
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

  // ─── Focus the input when clicking the container ──────────────

  const handleContainerClick = useCallback(() => {
    inputRef.current?.focus()
  }, [])

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      class={`tag-input ${props.class ?? ''}`}
      onClick={handleContainerClick}
    >
      <div class="tag-input-tags">
        {tags.map((tag) => (
          <span key={tag} class="tag-input-pill">
            {tag}
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
        ))}
        <input
          ref={inputRef}
          type="text"
          class="tag-input-field"
          placeholder={tags.length === 0 ? placeholder : ''}
          value={input}
          onInput={handleInput}
          onKeyDown={handleKeyDown as any}
          onFocus={() => input.length > 0 && setShowSuggestions(true)}
        />
      </div>

      {showSuggestions && filtered.length > 0 && (
        <div class="tag-input-suggestions">
          {filtered.map((s, i) => (
            <div
              key={s}
              class={`tag-input-suggestion${i === focusIdx ? ' focused' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault() // prevent blur
                commitTag(s)
                setShowSuggestions(false)
              }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
