import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine, Check, CircleAlert, Code2, Database, FileInput, FilePlus2,
  Focus, LoaderCircle, LockKeyhole, Play, ScanLine, Trash2, ZoomIn, ZoomOut,
} from 'lucide-react'
import { detectKind, generateVsdx, prepareDiagram } from './converter'
import { ER_SAMPLE_CODE, SAMPLE_CODE } from './sample'
import './App.css'

const SOURCE_LIMIT = 100_000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
type Diagram = Awaited<ReturnType<typeof prepareDiagram>>
type Preview = Diagram & { source: string; imageUrl: string; width: number; height: number }
type Operation = 'prepare' | 'export' | 'import' | null
let converterQueue: Promise<void> = Promise.resolve()
let renderSequence = 0

function serializeConversion<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = converterQueue.then(operation)
  converterQueue = result.then(() => undefined, () => undefined)
  return result
}

function safeFilename(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? ''
  const cleaned = Array.from(leaf)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\.(?:mmd|txt|vsdx)$/i, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
  return !cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
    ? 'diagram' : cleaned
}

function downloadFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed.'
}

function sanitizedPreview(diagram: Diagram, source: string): Preview {
  const document = new DOMParser().parseFromString(diagram.svg, 'image/svg+xml')
  const root = document.documentElement
  if (document.doctype || document.querySelector('parsererror') || root.localName !== 'svg'
    || root.namespaceURI !== SVG_NAMESPACE) {
    throw new Error('The diagram renderer returned an invalid SVG.')
  }
  const svgTags = new Set(['svg', 'g', 'defs', 'style', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'marker', 'clippath',
    'mask', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc',
    'foreignobject', 'use'])
  const htmlTags = new Set(['div', 'span', 'p', 'br', 'b', 'strong', 'i', 'em'])
  const attributes = new Set(['id', 'class', 'style', 'xmlns', 'xmlns:xlink', 'viewbox',
    'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
    'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'font-size',
    'font-family', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
    'alignment-baseline', 'dx', 'dy', 'textlength', 'lengthadjust', 'preserveaspectratio',
    'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight',
    'markerunits', 'refx', 'refy', 'orient', 'clippathunits', 'clip-path', 'mask',
    'patternunits', 'patterntransform', 'gradientunits', 'gradienttransform',
    'offset', 'stop-color', 'stop-opacity', 'href', 'xlink:href', 'role', 'aria-label',
    'aria-labelledby', 'aria-describedby', 'aria-roledescription'])
  const safeStyle = (value: string) => !/[@\\]|(?:expression|javascript|https?|data)\s*:|expression\s*\(|-moz-binding|behavior\s*:/i.test(value)
    && !/url\s*\(\s*(?!["']?#[\w:.-]+["']?\s*\))/i.test(value)
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.localName.toLowerCase()
    const allowed = element.namespaceURI === SVG_NAMESPACE ? svgTags.has(tag)
      : element.namespaceURI === HTML_NAMESPACE && htmlTags.has(tag)
    if (!allowed) {
      element.remove()
      continue
    }
    if (tag === 'style') {
      const stylesheet = new CSSStyleSheet()
      stylesheet.replaceSync(element.textContent ?? '')
      const rules = Array.from(stylesheet.cssRules)
        .filter((rule) => rule.type === CSSRule.STYLE_RULE && safeStyle(rule.cssText))
        .map((rule) => rule.cssText)
      element.textContent = rules.join('\n')
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (!attributes.has(name) || !safeStyle(attribute.value)
        || ((name === 'href' || name === 'xlink:href') && !/^#[\w:.-]+$/.test(attribute.value))) {
        element.removeAttributeNode(attribute)
      }
    }
  }
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const width = viewBox.length === 4 ? viewBox[2] : Number.parseFloat(root.getAttribute('width') ?? '')
  const height = viewBox.length === 4 ? viewBox[3] : Number.parseFloat(root.getAttribute('height') ?? '')
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The diagram has no valid preview dimensions.')
  }
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.removeAttribute('style')
  const svg = new XMLSerializer().serializeToString(root)
  return { ...diagram, svg, source, width, height,
    imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }
}

function App() {
  const [source, setSource] = useState(SAMPLE_CODE)
  const [title, setTitle] = useState('CreateBillRequest')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [operation, setOperation] = useState<Operation>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<'editor' | 'preview'>('editor')
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const sourceRef = useRef(SAMPLE_CODE)
  const titleRef = useRef('CreateBillRequest')
  const revisionRef = useRef(0)
  const requestRef = useRef(0)
  const mountedRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const current = preview !== null && preview.source === source && !error && !operation
  const filename = safeFilename(title)
  const kind = detectKind(source)

  const prepareSnapshot = useCallback(async (snapshot: string, revision: number, request: number) => {
    setOperation('prepare')
    setError('')
    setNotice('')
    const active = () => mountedRef.current && revision === revisionRef.current && request === requestRef.current
    try {
      if (!snapshot.trim()) throw new Error('Enter Mermaid source before preparing.')
      if (snapshot.length > SOURCE_LIMIT) throw new Error('Source exceeds the 100,000 character limit.')
      const diagram = await serializeConversion(async () => {
        if (!active()) return null
        return prepareDiagram(snapshot, `diagram-${++renderSequence}`)
      })
      if (!active() || !diagram) return
      setPreview(sanitizedPreview(diagram, snapshot))
      setFit(true)
      setZoom(1)
      viewportRef.current?.scrollTo(0, 0)
      setNotice('Preview ready')
    } catch (failure) {
      if (active()) {
        setPreview(null)
        setError(errorMessage(failure))
      }
    } finally {
      if (active()) setOperation(null)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void prepareSnapshot(SAMPLE_CODE, revisionRef.current, ++requestRef.current)
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [prepareSnapshot])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function invalidate() {
    revisionRef.current += 1
    requestRef.current += 1
    setOperation(null)
    setPreview(null)
    setError('')
    setNotice('')
  }

  function changeSource(value: string) {
    invalidate()
    sourceRef.current = value
    setSource(value)
    setFit(true)
  }

  function changeTitle(value: string) {
    titleRef.current = value
    setTitle(value)
  }

  function navigateTab(event: React.KeyboardEvent<HTMLButtonElement>, origin: 'editor' | 'preview') {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = event.key === 'Home' ? 'editor' : event.key === 'End' ? 'preview'
      : origin === 'editor' ? 'preview' : 'editor'
    setTab(target)
    document.getElementById(`${target}-tab`)?.focus()
  }

  async function importFile(file: File | undefined) {
    if (!file) return
    invalidate()
    const revision = revisionRef.current
    const active = () => mountedRef.current && revision === revisionRef.current
    setOperation('import')
    try {
      if (!/\.(?:mmd|txt)$/i.test(file.name)) throw new Error('Choose a .mmd or .txt file.')
      if (file.size > SOURCE_LIMIT) throw new Error('The file exceeds the 100 KB import limit.')
      const text = await file.text()
      if (!active()) return
      if (text.length > SOURCE_LIMIT) throw new Error('Source exceeds the 100,000 character limit.')
      changeSource(text)
      changeTitle(safeFilename(file.name))
      setNotice('Source imported')
    } catch (failure) {
      if (active()) setError(errorMessage(failure))
    } finally {
      if (active()) setOperation(null)
    }
  }

  async function exportVisio() {
    if (!current || !preview) return
    const snapshot = preview
    const capturedTitle = filename
    const capturedTitleValue = titleRef.current
    const revision = revisionRef.current
    const request = ++requestRef.current
    const active = () => mountedRef.current && revision === revisionRef.current
      && request === requestRef.current && snapshot.source === sourceRef.current
    setOperation('export')
    setError('')
    setNotice('')
    try {
      const bytes = await serializeConversion(async () => {
        if (!active()) return null
        return generateVsdx(snapshot.model, capturedTitle)
      })
      if (!active() || !bytes) return
      if (capturedTitleValue !== titleRef.current) {
        setNotice('Name changed; download again')
        return
      }
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      downloadFile(new Blob([copy.buffer], { type: 'application/vnd.ms-visio.drawing' }), `${capturedTitle}.vsdx`)
      setNotice('Visio file downloaded')
    } catch (failure) {
      if (active()) setError(errorMessage(failure))
    } finally {
      if (active()) setOperation(null)
    }
  }

  const fitScale = preview && viewport.width > 0
    ? Math.max(0.01, Math.min((viewport.width - 48) / preview.width, (viewport.height - 48) / preview.height, 1)) : 1
  const scale = fit ? fitScale : zoom
  const status = operation === 'prepare' ? 'Preparing preview'
    : operation === 'export' ? 'Generating Visio file'
      : operation === 'import' ? 'Reading source'
        : error ? 'Action required'
          : notice || (source.trim() ? 'Changes not prepared' : 'No source')

  function adjustZoom(factor: number) {
    setZoom(Math.max(0.05, Math.min(4, scale * factor)))
    setFit(false)
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark"><ScanLine aria-hidden="true" /></span><h1>Mermaid to Visio</h1></div>
        <span className="privacy-status"><LockKeyhole size={14} aria-hidden="true" />Local only</span>
      </header>

      <main className="workspace" aria-label="Diagram workspace">
        <section className="document-toolbar" aria-label="Document actions">
          <div className="document-name">
            <label htmlFor="diagram-title">Diagram name</label>
            <div className="filename-field"><input id="diagram-title" value={title} maxLength={120}
              onChange={(event) => changeTitle(event.target.value)} autoComplete="off" spellCheck={false} /><span>.vsdx</span></div>
          </div>
          <div className="export-actions">
            <button type="button" className="button secondary" disabled={!source.trim() || operation !== null}
              onClick={() => void prepareSnapshot(sourceRef.current, revisionRef.current, ++requestRef.current)}>
              {operation === 'prepare' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}Prepare preview
            </button>
            <button type="button" className="button primary" disabled={!current} onClick={() => void exportVisio()}>
              {operation === 'export' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ArrowDownToLine size={16} aria-hidden="true" />}Download Visio
            </button>
          </div>
        </section>

        <div className="mobile-tabs" role="tablist" aria-label="Workspace view">
          <button type="button" id="editor-tab" role="tab" aria-selected={tab === 'editor'} aria-controls="editor-panel"
            tabIndex={tab === 'editor' ? 0 : -1} onClick={() => setTab('editor')}
            onKeyDown={(event) => navigateTab(event, 'editor')}>
            <Code2 size={16} aria-hidden="true" />Editor
          </button>
          <button type="button" id="preview-tab" role="tab" aria-selected={tab === 'preview'} aria-controls="preview-panel"
            tabIndex={tab === 'preview' ? 0 : -1} onClick={() => setTab('preview')}
            onKeyDown={(event) => navigateTab(event, 'preview')}>
            <ScanLine size={16} aria-hidden="true" />Preview
          </button>
        </div>

        <div className={`panes mobile-${tab}`}>
          <section id="editor-panel" className="editor-panel" aria-label="Source editor">
            <div className="pane-toolbar">
              <h2><Code2 size={16} aria-hidden="true" />Source</h2>
              <div className="source-actions">
                <button type="button" className="icon-button" title="Import .mmd or .txt" aria-label="Import .mmd or .txt"
                  onClick={() => fileInputRef.current?.click()}><FileInput size={17} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title="Load billing sample" aria-label="Load billing sample"
                  onClick={() => { changeSource(SAMPLE_CODE); changeTitle('CreateBillRequest'); setNotice('Sample loaded'); editorRef.current?.focus() }}><FilePlus2 size={17} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title="Load ER sample" aria-label="Load ER sample"
                  onClick={() => { changeSource(ER_SAMPLE_CODE); changeTitle('SalesERD'); setNotice('ER sample loaded'); editorRef.current?.focus() }}><Database size={17} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title="Download source" aria-label="Download source" disabled={!source.trim()}
                  onClick={() => downloadFile(new Blob([sourceRef.current], { type: 'text/plain;charset=utf-8' }), `${filename}.mmd`)}><ArrowDownToLine size={17} aria-hidden="true" /></button>
                <span className="toolbar-divider" />
                <button type="button" className="icon-button danger" title="Clear source" aria-label="Clear source" disabled={!source}
                  onClick={() => { changeSource(''); editorRef.current?.focus() }}><Trash2 size={17} aria-hidden="true" /></button>
              </div>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept=".mmd,.txt,text/plain" tabIndex={-1} aria-label="Import source file"
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
            </div>
            <textarea ref={editorRef} className="source-editor" aria-label="Mermaid diagram source" value={source}
              maxLength={SOURCE_LIMIT} onChange={(event) => changeSource(event.target.value)} spellCheck={false}
              autoCapitalize="off" autoCorrect="off" wrap="off" />
            <div className="editor-footer"><span>{kind === 'er' ? 'Mermaid / ER' : kind === 'sequence' ? 'Mermaid / sequence' : 'Mermaid'}</span><span>{source.length.toLocaleString()} / 100,000</span></div>
          </section>

          <section id="preview-panel" className="preview-panel" aria-label="Diagram preview">
            <div className="pane-toolbar">
              <h2><ScanLine size={16} aria-hidden="true" />Preview</h2>
              <div className="zoom-actions" aria-label="Preview scale">
                <button type="button" className="icon-button" title="Zoom out" aria-label="Zoom out" disabled={!preview || scale <= 0.05}
                  onClick={() => adjustZoom(1 / 1.25)}><ZoomOut size={17} aria-hidden="true" /></button>
                <button type="button" className="zoom-value" title="Actual size" aria-label="Actual size, 100 percent" disabled={!preview}
                  onClick={() => { setFit(false); setZoom(1) }}>{Math.round(scale * 100)}%</button>
                <button type="button" className="icon-button" title="Zoom in" aria-label="Zoom in" disabled={!preview || scale >= 4}
                  onClick={() => adjustZoom(1.25)}><ZoomIn size={17} aria-hidden="true" /></button>
                <span className="toolbar-divider" />
                <button type="button" className={`icon-button ${fit ? 'is-active' : ''}`} title="Fit diagram" aria-label="Fit diagram" aria-pressed={fit} disabled={!preview}
                  onClick={() => { setFit(true); viewportRef.current?.scrollTo(0, 0) }}><Focus size={17} aria-hidden="true" /></button>
              </div>
            </div>
            <div ref={viewportRef} className="preview-viewport" aria-busy={operation === 'prepare'} tabIndex={0} aria-label="Scrollable diagram preview">
              {preview ? <div className="diagram-canvas" style={{ width: `max(100%, ${preview.width * scale + 48}px)`, height: `max(100%, ${preview.height * scale + 48}px)` }}>
                <img src={preview.imageUrl} alt="Prepared Mermaid diagram" width={preview.width * scale} height={preview.height * scale} draggable={false} />
              </div> : <div className={`preview-empty ${error ? 'has-error' : ''}`}>
                {operation === 'prepare' ? <LoaderCircle size={28} className="spin" aria-hidden="true" /> : error ? <CircleAlert size={28} aria-hidden="true" /> : <ScanLine size={28} aria-hidden="true" />}
                <span>{operation === 'prepare' ? 'Preparing diagram' : error ? 'Preview unavailable' : source.trim() ? 'Preview not prepared' : 'No diagram'}</span>
              </div>}
            </div>
            <div className="preview-footer">
              <span>{preview ? (preview.model.kind === 'er' ? 'ER diagram' : 'Sequence diagram') : 'Awaiting preview'}</span>
              <span className="counts">{!preview ? '-' : preview.model.kind === 'er'
                ? `${preview.model.entities.filter((entity) => !entity.view).length} tables / ${preview.model.entities.filter((entity) => entity.view).length} views / ${preview.model.relationships.length} relationships`
                : `${preview.model.participants.length} participants / ${preview.model.messages.length} messages / ${preview.model.frames.length} frames`}</span>
            </div>
          </section>
        </div>

        <div className={`status-area ${error ? 'has-error' : ''}`}>
          <div className="status-line" role="status" aria-live="polite">
            {operation ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : error ? <CircleAlert size={14} aria-hidden="true" /> : current ? <Check size={14} aria-hidden="true" /> : <span className="status-dot" />}
            <span>{status}</span>
          </div>
          {error && <p className="error-message" role="alert">{error}</p>}
        </div>
      </main>
    </div>
  )
}

export default App
