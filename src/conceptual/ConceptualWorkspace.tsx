import { useRef, useState } from 'react'
import { ArrowDownToLine, ArrowLeftRight, CircleAlert, FileInput, LoaderCircle } from 'lucide-react'
import { parseErd } from '../lld/parse'
import { download, errorText, FILE_LIMIT, fileStem } from '../shared/files'
import { conceptModel, MULTIPLICITIES, type ConceptLink, type ConceptModel, type LinkKind } from './model'
import { generateConceptualVsdx } from './vsdx'
import '../lld/lld.css'
import './conceptual.css'

const KINDS: { kind: LinkKind; title: string }[] = [
  { kind: 'composition', title: 'Composition' }, { kind: 'association', title: 'Association' }, { kind: 'directed', title: 'Directed association' },
]
// "Billing_ERD_v2 (1).vsdx" -> "Billing"
const moduleFromFile = (name: string) => name.replace(/\.vsdx$/i, '').replace(/\(\d+\)/g, '').replace(/[_\s-]*(ERD|v\d+)\b/gi, '').replace(/[_-]+/g, ' ').trim()

export default function ConceptualWorkspace() {
  const [model, setModel] = useState<ConceptModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const erdInput = useRef<HTMLInputElement>(null)

  async function openErd(file: File | undefined) {
    if (!file) return
    setError(''); setNotice('')
    if (!/\.vsdx$/i.test(file.name)) { setError('Choose a Visio .vsdx ERD.'); return }
    if (file.size > FILE_LIMIT) { setError('The ERD exceeds the 20 MB limit.'); return }
    setBusy(true)
    try {
      const parsed = await parseErd(await file.arrayBuffer(), file.name)
      const next = conceptModel(parsed, moduleFromFile(file.name) || 'Module')
      if (!next.entities.length) throw new Error('No ERD tables were found: tables must be Entity shapes with a name and a tab-separated column list.')
      setModel(next)
      setNotice(`Read ${next.entities.length} entities and ${next.links.length} relationships from ${file.name}`)
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  const update = (change: (draft: ConceptModel) => void) => setModel((current) => {
    if (!current) return current
    const draft: ConceptModel = structuredClone(current)
    change(draft)
    return draft
  })
  const updateLink = (id: string, change: (link: ConceptLink) => void) => update((draft) => { change(draft.links.find((link) => link.id === id)!) })

  async function exportVisio() {
    if (!model) return
    setError(''); setBusy(true)
    try {
      download(await generateConceptualVsdx(model, `${model.module.trim()} Conceptual Diagram`), `${fileStem(model.module)}_Conceptual_Diagram.vsdx`, 'application/vnd.ms-visio.drawing')
      setNotice('Conceptual diagram downloaded')
    } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }

  const names = new Map(model?.entities.map((entity) => [entity.id, entity.name.trim() || entity.id]))
  const included = new Set(model?.entities.filter((entity) => entity.include).map((entity) => entity.id))
  const shown = model?.links.filter((link) => included.has(link.from) && included.has(link.to)).length ?? 0

  return (
    <main className="workspace lld-workspace" aria-label="ERD to conceptual diagram workspace">
      <section className="document-toolbar lld-toolbar" aria-label="Conceptual diagram actions">
        <div className="document-name">
          <label htmlFor="concept-module">Module name</label>
          <div className="filename-field"><input id="concept-module" value={model?.module ?? ''} maxLength={80} disabled={!model} autoComplete="off" spellCheck={false}
            placeholder="Open an ERD first" onChange={(event) => update((draft) => { draft.module = event.target.value })} /><span>Module</span></div>
        </div>
        <div className="export-actions lld-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => erdInput.current?.click()}>
            {busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <FileInput size={16} aria-hidden="true" />}Open Visio ERD
          </button>
          <button type="button" className="button primary" disabled={!model || busy || !model.module.trim() || !included.size} onClick={() => void exportVisio()}>
            <ArrowDownToLine size={16} aria-hidden="true" />Download Visio
          </button>
        </div>
        <input ref={erdInput} className="visually-hidden" type="file" accept=".vsdx,application/vnd.ms-visio.drawing" tabIndex={-1} aria-label="ERD for the conceptual diagram"
          onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void openErd(file) }} />
      </section>

      <div className={`status-area ${error ? 'has-error' : ''}`}>
        <div className="status-line" role="status" aria-live="polite">
          {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : error ? <CircleAlert size={14} aria-hidden="true" /> : <span className="status-dot" />}
          <span>{busy ? 'Working' : error ? 'Action required' : notice || (model ? `${included.size} entities / ${shown} relationships` : 'Open a Visio ERD (.vsdx) to start')}</span>
        </div>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>

      {model && <div className="concept-body">
        <section className="lld-table concept-list" aria-label="Entities">
          <h2>Entities <span>{included.size} of {model.entities.length}</span></h2>
          <ul>{model.entities.map((entity) => (
            <li key={entity.id} className={`concept-entity ${entity.include ? '' : 'is-excluded'}`}>
              <input type="checkbox" checked={entity.include} aria-label={`Include ${entity.id}`}
                onChange={(event) => update((draft) => { draft.entities.find((item) => item.id === entity.id)!.include = event.target.checked })} />
              <input className="lld-display" value={entity.name} maxLength={120} aria-label={`Name of ${entity.id}`}
                onChange={(event) => update((draft) => { draft.entities.find((item) => item.id === entity.id)!.name = event.target.value })} />
              <span className="lld-full-name">{entity.id}</span>
            </li>
          ))}</ul>
        </section>

        <section className="lld-table concept-list" aria-label="Relationships">
          <h2>Relationships <span>{shown} of {model.links.length}</span></h2>
          <datalist id="concept-multiplicities">{MULTIPLICITIES.map((value) => <option key={value} value={value} />)}</datalist>
          <ul>{model.links.map((link) => {
            const active = included.has(link.from) && included.has(link.to)
            const [from, to] = [names.get(link.from), names.get(link.to)]
            return <li key={link.id} className={`concept-link ${active ? '' : 'is-excluded'}`} aria-label={`${from} to ${to}`}>
              <span className="concept-ends">
                <input className="concept-multi" list="concept-multiplicities" value={link.fromMultiplicity} maxLength={12} aria-label={`Multiplicity at ${from}`}
                  onChange={(event) => updateLink(link.id, (draft) => { draft.fromMultiplicity = event.target.value })} />
                <strong>{from}</strong>
                <select value={link.kind} aria-label={`Kind of ${from} to ${to}`} onChange={(event) => updateLink(link.id, (draft) => { draft.kind = event.target.value as LinkKind })}>
                  {KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.title}</option>)}
                </select>
                <strong>{to}</strong>
                <input className="concept-multi" list="concept-multiplicities" value={link.toMultiplicity} maxLength={12} aria-label={`Multiplicity at ${to}`}
                  onChange={(event) => updateLink(link.id, (draft) => { draft.toMultiplicity = event.target.value })} />
              </span>
              <span className="concept-extra">
                <input className="concept-label" value={link.label} maxLength={60} placeholder="Label" aria-label={`Label of ${from} to ${to}`}
                  onChange={(event) => updateLink(link.id, (draft) => { draft.label = event.target.value })} />
                <button type="button" className="icon-button" title="Swap direction" aria-label={`Swap direction of ${from} to ${to}`}
                  onClick={() => updateLink(link.id, (draft) => {
                    [draft.from, draft.to] = [draft.to, draft.from];
                    [draft.fromMultiplicity, draft.toMultiplicity] = [draft.toMultiplicity, draft.fromMultiplicity]
                  })}><ArrowLeftRight size={16} aria-hidden="true" /></button>
                {!active && <em>Skipped: an entity is excluded</em>}
              </span>
            </li>
          })}</ul>
        </section>
      </div>}
    </main>
  )
}
