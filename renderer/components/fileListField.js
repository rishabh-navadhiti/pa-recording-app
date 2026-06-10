// Reusable file-list field — replaces the 4 copy-pasted renderers
// (prechart attachments, create-template samples, update-template samples,
// update corrections file). Renders a list of file paths with remove buttons
// into a container; calls onChange after any removal so callers can re-derive
// enabled/disabled button state.
//
// The model (the array of paths) is owned by the caller; this component mutates
// it in place on remove (matching the original .splice behaviour) and re-renders.

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container  The element to render rows into.
 * @param {string[]}    opts.files      The path array (mutated in place on remove).
 * @param {Function}    [opts.onChange] Called after a removal.
 * @param {string}      [opts.emptyText='No files added yet']
 */
export function renderFileList({ container, files, onChange, emptyText = 'No files added yet' }) {
  if (!container) return
  container.innerHTML = ''

  if (!files || files.length === 0) {
    container.classList.add('create-template-files-empty')
    container.textContent = emptyText
    return
  }
  container.classList.remove('create-template-files-empty')

  files.forEach((fp, idx) => {
    const row = document.createElement('div')
    row.className = 'create-template-file-row'

    const name = document.createElement('span')
    name.className = 'create-template-file-name'
    name.textContent = fp.split(/[\\/]/).pop()
    name.title = fp

    const rm = document.createElement('button')
    rm.className = 'create-template-file-remove'
    rm.textContent = '✕'
    rm.title = 'Remove'
    rm.addEventListener('click', () => {
      files.splice(idx, 1)
      renderFileList({ container, files, onChange, emptyText })
      if (onChange) onChange()
    })

    row.appendChild(name)
    row.appendChild(rm)
    container.appendChild(row)
  })
}
