/** @jsxRuntime automatic */
/** Searchable, keyboard-operated choice list using the native DSH menu tokens. */
import {useEffect, useLayoutEffect, useId, useRef, useState} from 'react'
import {Icon} from './controls.tsx'

export function Select({id, value, options, onChange, placeholder, disabled = false}: {
  id?: string; value: string; options: readonly {value: string; label: string; disabled?: boolean}[]
  onChange(value: string): void; placeholder: string; disabled?: boolean
}) {
  const generated = useId(), listId = `${id ?? generated}-options`, root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null), [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0)
  const [menu, setMenu] = useState({above: false, height: 280})
  const choices = options.filter(option => !query || option.label.toLowerCase().includes(query.toLowerCase()))
  const selected = options.find(option => option.value === value)?.label ?? value
  const close = () => {setOpen(false); setQuery('')}
  const choose = (index: number) => {const option = choices[index]; if (option && !option.disabled) {onChange(option.value); close(); input.current?.focus()}}
  useLayoutEffect(() => {
    if (!open || !root.current) return
    const place = () => {
      const anchor = root.current!.getBoundingClientRect()
      let top = 8, bottom = window.innerHeight - 8
      for (let parent = root.current!.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();top = Math.max(top, bounds.top + 8);bottom = Math.min(bottom, bounds.bottom - 8)
        }
      }
      const below = bottom - anchor.bottom - 6, above = anchor.top - top - 6
      const flip = below < 180 && above > below
      setMenu({above: flip, height: Math.max(32, Math.min(280, flip ? above : below))})
    }
    place();window.addEventListener('resize', place);document.addEventListener('scroll', place, true)
    return () => {window.removeEventListener('resize', place);document.removeEventListener('scroll', place, true)}
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {if (!root.current?.contains(event.target as Node)) close()}
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  useEffect(() => {if (open) root.current?.querySelector(`[id="${listId}-${active}"]`)?.scrollIntoView({block: 'nearest'})}, [active, open, listId])
  return <div className="dt-choice" ref={root} onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget)) close()}}>
    <div className="dt-choice-trigger" data-open={open || undefined} onClick={() => {if (!disabled) {input.current?.focus();setOpen(true);setActive(Math.max(0, choices.findIndex(option => option.value === value)))}}}>
      <input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && choices[active] ? `${listId}-${active}` : undefined} disabled={disabled}
        autoComplete="off" spellCheck={false} value={open ? query : selected} placeholder={open ? placeholder : selected || placeholder}
        onChange={event => {setQuery(event.target.value); setActive(0); setOpen(true)}}
        onKeyDown={event => {
          if (event.key === 'Escape') {event.stopPropagation(); event.preventDefault(); close(); return}
          if (event.key === 'Tab') {close(); return}
          if (event.key === 'Enter') {event.preventDefault(); if (open) choose(active); else setOpen(true); return}
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setOpen(true)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setActive(previous => {
              for (let step = 1; step <= choices.length; step++) {
                const next = (previous + direction * step + choices.length) % choices.length
                if (!choices[next]?.disabled) return next
              }
              return previous
            })
          }
        }} />
      <Icon name="chevron-down" size={14}/>
    </div>
    {open && <div className="dt-choice-menu" role="listbox" id={listId} style={{top: menu.above ? 'auto' : 'calc(100% + 6px)', bottom: menu.above ? 'calc(100% + 6px)' : 'auto', maxHeight: menu.height}}>
      {choices.map((option, index) => <div role="option" key={option.value} id={`${listId}-${index}`} aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined} className="dt-choice-option" data-active={index === active || undefined}
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value && <Icon name="decision" size={14}/>}
      </div>)}
      {!choices.length && <div className="dt-choice-empty">—</div>}
    </div>}
  </div>
}
