import { useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, CircleAlert, FileInput, FileJson, FileText, FolderPlus, LoaderCircle, Trash2, TriangleAlert, Upload } from 'lucide-react'
import { parseErd } from './parse'
import { renderDocx } from './docx'
import { buildDocument, OTHER_TITLE, readDescriptions, VIEWS_TITLE, type Descriptions } from './descriptions'
import { emptyDescriptions, generateDescriptions } from './generate'
import { validate, type WarningKind } from './validate'
import type { ParsedErd } from './model'
import { download, errorText, FILE_LIMIT, fileStem } from '../shared/files'
import './lld.css'

const WARNING_TITLES: Record<WarningKind, string> = {
  'missing-description': 'Missing descriptions', 'uncertain-description': 'Descriptions to check', 'unresolved-fk': 'Unresolved foreign keys',
  'loose-connector': 'Loose connectors', 'schema-prefix': 'Schema prefixes', typo: 'Possible typos', 'required-mismatch': 'Required/Optional inconsistencies',
}

export default function LldWorkspace() {
  const [erd, setErd] = useState<ParsedErd | null>(null)
  const [descriptions, setDescriptions] = useState<Descriptions | null>(null)
  const [autoDescribe, setAutoDescribe] = useState(true)
  const [includeViews, setIncludeViews] = useState(true)
  const [friendlyTypes, setFriendlyTypes] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const erdInput = useRef<HTMLInputElement>(null)
  const jsonInput = useRef<HTMLInputElement>(null)

  const built = useMemo(() => erd && descriptions ? buildDocument(erd, descriptions, { includeViews, friendlyTypes }) : null, [erd, descriptions, includeViews, friendlyTypes])
  const warnings = useMemo(() => erd && built ? validate(erd, built.missing, built.uncertain) : [], [erd, built])
  const flagged = useMemo(() => ({
    missing: new Set(built?.missing.map((entry) => `${entry.table}|${entry.column}`)),
    uncertain: new Set(built?.uncertain.map((entry) => `${entry.table}|${entry.column}`)),
  }), [built])
  const groupTitles = descriptions?.groups.map((group) => group.title) ?? []

  async function openErd(file: File | undefined) {
    if (!file) return
    setError(''); setNotice('')
    if (!/\.vsdx$/i.test(file.name)) { setError('Choose a Visio .vsdx ERD.'); return }
    if (file.size > FILE_LIMIT) { setError('The ERD exceeds the 20 MB limit.'); return }
    setBusy(true)
    try {
      const parsed = await parseErd(await file.arrayBuffer(), file.name)
      if (!parsed.tables.length) throw new Error('No ERD tables were found: tables must be Entity shapes with a name and a tab-separated column list.')
      setErd(parsed)
      setDescriptions(autoDescribe ? generateDescriptions(parsed) : emptyDescriptions(parsed))
      setNotice(`Read ${parsed.tables.length} tables and views from ${file.name}`)
    } catch (failure) {
      setError(errorText(failure))
    } finally { setBusy(false) }
  }

  function update(change: (draft: Descriptions) => void) {
    setDescriptions((current) => {
      if (!current) return current
      const draft: Descriptions = JSON.parse(JSON.stringify(current))
      change(draft)
      return draft
    })
  }
  const entry = (draft: Descriptions, table: string) => (draft.tables[table] ??= {})

  function setAuto(value: boolean) {
    setAutoDescribe(value)
    if (!erd || !descriptions) return
    // Keep the review structure (module, groups, headings, R/O overrides) and swap only the descriptions.
    const fresh = value ? generateDescriptions(erd, descriptions.module) : emptyDescriptions(erd, descriptions.module)
    for (const [name, table] of Object.entries(descriptions.tables)) {
      const target = (fresh.tables[name] ??= {})
      if (table._display) target._display = table._display
      if (table._required) target._required = table._required
    }
    setDescriptions({ ...fresh, groups: descriptions.groups })
    setNotice(value ? 'Descriptions generated from the ERD' : 'Using the dictionary and FK/lookup fallbacks only')
  }

  function moveToGroup(table: string, title: string) {
    update((draft) => {
      draft.groups.forEach((group) => { group.tables = group.tables.filter((name) => name !== table) })
      draft.groups.find((group) => group.title === title)?.tables.push(table)
    })
  }
  function moveWithinGroup(table: string, step: -1 | 1) {
    update((draft) => {
      const group = draft.groups.find((candidate) => candidate.tables.includes(table))
      if (!group) return
      const index = group.tables.indexOf(table), target = index + step
      if (target < 0 || target >= group.tables.length) return
      group.tables.splice(index, 1)
      group.tables.splice(target, 0, table)
    })
  }

  async function uploadDescriptions(file: File | undefined) {
    if (!file) return
    setError(''); setNotice('')
    try {
      if (file.size > FILE_LIMIT) throw new Error('descriptions.json exceeds the 20 MB limit.')
      setDescriptions(readDescriptions(await file.text()))
      setNotice(`Descriptions loaded from ${file.name}`)
    } catch (failure) { setError(errorText(failure)) }
  }

  async function exportWord() {
    if (!built || !descriptions) return
    setError(''); setBusy(true)
    try {
      download(await renderDocx(built.document), `${fileStem(descriptions.module)}_LLD_Detailed_Field_Description.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      setNotice(warnings.length ? `Word document downloaded with ${warnings.length} warning${warnings.length > 1 ? 's' : ''} to review` : 'Word document downloaded')
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  const grouped = new Map<WarningKind, typeof warnings>()
  for (const warning of warnings) grouped.set(warning.kind, [...(grouped.get(warning.kind) ?? []), warning])
  const columnCount = built?.document.sections.reduce((total, section) => total + section.tables.reduce((sum, table) => sum + table.rows.length, 0), 0) ?? 0

  return (
    <main className="workspace lld-workspace" aria-label="ERD to Word workspace">
      <section className="document-toolbar lld-toolbar" aria-label="LLD export actions">
        <div className="document-name">
          <label htmlFor="lld-module">Module name</label>
          <div className="filename-field"><input id="lld-module" value={descriptions?.module ?? ''} maxLength={80} disabled={!descriptions} autoComplete="off" spellCheck={false}
            placeholder="Open an ERD first" onChange={(event) => update((draft) => { draft.module = event.target.value })} /><span>Module</span></div>
        </div>
        <div className="export-actions lld-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => erdInput.current?.click()}>
            {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <FileInput size={16} aria-hidden="true" />}Open Visio ERD
          </button>
          <button type="button" className="button primary" disabled={!built || busy || !descriptions?.module.trim()} onClick={() => void exportWord()}>
            <ArrowDownToLine size={16} aria-hidden="true" />Export Word
          </button>
        </div>
        <input ref={erdInput} className="visually-hidden" type="file" accept=".vsdx,application/vnd.ms-visio.drawing" tabIndex={-1} aria-label="Visio ERD file"
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void openErd(file) }} />
        <input ref={jsonInput} className="visually-hidden" type="file" accept=".json,application/json" tabIndex={-1} aria-label="Descriptions file"
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void uploadDescriptions(file) }} />
      </section>

      <div className="lld-options" role="group" aria-label="Export options">
        <label><input type="checkbox" checked={autoDescribe} onChange={(event) => setAuto(event.target.checked)} />Fill descriptions automatically</label>
        <label><input type="checkbox" checked={includeViews} onChange={(event) => setIncludeViews(event.target.checked)} />Include views</label>
        <label><input type="checkbox" checked={friendlyTypes} onChange={(event) => setFriendlyTypes(event.target.checked)} />Friendly data types</label>
        <span className="lld-option-actions">
          <button type="button" className="icon-button" title="Upload descriptions.json" aria-label="Upload descriptions.json" disabled={!erd} onClick={() => jsonInput.current?.click()}><Upload size={17} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="Download descriptions.json" aria-label="Download descriptions.json" disabled={!descriptions}
            onClick={() => descriptions && download(JSON.stringify(descriptions, null, 2), `${fileStem(descriptions.module)}_descriptions.json`, 'application/json')}><FileJson size={17} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="Download validation report" aria-label="Download validation report" disabled={!erd}
            onClick={() => download(warnings.map((warning) => `[${WARNING_TITLES[warning.kind]}] ${warning.message}`).join('\r\n') || 'No warnings.', `${fileStem(descriptions?.module ?? 'Module')}_validation_report.txt`, 'text/plain;charset=utf-8')}><FileText size={17} aria-hidden="true" /></button>
        </span>
      </div>

      <div className={`status-area ${error ? 'has-error' : ''}`}>
        <div className="status-line" role="status" aria-live="polite">
          {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : error ? <CircleAlert size={14} aria-hidden="true" /> : <span className="status-dot" />}
          <span>{busy ? 'Working' : error ? 'Action required' : notice || (erd ? `${columnCount} columns ready` : 'Open a Visio ERD (.vsdx) to start')}</span>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>

      {built && descriptions && <div className="lld-body">
        <section className="lld-review" aria-label="Review descriptions">
          {built.document.sections.map((section) => {
            const groupIndex = descriptions.groups.findIndex((group) => group.title === section.title)
            const editable = groupIndex >= 0
            return <div className="lld-section" key={section.title}>
              <div className="lld-section-head">
                {editable ? <input className="lld-group-title" aria-label="Group title" value={section.title}
                  onChange={(event) => update((draft) => { draft.groups[groupIndex].title = event.target.value })} /> : <h2>{section.title}</h2>}
                {editable && <button type="button" className="icon-button danger" title="Remove group" aria-label={`Remove group ${section.title}`}
                  onClick={() => update((draft) => { draft.groups.splice(groupIndex, 1) })}><Trash2 size={16} aria-hidden="true" /></button>}
              </div>
              {section.tables.map((table) => {
                const isView = section.title === VIEWS_TITLE
                return <article className="lld-table" key={table.fullName} aria-label={table.fullName}>
                  <div className="lld-table-head">
                    <input className="lld-display" aria-label={`Heading of ${table.fullName}`} value={table.displayName}
                      onChange={(event) => update((draft) => { entry(draft, table.fullName)._display = event.target.value })} />
                    <span className="lld-full-name">{table.fullName}</span>
                    {!isView && <span className="lld-table-actions">
                      <select aria-label={`Group of ${table.fullName}`} value={editable ? section.title : ''} onChange={(event) => moveToGroup(table.fullName, event.target.value)}>
                        <option value="">{OTHER_TITLE}</option>
                        {groupTitles.map((title, index) => <option key={`${index}-${title}`} value={title}>{title || `Group ${index + 1}`}</option>)}
                      </select>
                      <button type="button" className="icon-button" title="Move up" aria-label={`Move ${table.fullName} up`} disabled={!editable} onClick={() => moveWithinGroup(table.fullName, -1)}><ArrowUp size={16} aria-hidden="true" /></button>
                      <button type="button" className="icon-button" title="Move down" aria-label={`Move ${table.fullName} down`} disabled={!editable} onClick={() => moveWithinGroup(table.fullName, 1)}><ArrowDown size={16} aria-hidden="true" /></button>
                    </span>}
                  </div>
                  <div className="lld-grid-scroll">
                    <table className="lld-grid">
                      <thead><tr><th>Field</th><th>Data Type</th><th>R/O</th><th>Description</th></tr></thead>
                      <tbody>{table.rows.map((row) => {
                        const id = `${table.fullName}|${row.field}`
                        const state = flagged.missing.has(id) ? 'is-missing' : flagged.uncertain.has(id) ? 'is-uncertain' : ''
                        return <tr key={row.field} className={state}>
                          <td className="lld-field">{row.field}</td>
                          <td className="lld-type">{row.dataType}</td>
                          <td className="lld-ro">{isView ? '-' : <select aria-label={`Required or optional: ${row.field}`} value={row.ro}
                            onChange={(event) => update((draft) => { (entry(draft, table.fullName)._required ??= {})[row.field] = event.target.value as 'R' | 'O' })}>
                            <option value="R">R</option><option value="O">O</option></select>}</td>
                          <td><textarea aria-label={`Description of ${row.field}`} rows={1} value={row.description} placeholder="No description"
                            onChange={(event) => update((draft) => {
                              const target = entry(draft, table.fullName)
                              target[row.field] = event.target.value
                              if (target._uncertain) target._uncertain = target._uncertain.filter((column) => column !== row.field)
                            })} /></td>
                        </tr>
                      })}</tbody>
                    </table>
                  </div>
                </article>
              })}
            </div>
          })}
          <button type="button" className="button secondary lld-add-group" onClick={() => update((draft) => { draft.groups.push({ title: `Group ${draft.groups.length + 1}`, tables: [] }) })}>
            <FolderPlus size={16} aria-hidden="true" />Add group
          </button>
        </section>

        <aside className="lld-report" aria-label="Validation report">
          <h2><TriangleAlert size={16} aria-hidden="true" />Validation report</h2>
          {!warnings.length ? <p className="lld-report-empty">No warnings.</p> : [...grouped.entries()].map(([kind, list]) => (
            <details key={kind} open={kind !== 'uncertain-description'}>
              <summary>{WARNING_TITLES[kind]} <span>{list.length}</span></summary>
              <ul>{list.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>
            </details>
          ))}
        </aside>
      </div>}
    </main>
  )
}
