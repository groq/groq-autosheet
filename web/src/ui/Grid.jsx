"use client"
import React, { useRef, useEffect, useState } from 'react'

export function Grid({ rows, cols, selection, setSelection, getCellDisplay, getCellRaw, onEdit }) {
  const tableRef = useRef(null)
  const [editing, setEditing] = useState(null)
  const [editValue, setEditValue] = useState('')
  const hasCommittedRef = useRef(false)
  const isSelectingRef = useRef(false)
  const dragStartRef = useRef(null)
  const [selectionRect, setSelectionRect] = useState(null)

  const DEFAULT_COL_WIDTH = 100
  const DEFAULT_ROW_HEIGHT = 22
  const ROW_HEADER_WIDTH = 40

  const [colWidths, setColWidths] = useState(() => Array.from({ length: cols }, () => DEFAULT_COL_WIDTH))
  const [rowHeights, setRowHeights] = useState(() => Array.from({ length: rows }, () => DEFAULT_ROW_HEIGHT))

  useEffect(() => {
    setColWidths((prev) => {
      if (prev.length === cols) return prev
      if (prev.length < cols) return [...prev, ...Array.from({ length: cols - prev.length }, () => DEFAULT_COL_WIDTH)]
      return prev.slice(0, cols)
    })
  }, [cols])

  useEffect(() => {
    setRowHeights((prev) => {
      if (prev.length === rows) return prev
      if (prev.length < rows) return [...prev, ...Array.from({ length: rows - prev.length }, () => DEFAULT_ROW_HEIGHT)]
      return prev.slice(0, rows)
    })
  }, [rows])

  const startEditing = (row, col, initialValue) => {
    hasCommittedRef.current = false
    setEditing({ row, col })
    setEditValue(initialValue ?? '')
  }

  const commitEditing = (row, col, value, move) => {
    if (hasCommittedRef.current) return
    hasCommittedRef.current = true
    onEdit(row, col, value)
    setEditing(null)
    if (move === 'down') {
      setSelection({ row: Math.min(rows, row + 1), col })
    } else if (move === 'up') {
      setSelection({ row: Math.max(1, row - 1), col })
    } else if (move === 'right') {
      setSelection({ row, col: Math.min(cols, col + 1) })
    } else if (move === 'left') {
      setSelection({ row, col: Math.max(1, col - 1) })
    }
    // Ensure grid regains focus so arrow keys work
    setTimeout(() => {
      if (tableRef.current) tableRef.current.focus()
    }, 0)
  }

  const cancelEditing = () => {
    if (hasCommittedRef.current) return
    hasCommittedRef.current = true
    setEditing(null)
    setTimeout(() => {
      if (tableRef.current) tableRef.current.focus()
    }, 0)
  }

  useEffect(() => {
    const el = tableRef.current
    if (!el) return
    const handleKey = (e) => {
      // Ignore grid navigation when typing inside an input
      if (e.target && e.target.tagName === 'INPUT') return
      let { row, col, focus } = selection
      const isMeta = e.metaKey || (e.ctrlKey && !e.shiftKey && !e.altKey)
      if (e.key === 'Enter') {
        e.preventDefault()
        const raw = getCellRaw ? getCellRaw(row, col) : ''
        startEditing(row, col, raw ?? '')
        return
      }
      if (e.key === '=') {
        e.preventDefault()
        startEditing(row, col, '=')
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) {
          setSelection({ row, col: Math.max(1, col - 1) })
        } else {
          setSelection({ row, col: Math.min(cols, col + 1) })
        }
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        const raw = getCellRaw ? getCellRaw(row, col) : ''
        startEditing(row, col, raw ?? '')
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        // Clear all cells in selection range if present; otherwise only the anchor cell
        const hasRange = focus && (focus.row !== row || focus.col !== col)
        if (hasRange) {
          const top = Math.max(1, Math.min(row, focus.row))
          const left = Math.max(1, Math.min(col, focus.col))
          const bottom = Math.min(rows, Math.max(row, focus.row))
          const right = Math.min(cols, Math.max(col, focus.col))
          for (let r = top; r <= bottom; r++) {
            for (let c = left; c <= right; c++) {
              onEdit(r, c, null)
            }
          }
        } else {
          onEdit(row, col, null)
        }
        return
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const ch = e.key
        if (/^[a-z0-9]$/i.test(ch)) {
          e.preventDefault()
          startEditing(row, col, ch)
          return
        }
      }
      const hasRange = focus && (focus.row !== row || focus.col !== col)
      const move = (dr, dc) => {
        const nextRow = Math.max(1, Math.min(rows, row + dr))
        const nextCol = Math.max(1, Math.min(cols, col + dc))
        setSelection({ row: nextRow, col: nextCol })
      }
      const isNonEmpty = (r, c) => {
        if (!getCellRaw) return false
        const v = getCellRaw(r, c)
        return v != null && String(v) !== ''
      }
      const jumpHorizontal = (dir) => {
        if (dir > 0) {
          const next = col + 1
          if (next <= cols && isNonEmpty(row, next)) {
            // Move to the end of the contiguous non-empty block to the right
            let c = next
            while (c + 1 <= cols && isNonEmpty(row, c + 1)) c++
            setSelection({ row, col: c })
            return
          }
          // Otherwise, move to the next non-empty cell; if none, to the last column
          let c = next
          while (c <= cols && !isNonEmpty(row, c)) c++
          setSelection({ row, col: c <= cols ? c : cols })
        } else {
          const prev = col - 1
          if (prev >= 1 && isNonEmpty(row, prev)) {
            // Move to the start of the contiguous non-empty block to the left
            let c = prev
            while (c - 1 >= 1 && isNonEmpty(row, c - 1)) c--
            setSelection({ row, col: c })
            return
          }
          // Otherwise, move to the previous non-empty cell; if none, to the first column
          let c = prev
          while (c >= 1 && !isNonEmpty(row, c)) c--
          setSelection({ row, col: c >= 1 ? c : 1 })
        }
      }
      const jumpVertical = (dir) => {
        if (dir > 0) {
          const next = row + 1
          if (next <= rows && isNonEmpty(next, col)) {
            // Move to the end of the contiguous non-empty block downward
            let r = next
            while (r + 1 <= rows && isNonEmpty(r + 1, col)) r++
            setSelection({ row: r, col })
            return
          }
          // Otherwise, move to the next non-empty cell; if none, to the last row
          let r = next
          while (r <= rows && !isNonEmpty(r, col)) r++
          setSelection({ row: r <= rows ? r : rows, col })
        } else {
          const prev = row - 1
          if (prev >= 1 && isNonEmpty(prev, col)) {
            // Move to the start of the contiguous non-empty block upward
            let r = prev
            while (r - 1 >= 1 && isNonEmpty(r - 1, col)) r--
            setSelection({ row: r, col })
            return
          }
          // Otherwise, move to the previous non-empty cell; if none, to the first row
          let r = prev
          while (r >= 1 && !isNonEmpty(r, col)) r--
          setSelection({ row: r >= 1 ? r : 1, col })
        }
      }
      const expand = (dr, dc) => {
        const base = { row, col }
        const cur = focus && (focus.row || focus.col) ? focus : base
        const nextFocus = {
          row: Math.max(1, Math.min(rows, (cur.row ?? base.row) + dr)),
          col: Math.max(1, Math.min(cols, (cur.col ?? base.col) + dc)),
        }
        setSelection({ row, col, focus: nextFocus })
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (isMeta) jumpVertical(-1)
        else if (e.shiftKey) expand(-1, 0)
        else if (hasRange) move(-1, 0)
        else move(-1, 0)
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (isMeta) jumpVertical(1)
        else if (e.shiftKey) expand(1, 0)
        else if (hasRange) move(1, 0)
        else move(1, 0)
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (isMeta) jumpHorizontal(-1)
        else if (e.shiftKey) expand(0, -1)
        else if (hasRange) move(0, -1)
        else move(0, -1)
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (isMeta) jumpHorizontal(1)
        else if (e.shiftKey) expand(0, 1)
        else if (hasRange) move(0, 1)
        else move(0, 1)
      }
    }
    el.addEventListener('keydown', handleKey)
    return () => el.removeEventListener('keydown', handleKey)
  }, [selection, setSelection, rows, cols, getCellRaw, onEdit])

  // Keep active cell in view when selection changes
  useEffect(() => {
    const gridEl = tableRef.current
    if (!gridEl) return
    const { row, col } = selection || {}
    if (!row || !col) return
    const cell = gridEl.querySelector(`td[data-r="${row}"][data-c="${col}"]`)
    if (!cell) return

    const gridRect = gridEl.getBoundingClientRect()
    const cellRect = cell.getBoundingClientRect()

    // Compute cell coordinates relative to the scrollable content space
    const cellTop = cellRect.top - gridRect.top + gridEl.scrollTop
    const cellBottom = cellRect.bottom - gridRect.top + gridEl.scrollTop
    const cellLeft = cellRect.left - gridRect.left + gridEl.scrollLeft
    const cellRight = cellRect.right - gridRect.left + gridEl.scrollLeft

    // Measure sticky header sizes
    const thead = gridEl.querySelector('thead')
    const headerHeight = thead ? thead.getBoundingClientRect().height : 0
    const rowHeaderWidth = ROW_HEADER_WIDTH

    // Visible bounds for body cells considering sticky regions
    const visibleTop = gridEl.scrollTop + headerHeight
    const visibleLeft = gridEl.scrollLeft + rowHeaderWidth
    const visibleBottom = gridEl.scrollTop + gridEl.clientHeight
    const visibleRight = gridEl.scrollLeft + gridEl.clientWidth

    let nextScrollTop = gridEl.scrollTop
    let nextScrollLeft = gridEl.scrollLeft

    // Vertical adjustment
    if (cellTop < visibleTop) {
      nextScrollTop = Math.max(0, cellTop - headerHeight)
    } else if (cellBottom > visibleBottom) {
      nextScrollTop = Math.max(0, cellBottom - gridEl.clientHeight)
    }

    // Horizontal adjustment
    if (cellLeft < visibleLeft) {
      nextScrollLeft = Math.max(0, cellLeft - rowHeaderWidth)
    } else if (cellRight > visibleRight) {
      nextScrollLeft = Math.max(0, cellRight - gridEl.clientWidth)
    }

    if (nextScrollTop !== gridEl.scrollTop || nextScrollLeft !== gridEl.scrollLeft) {
      gridEl.scrollTo({ top: nextScrollTop, left: nextScrollLeft })
    }
  }, [selection, rowHeights, colWidths])

  // End selection drag on global mouseup
  useEffect(() => {
    const onUp = () => {
      isSelectingRef.current = false
      dragStartRef.current = null
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  // Compute selection rectangle for outer border
  useEffect(() => {
    const gridEl = tableRef.current
    if (!gridEl) return
    const focus = selection && selection.focus
    const hasRange = !!(focus && (focus.row !== selection.row || focus.col !== selection.col))
    const compute = () => {
      if (!hasRange) { setSelectionRect(null); return }
      const topR = Math.min(selection.row, focus.row)
      const leftC = Math.min(selection.col, focus.col)
      const bottomR = Math.max(selection.row, focus.row)
      const rightC = Math.max(selection.col, focus.col)
      const tl = gridEl.querySelector(`td[data-r="${topR}"][data-c="${leftC}"]`)
      const br = gridEl.querySelector(`td[data-r="${bottomR}"][data-c="${rightC}"]`)
      if (!tl || !br) { setSelectionRect(null); return }
      const gridRect = gridEl.getBoundingClientRect()
      const tlRect = tl.getBoundingClientRect()
      const brRect = br.getBoundingClientRect()
      const top = tlRect.top - gridRect.top + gridEl.scrollTop
      const left = tlRect.left - gridRect.left + gridEl.scrollLeft
      const width = brRect.right - tlRect.left
      const height = brRect.bottom - tlRect.top
      // Align the selection outline precisely with the gridlines by
      // using the exact bounding rect extents of the selected cells
      // without any outward expansion.
      setSelectionRect({ top, left, width, height })
    }
    compute()
    const onScroll = () => compute()
    const onResize = () => compute()
    gridEl.addEventListener('scroll', onScroll)
    window.addEventListener('resize', onResize)
    return () => {
      gridEl.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [selection, rowHeights, colWidths])

  const beginColumnResize = (colIndex, startClientX) => {
    const startWidth = colWidths[colIndex]
    const onMove = (e) => {
      const dx = e.clientX - startClientX
      const next = Math.max(40, startWidth + dx)
      setColWidths((w) => w.map((val, i) => (i === colIndex ? next : val)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const beginRowResize = (rowIndex, startClientY) => {
    const startHeight = rowHeights[rowIndex]
    const onMove = (e) => {
      const dy = e.clientY - startClientY
      const next = Math.max(18, startHeight + dy)
      setRowHeights((h) => h.map((val, i) => (i === rowIndex ? next : val)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const autoFitColumn = (colIndex) => {
    const table = tableRef.current
    if (!table) return
    let maxWidth = 40
    const headerRow = table.querySelector('thead tr')
    if (headerRow && headerRow.children[colIndex + 1]) {
      const th = headerRow.children[colIndex + 1]
      maxWidth = Math.max(maxWidth, measureElementWidth(th, true))
    }
    const body = table.querySelector('tbody')
    if (body) {
      for (let r = 0; r < rows; r++) {
        const tr = body.children[r]
        if (!tr) continue
        const td = tr.children[colIndex + 1]
        if (!td) continue
        maxWidth = Math.max(maxWidth, measureElementWidth(td, false))
      }
    }
    setColWidths((w) => w.map((val, i) => (i === colIndex ? maxWidth : val)))
  }

  const autoFitRow = (rowIndex) => {
    const table = tableRef.current
    if (!table) return
    let maxHeight = 18
    const body = table.querySelector('tbody')
    const tr = body && body.children[rowIndex]
    if (!tr) return
    for (let c = 0; c < cols; c++) {
      const td = tr.children[c + 1]
      if (!td) continue
      maxHeight = Math.max(maxHeight, measureElementHeight(td))
    }
    setRowHeights((h) => h.map((val, i) => (i === rowIndex ? maxHeight : val)))
  }

  const measureElementWidth = (cellOrHeaderEl, isHeader) => {
    if (isHeader) {
      const label = cellOrHeaderEl.querySelector('.col-header-label') || cellOrHeaderEl
      const width = getIntrinsicScrollWidth(label)
      // Add cell horizontal padding (8 left + 8 right)
      return Math.ceil(width + 16)
    }
    const input = cellOrHeaderEl.querySelector('input')
    if (input) {
      const text = input.value ?? ''
      const width = measureTextUsingCanvas(text, input)
      return Math.ceil(width + 16)
    }
    const textSpan = cellOrHeaderEl.querySelector('.cell-text')
    if (textSpan) {
      const width = getIntrinsicScrollWidth(textSpan)
      return Math.ceil(width + 16)
    }
    const content = cellOrHeaderEl
    const width = getIntrinsicScrollWidth(content)
    return Math.ceil(width + 16)
  }

  const getIntrinsicScrollWidth = (el) => {
    // Use scrollWidth where possible; it reflects the unwrapped content width for inline-block/nowrap
    return el.scrollWidth || el.clientWidth || el.offsetWidth || 0
  }

  const measureTextUsingCanvas = (text, refEl) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const cs = window.getComputedStyle(refEl)
    const font = cs.font || `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`
    ctx.font = font
    const metrics = ctx.measureText(text)
    return metrics.width
  }

  const measureElementHeight = (cellEl) => {
    const input = cellEl.querySelector('input')
    if (input) return Math.ceil(input.scrollHeight + 8)
    const content = cellEl.querySelector('.cell-display') || cellEl
    return Math.ceil(content.scrollHeight + 8)
  }

  return (
    <div className="grid" tabIndex={0} ref={tableRef}>
      <table>
        <colgroup>
          <col style={{ width: ROW_HEADER_WIDTH }} />
          {colWidths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="corner-cell" style={{ width: ROW_HEADER_WIDTH }}></th>
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className="col-header">
                <span className="col-header-label">{colLabel(c + 1)}</span>
                <div
                  className="col-resizer"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    beginColumnResize(c, e.clientX)
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    autoFitColumn(c)
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} style={{ height: rowHeights[r] }}>
              <th className="row-header" style={{ width: ROW_HEADER_WIDTH }}>
                {r + 1}
                <div
                  className="row-resizer"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    beginRowResize(r, e.clientY)
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    autoFitRow(r)
                  }}
                />
              </th>
              {Array.from({ length: cols }, (_, c) => {
                const rr = r + 1
                const cc = c + 1
                const isAnchor = selection.row === rr && selection.col === cc
                const hasFocus = !!selection.focus
                const top = hasFocus ? Math.min(selection.row, selection.focus.row) : selection.row
                const left = hasFocus ? Math.min(selection.col, selection.focus.col) : selection.col
                const bottom = hasFocus ? Math.max(selection.row, selection.focus.row) : selection.row
                const right = hasFocus ? Math.max(selection.col, selection.focus.col) : selection.col
                const inRange = hasFocus && rr >= top && rr <= bottom && cc >= left && cc <= right
                const className = hasFocus
                  ? (inRange ? (isAnchor ? 'sel-range sel-anchor' : 'sel-range') : '')
                  : (isAnchor ? 'sel' : '')
                const isEditing = editing && editing.row === rr && editing.col === cc
                return (
                  <td
                    key={c}
                    className={className}
                    data-r={rr}
                    data-c={cc}
                    onMouseDown={(e) => {
                      // If clicking inside the active input, allow caret placement and do not exit editing
                      if (isEditing && e.target && e.target.tagName === 'INPUT') {
                        return
                      }
                      e.preventDefault()
                      if (e.shiftKey) {
                        // Expand from existing anchor to this cell
                        setSelection({ row: selection.row, col: selection.col, focus: { row: rr, col: cc } })
                      } else {
                        setSelection({ row: rr, col: cc })
                        isSelectingRef.current = true
                        dragStartRef.current = { row: rr, col: cc }
                      }
                      if (tableRef.current) tableRef.current.focus()
                    }}
                    onMouseEnter={() => {
                      if (isSelectingRef.current && dragStartRef.current) {
                        const start = dragStartRef.current
                        setSelection({ row: start.row, col: start.col, focus: { row: rr, col: cc } })
                      }
                    }}
                    onDoubleClick={(e) => {
                      setSelection({ row: rr, col: cc })
                      const raw = getCellRaw ? getCellRaw(rr, cc) : ''
                      startEditing(rr, cc, raw ?? '')
                    }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onMouseDown={(e) => { e.stopPropagation() }}
                        onDoubleClick={(e) => { e.stopPropagation() }}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitEditing(rr, cc, editValue, e.shiftKey ? 'up' : 'down')
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelEditing()
                          } else if (e.key === 'Tab') {
                            e.preventDefault()
                            commitEditing(rr, cc, editValue, e.shiftKey ? 'left' : 'right')
                          }
                        }}
                        onBlur={() => commitEditing(rr, cc, editValue)}
                        style={{ width: '100%', height: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', font: 'inherit', padding: '0 1px', margin: 0 }}
                      />
                    ) : (
                      <div className="cell-display"><span className="cell-text">{getCellDisplay(rr, cc)}</span></div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {selectionRect && (
        <div
          className="selection-outline"
          style={{ top: selectionRect.top, left: selectionRect.left, width: selectionRect.width, height: selectionRect.height }}
        />
      )}
    </div>
  )
}

function colLabel(n) {
  let c = n
  let s = ''
  while (c > 0) {
    const rem = (c - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    c = Math.floor((c - 1) / 26)
  }
  return s
}


