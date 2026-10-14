import { XMLParser } from 'fast-xml-parser'
import mastersXml from './native/masters.xml?raw'
import documentXml from './native/document.xml?raw'
import master1 from './native/master1.xml?raw'
import master2 from './native/master2.xml?raw'
import master3 from './native/master3.xml?raw'
import master4 from './native/master4.xml?raw'
import master5 from './native/master5.xml?raw'
import master6 from './native/master6.xml?raw'
import master7 from './native/master7.xml?raw'
import master8 from './native/master8.xml?raw'
import master9 from './native/master9.xml?raw'
import master10 from './native/master10.xml?raw'
import master11 from './native/master11.xml?raw'
import master12 from './native/master12.xml?raw'
import manifest from './native/manifest.json'
import erdMastersXml from './native-erd/masters.xml?raw'
import erdDocumentXml from './native-erd/document.xml?raw'
import erdMaster1 from './native-erd/master1.xml?raw'
import erdMaster2 from './native-erd/master2.xml?raw'
import erdMaster3 from './native-erd/master3.xml?raw'
import erdMaster5 from './native-erd/master5.xml?raw'
import erdMaster6 from './native-erd/master6.xml?raw'
import erdMaster7 from './native-erd/master7.xml?raw'
import erdMaster8 from './native-erd/master8.xml?raw'
import erdMaster9 from './native-erd/master9.xml?raw'
import erdManifest from './native-erd/manifest.json'

export const MASTER = { ActorLifeline: 2, ObjectLifeline: 4, Message: 5, SelfMessage: 6, Loop: 7, Alternative: 8, Operand: 9,
  Async: 10, Return: 11, Other: 14, Optional: 15, Activation: 16 } as const
const contents: Record<string, string> = { 'master1.xml': master1, 'master2.xml': master2, 'master3.xml': master3, 'master4.xml': master4,
  'master5.xml': master5, 'master6.xml': master6, 'master7.xml': master7, 'master8.xml': master8, 'master9.xml': master9,
  'master10.xml': master10, 'master11.xml': master11, 'master12.xml': master12 }
export interface NativeTemplate { key: string; mastersXml: string; documentXml: string; masters: { id: number; nameU: string; rel: string; file: string; xml: string }[] }
export const nativeTemplate: NativeTemplate = { key: 'sequence', mastersXml, documentXml, masters: manifest.masters.map((master) => ({ ...master, xml: contents[master.file] })) }

// Database Model Diagram (Entity Relationship stencil) masters derived from the reference ERD.
export const ERD_MASTER = { Entity: 11, View: 12, Relationship: 13 } as const
const erdContents: Record<string, string> = { 'master1.xml': erdMaster1, 'master2.xml': erdMaster2, 'master3.xml': erdMaster3, 'master5.xml': erdMaster5,
  'master6.xml': erdMaster6, 'master7.xml': erdMaster7, 'master8.xml': erdMaster8, 'master9.xml': erdMaster9 }
export const erdTemplate: NativeTemplate = { key: 'erd', mastersXml: erdMastersXml, documentXml: erdDocumentXml,
  masters: erdManifest.masters.map((master) => ({ ...master, xml: erdContents[master.file] })) }

type Location = { section?: string; sectionIX?: number; row?: string; rowIsIX?: boolean; rowT?: string; cell: string }
interface CellRecord { key: string; location: Location; V: string; F?: string }
interface MasterSheet { id: number; type: string; cells: Map<string, CellRecord>; order: string[]; text: string; children: MasterSheet[] }
export interface Override { V: number | string; F?: string }

const parser = new XMLParser({ ignoreAttributes: false, stopNodes: ['*.Text'], isArray: (name) => ['Shape', 'Cell', 'Row', 'Section'].includes(name) })
type RawCell = { '@_N': string; '@_V'?: string; '@_F'?: string }
type RawRow = { '@_IX'?: string; '@_N'?: string; '@_T'?: string; Cell?: RawCell[] }
type RawSection = { '@_N': string; '@_IX'?: string; Cell?: RawCell[]; Row?: RawRow[] }
type RawShape = { '@_ID': string; '@_Type': string; Cell?: RawCell[]; Section?: RawSection[]; Text?: string; Shapes?: { Shape: RawShape[] } }

function sectionKey(section: string, sectionIX: number, row: string | undefined, rowIsIX: boolean, cell: string): string[] {
  const upper = cell.toUpperCase()
  if (section === 'Geometry') return [row === undefined ? `GEOMETRY${sectionIX + 1}.${upper}` : `GEOMETRY${sectionIX + 1}.${upper}${row}`]
  if (section === 'Connection') return rowIsIX ? [`CONNECTIONS.${upper}${Number(row) + 1}`] : [`CONNECTIONS.${row!.toUpperCase()}.${upper}`]
  if (section === 'Character') return [Number(row) === 0 ? `CHAR.${upper}` : `CHAR${row}.${upper}`]
  if (section === 'Paragraph') return [Number(row) === 0 ? `PARA.${upper}` : `PARA${row}.${upper}`]
  const prefix = ({ Control: 'CONTROLS', User: 'USER', Property: 'PROP', Actions: 'ACTIONS' } as Record<string, string>)[section] ?? section.toUpperCase()
  return [`${prefix}.${String(row).toUpperCase()}.${upper}`]
}

function plainText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').replace(/\r?\n$/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : ''
}

function readSheet(shape: RawShape): MasterSheet {
  const sheet: MasterSheet = { id: Number(shape['@_ID']), type: shape['@_Type'], cells: new Map(), order: [], text: plainText(shape.Text), children: [] }
  const add = (key: string, location: Location, cell: RawCell) => {
    sheet.cells.set(key, { key, location, V: cell['@_V'] ?? '', F: cell['@_F'] })
    sheet.order.push(key)
  }
  for (const cell of shape.Cell ?? []) add(cell['@_N'].toUpperCase(), { cell: cell['@_N'] }, cell)
  for (const section of shape.Section ?? []) {
    const name = section['@_N']
    const sectionIX = Number(section['@_IX'] ?? 0)
    for (const cell of section.Cell ?? []) add(sectionKey(name, sectionIX, undefined, false, cell['@_N'])[0], { section: name, sectionIX, cell: cell['@_N'] }, cell)
    for (const row of section.Row ?? []) {
      const rowIsIX = row['@_N'] === undefined
      const id = rowIsIX ? String(row['@_IX']) : row['@_N']!
      for (const cell of row.Cell ?? []) add(sectionKey(name, sectionIX, id, rowIsIX, cell['@_N'])[0],
        { section: name, sectionIX, row: id, rowIsIX, rowT: row['@_T'], cell: cell['@_N'] }, cell)
    }
  }
  sheet.children = (shape.Shapes?.Shape ?? []).map(readSheet)
  return sheet
}

const masterSheets = new Map<string, MasterSheet>()
function masterSheet(master: number, template = nativeTemplate): MasterSheet {
  let sheet = masterSheets.get(`${template.key}:${master}`)
  if (!sheet) {
    const entry = template.masters.find((candidate) => candidate.id === master)
    if (!entry) throw new Error(`Unknown native master ${master}.`)
    sheet = readSheet(parser.parse(entry.xml).MasterContents.Shapes.Shape[0])
    masterSheets.set(`${template.key}:${master}`, sheet)
  }
  return sheet
}
export function masterCell(master: number, key: string, template = nativeTemplate): CellRecord | undefined {
  return masterSheet(master, template).cells.get(key)
}

// ShapeSheet formula subset used by the UML Sequence masters.
type Value = number | string
type Node = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'ref'; sheet?: string; name: string } | { t: 'call'; name: string; args: Node[]; sheet?: undefined }
  | { t: 'un'; op: string; a: Node } | { t: 'bin'; op: string; a: Node; b: Node } | { t: 'sheetCall'; call: Node; name: string }
const units: Record<string, number> = { IN: 1, DL: 1, IU: 1, 'IN.': 1, DA: 1, RAD: 1, DEG: Math.PI / 180, PT: 1 / 72, MM: 1 / 25.4, CM: 1 / 2.54, FT: 12, '%': 0.01 }
class Unsupported extends Error {}
const formulaCache = new Map<string, Node>()
function parseFormula(source: string): Node {
  const cached = formulaCache.get(source)
  if (cached) return cached
  const tokens = source.match(/\s+|"(?:[^"]|"")*"|\d+(?:\.\d*)?(?:E[-+]?\d+)?|\.\d+|Sheet\.\d+!|[A-Za-z_][\w.]*!?|<=|>=|<>|[-+*/^&=<>(),!%]/gi) ?? []
  if (tokens.join('') !== source) throw new Unsupported(`Unparsed formula: ${source}`)
  const list = tokens.filter((token) => !/^\s+$/.test(token))
  let index = 0
  const peek = () => list[index]
  const take = (expected?: string) => {
    const token = list[index++]
    if (expected && token?.toUpperCase() !== expected) throw new Unsupported(`Expected ${expected} in ${source}`)
    return token
  }
  const primary = (): Node => {
    const token = take()
    if (token === undefined) throw new Unsupported(source)
    if (token === '(') { const inner = comparison(); take(')'); return inner }
    if (token === '-' || token === '+') return { t: 'un', op: token, a: power() }
    if (/^[\d.]/.test(token)) {
      let value = Number(token)
      const unit = peek()?.toUpperCase()
      if (unit && units[unit] !== undefined) { take(); value *= units[unit] }
      return { t: 'num', v: value }
    }
    if (token.startsWith('"')) return { t: 'str', v: token.slice(1, -1).replace(/""/g, '"') }
    if (/^Sheet\.\d+!$/i.test(token)) return { t: 'ref', sheet: token.slice(0, -1).toUpperCase(), name: take() }
    if (peek() === '(') {
      take('(')
      const args: Node[] = []
      if (peek() !== ')') { args.push(comparison()); while (peek() === ',') { take(); args.push(comparison()) } }
      take(')')
      const call: Node = { t: 'call', name: token.toUpperCase(), args }
      if (peek() === '!') { take(); return { t: 'sheetCall', call, name: take() } }
      return call
    }
    return { t: 'ref', name: token }
  }
  const power = (): Node => { let node = primary(); while (peek() === '^') { take(); node = { t: 'bin', op: '^', a: node, b: primary() } } return node }
  const product = (): Node => { let node = power(); while (peek() === '*' || peek() === '/') { const op = take(); node = { t: 'bin', op, a: node, b: power() } } return node }
  const sum = (): Node => { let node = product(); while (peek() === '+' || peek() === '-') { const op = take(); node = { t: 'bin', op, a: node, b: product() } } return node }
  const concat = (): Node => { let node = sum(); while (peek() === '&') { take(); node = { t: 'bin', op: '&', a: node, b: sum() } } return node }
  const comparison = (): Node => { let node = concat(); while (['=', '<', '>', '<=', '>=', '<>'].includes(peek())) { const op = take(); node = { t: 'bin', op, a: node, b: concat() } } return node }
  const node = comparison()
  if (index !== list.length) throw new Unsupported(`Trailing tokens in ${source}`)
  formulaCache.set(source, node)
  return node
}

function normalizeReference(name: string): string {
  const upper = name.toUpperCase()
  const parts = upper.split('.')
  if (parts[0] === 'CONTROLS' && parts.length === 2) return `${upper}.X`
  if ((parts[0] === 'USER' || parts[0] === 'PROP') && parts.length === 2) return `${upper}.VALUE`
  if (parts[0] === 'ACTIONS' && parts.length === 2) return `${upper}.ACTION`
  return upper
}

// text is the plain content used for measurement; textXml (already escaped, with cp/pp/tp run markers) replaces it in the file.
// rows appends instance-only rows inside a section, keyed 'Section|IX' (for example 'Character|0' or 'Geometry|0').
export interface SheetSpec { cells?: Record<string, Override>; text?: string; textXml?: string; rows?: Record<string, string> }
// Instance-only Connection rows appended after the master's rows (no master row to inherit from): explicit X/Y formulas.
export interface ConnectionRow { X: string; Y: string }
export interface InstanceSpec extends SheetSpec { id: number; master: number; template?: NativeTemplate; nameU?: string; sub?: Record<number, SheetSpec>; listOrder?: number; connectionRows?: ConnectionRow[] }
export interface ResolvedInstance { spec: InstanceSpec; value(key: string, subId?: number): number; point(row: number): [number, number]; childIds: Map<number, number>; xml(): string }

const PLACEMENT = /^(?:PINX|PINY|WIDTH|HEIGHT|LOCPINX|LOCPINY|ANGLE|BEGINX|BEGINY|ENDX|ENDY|CONNECTIONS\..+)$/
const fontAdvance = 0.5
export function measureText(text: string, size: number, wrapWidth = Infinity, margins = 1 / 9): { width: number; height: number } {
  const lines = text.split('\n')
  const widths = lines.map((line) => Array.from(line).length * size * fontAdvance)
  const available = Math.max(size, wrapWidth - margins)
  const count = widths.reduce((total, width) => total + Math.max(1, Math.ceil(width / available - 1e-9)), 0)
  return { width: Math.max(...widths) + margins, height: count * size * 1.2 + margins }
}

const connectionRowCount = (master: MasterSheet) => new Set([...master.cells.values()].filter((record) => record.location.section === 'Connection').map((record) => record.location.row)).size
export function masterConnectionRows(master: number, template = nativeTemplate): number {
  return connectionRowCount(masterSheet(master, template))
}

function appendedConnections(master: MasterSheet, spec: InstanceSpec): Map<string, CellRecord> {
  const base = connectionRowCount(master)
  const records = new Map<string, CellRecord>()
  for (const [offset, row] of (spec.connectionRows ?? []).entries()) {
    for (const name of ['X', 'Y'] as const) {
      const key = `CONNECTIONS.${name}${base + offset + 1}`
      if (master.cells.has(key)) throw new Error(`Appended connection ${key} collides with a master row.`)
      records.set(key, { key, location: { section: 'Connection', sectionIX: 0, row: String(base + offset), rowIsIX: true, rowT: 'Connection', cell: name }, V: '', F: row[name] })
    }
  }
  return records
}

function evaluator(master: MasterSheet, spec: InstanceSpec) {
  const appended = appendedConnections(master, spec)
  const upper = (cells: SheetSpec['cells']) => new Map(Object.entries(cells ?? {}).map(([key, override]) => [key.toUpperCase(), override]))
  const sheets = new Map<number, { master: MasterSheet; spec: SheetSpec; overrides: Map<string, Override> }>([[master.id, { master, spec, overrides: upper(spec.cells) }]])
  for (const child of master.children) sheets.set(child.id, { master: child, spec: spec.sub?.[child.id] ?? {}, overrides: upper(spec.sub?.[child.id]?.cells) })
  const cache = new Map<string, Value>()
  const active = new Set<string>()
  function cell(sheetId: number, key: string): Value {
    const sheet = sheets.get(sheetId)
    if (!sheet) throw new Unsupported(`Sheet ${sheetId}`)
    const cacheKey = `${sheetId}|${key}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)!
    if (active.has(cacheKey)) throw new Unsupported(`Circular ${cacheKey}`)
    active.add(cacheKey)
    try {
      const override = sheet.overrides.get(key)
      const record = sheet.master.cells.get(key) ?? (sheetId === master.id ? appended.get(key) : undefined)
      let result: Value
      if (override) result = override.V
      else if (key === 'HIDETEXT' && !record) result = 0
      else if (!record) throw new Unsupported(`Missing ${key}`)
      else if (!record.F || record.F === 'No Formula') result = numeric(record.V)
      else {
        try { result = evaluate(parseFormula(record.F), sheetId) } catch (error) {
          if (!(error instanceof Unsupported)) throw error
          if (PLACEMENT.test(key)) throw new Error(`Native ${key} formula cannot be evaluated (${error.message}); refusing a stale master cache.`)
          result = numeric(record.V)
        }
        // Unchanged master text with the same line layout: Visio's own cached font measurement is exact, ours is approximate.
        if (/TEXT(HEIGHT|WIDTH)\(/i.test(record.F) && sheet.spec.text === undefined && !sheet.overrides.size && typeof result === 'number'
          && Math.abs(result - Number(record.V)) <= 0.01 * Math.abs(Number(record.V))) result = Number(record.V)
      }
      cache.set(cacheKey, result)
      return result
    } finally { active.delete(cacheKey) }
  }
  const numeric = (value: string): Value => (value !== '' && Number.isFinite(Number(value)) ? Number(value) : value)
  const number = (value: Value): number => {
    if (typeof value === 'number') return value
    if (/^true$/i.test(value)) return 1
    if (/^false$/i.test(value)) return 0
    throw new Unsupported(`Non-numeric ${value}`)
  }
  function text(sheetId: number) {
    const sheet = sheets.get(sheetId)!
    return sheet.spec.text ?? sheet.master.text
  }
  function margins(sheetId: number, names: string[]) {
    return names.reduce((total, name) => { try { return total + number(cell(sheetId, name)) } catch { return total + 1 / 18 } }, 0)
  }
  function evaluate(node: Node, sheetId: number): Value {
    switch (node.t) {
      case 'num': return node.v
      case 'str': return node.v
      case 'un': return node.op === '-' ? -number(evaluate(node.a, sheetId)) : number(evaluate(node.a, sheetId))
      case 'bin': {
        const left = evaluate(node.a, sheetId), right = evaluate(node.b, sheetId)
        if (node.op === '&') return String(left) + String(right)
        if (['=', '<>'].includes(node.op) && (typeof left === 'string' || typeof right === 'string')) return (String(left) === String(right)) === (node.op === '=') ? 1 : 0
        const a = number(left), b = number(right)
        switch (node.op) {
          case '+': return a + b
          case '-': return a - b
          case '*': return a * b
          case '/': if (b === 0) throw new Unsupported('Divide by zero'); return a / b
          case '^': return a ** b
          case '=': return Math.abs(a - b) < 1e-12 ? 1 : 0
          case '<>': return Math.abs(a - b) >= 1e-12 ? 1 : 0
          case '<': return a < b ? 1 : 0
          case '>': return a > b ? 1 : 0
          case '<=': return a <= b ? 1 : 0
          case '>=': return a >= b ? 1 : 0
        }
        throw new Unsupported(node.op)
      }
      case 'ref': {
        const target = node.sheet ? Number(node.sheet.slice(6)) : sheetId
        const name = node.name.toUpperCase()
        if (name === 'TRUE') return 1
        if (name === 'FALSE') return 0
        if (name === 'DROPONPAGESCALE') return 1
        if (name === 'THETEXT') return text(target)
        return cell(target, normalizeReference(node.name))
      }
      case 'sheetCall': throw new Unsupported('Sheet function reference')
      case 'call': {
        const args = node.args
        const arg = (index: number) => evaluate(args[index], sheetId)
        const num = (index: number) => number(arg(index))
        switch (node.name) {
          case 'GUARD': case 'THEMEGUARD': case 'SETATREFEXPR': case 'SETATREF': case 'SETATREFEVAL': return arg(0)
          case 'IF': return num(0) ? arg(1) : args.length > 2 ? arg(2) : 0
          case 'IFERROR': try { return arg(0) } catch (error) { if (error instanceof Unsupported) return arg(1); throw error }
          case 'NOT': return num(0) ? 0 : 1
          case 'AND': return args.every((_, index) => num(index)) ? 1 : 0
          case 'OR': return args.some((_, index) => num(index)) ? 1 : 0
          case 'MAX': return Math.max(...args.map((_, index) => num(index)))
          case 'MIN': return Math.min(...args.map((_, index) => num(index)))
          case 'ABS': return Math.abs(num(0))
          case 'SQRT': return Math.sqrt(num(0))
          case 'ATAN2': return Math.atan2(num(0), num(1))
          case 'COS': return Math.cos(num(0))
          case 'SIN': return Math.sin(num(0))
          case 'INT': return Math.floor(num(0))
          case 'ROUND': return Number(num(0).toFixed(num(1)))
          case 'MODULUS': { const a = num(0), b = num(1); return a - b * Math.floor(a / b) }
          case 'PI': return Math.PI
          case 'BOUND': {
            const value = num(0), bounds = args.slice(3).map((_, index) => num(index + 3))
            return bounds.length >= 2 ? Math.min(Math.max(value, bounds[0]), bounds[1]) : value
          }
          case 'STRSAME': return String(arg(0)).localeCompare(String(arg(1)), undefined, { sensitivity: args.length > 2 && num(2) ? 'accent' : 'variant' }) === 0 ? 1 : 0
          case 'SHAPETEXT': return text(sheetId)
          case 'LISTORDER': if (spec.listOrder === undefined) throw new Unsupported('LISTORDER'); return spec.listOrder
          case 'TEXTWIDTH': {
            const size = number(cell(sheetId, 'CHAR.SIZE'))
            return measureText(String(arg(0)), size, Infinity, margins(sheetId, ['LEFTMARGIN', 'RIGHTMARGIN'])).width
          }
          case 'TEXTHEIGHT': {
            const size = number(cell(sheetId, 'CHAR.SIZE'))
            const content = String(arg(0))
            const horizontal = margins(sheetId, ['LEFTMARGIN', 'RIGHTMARGIN'])
            const vertical = margins(sheetId, ['TOPMARGIN', 'BOTTOMMARGIN'])
            return measureText(content, size, num(1), horizontal).height - horizontal + vertical
          }
        }
        throw new Unsupported(node.name)
      }
    }
  }
  return { cell, sheets, appended }
}

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;')
export function escapeXml(value: string): string { return escape(value) }
const format = (value: Value) => (typeof value === 'number' ? String(Number(value.toPrecision(15))) : value)

function inferLocation(master: MasterSheet, name: string): Location {
  const parts = name.split('.')
  if (parts.length === 1) return { cell: name }
  if (parts.length === 2 && /^(?:Char|Para)$/i.test(parts[0])) return { section: /^Char$/i.test(parts[0]) ? 'Character' : 'Paragraph', sectionIX: 0, row: '0', rowIsIX: true, cell: parts[1] }
  if (parts.length === 3) {
    const sibling = [...master.cells.values()].find((record) => record.location.row?.toUpperCase() === parts[1].toUpperCase()
      && sectionKey(record.location.section!, 0, 'x', false, 'x')[0].split('.')[0] === parts[0].toUpperCase())
    if (sibling) return { ...sibling.location, cell: parts[2] }
  }
  throw new Error(`Override ${name} has no master row.`)
}

function sheetXml(master: MasterSheet, spec: SheetSpec, values: (key: string) => Value, extra: string, appendedRows = ''): string {
  const emitted: { record: CellRecord; V: string; F?: string }[] = []
  const overrides = new Map(Object.entries(spec.cells ?? {}).map(([name, override]) => [name.toUpperCase(), { name, override }]))
  for (const [key, { name, override }] of overrides) {
    const record = master.cells.get(key)
    emitted.push({ record: record ?? { key, location: inferLocation(master, name), V: '' }, V: format(override.V), F: override.F })
  }
  for (const key of master.order) {
    const record = master.cells.get(key)
    if (overrides.has(key) || !record?.F || record.F === 'No Formula') continue
    const value = values(key)
    const original = Number(record.V)
    if (typeof value === 'number' && Number.isFinite(original) && Math.abs(value - original) > 1e-9) emitted.push({ record, V: format(value), F: 'Inh' })
  }
  const cellXml = (entry: (typeof emitted)[number]) => `<Cell N='${entry.record.location.cell}' V='${escape(entry.V)}'${entry.F ? ` F='${escape(entry.F)}'` : ''}/>`
  let xml = emitted.filter((entry) => !entry.record.location.section).map(cellXml).join('')
  const sections = new Map<string, (typeof emitted)>()
  for (const entry of emitted.filter((candidate) => candidate.record.location.section)) {
    const location = entry.record.location
    const id = `${location.section}|${location.sectionIX}`
    sections.set(id, [...(sections.get(id) ?? []), entry])
  }
  for (const [id, entries] of sections) {
    const [name, sectionIX] = id.split('|')
    const indexed = name === 'Geometry'
    xml += `<Section N='${name}'${indexed ? ` IX='${sectionIX}'` : ''}>`
    xml += entries.filter((entry) => entry.record.location.row === undefined).map(cellXml).join('')
    const rows = new Map<string, (typeof emitted)>()
    for (const entry of entries.filter((candidate) => candidate.record.location.row !== undefined)) rows.set(entry.record.location.row!, [...(rows.get(entry.record.location.row!) ?? []), entry])
    for (const [row, rowEntries] of rows) {
      const location = rowEntries[0].record.location
      xml += `<Row${location.rowT ? ` T='${location.rowT}'` : ''} ${location.rowIsIX ? 'IX' : 'N'}='${escape(row)}'>${rowEntries.map(cellXml).join('')}</Row>`
    }
    if (name === 'Connection') xml += appendedRows
    xml += spec.rows?.[id] ?? ''
    xml += '</Section>'
  }
  if (appendedRows && !sections.has('Connection|0')) xml += `<Section N='Connection'>${appendedRows}</Section>`
  for (const [id, rows] of Object.entries(spec.rows ?? {})) {
    if (sections.has(id)) continue
    const [name, sectionIX] = id.split('|')
    xml += `<Section N='${name}'${name === 'Geometry' ? ` IX='${sectionIX}'` : ''}>${rows}</Section>`
  }
  if (spec.textXml !== undefined) xml += `<Text>${spec.textXml}</Text>`
  else if (spec.text !== undefined) xml += `<Text>${escape(spec.text)}</Text>`
  return xml + extra
}

export function resolveInstance(spec: InstanceSpec, nextId: () => number): ResolvedInstance {
  const master = masterSheet(spec.master, spec.template)
  const { cell, appended } = evaluator(master, spec)
  const childIds = new Map(master.children.map((child) => [child.id, nextId()]))
  const value = (key: string, subId = master.id) => {
    const result = cell(subId, key.toUpperCase())
    if (typeof result !== 'number') throw new Error(`Native cell ${key} is not numeric.`)
    return result
  }
  const point = (row: number): [number, number] => {
    const x = value(`CONNECTIONS.X${row + 1}`) - value('LOCPINX'), y = value(`CONNECTIONS.Y${row + 1}`) - value('LOCPINY')
    const angle = master.cells.has('ANGLE') ? value('ANGLE') : 0
    return [value('PINX') + x * Math.cos(angle) - y * Math.sin(angle), value('PINY') + x * Math.sin(angle) + y * Math.cos(angle)]
  }
  const appendedRows = () => {
    let rows = ''
    for (let index = 0; index < appended.size / 2; index++) {
      const [x, y] = [...appended.values()].slice(2 * index, 2 * index + 2)
      rows += `<Row T='Connection' IX='${x.location.row}'>${[x, y].map((record) => `<Cell N='${record.location.cell}' V='${format(value(record.key))}' U='IN' F='${escape(record.F!)}'/>`).join('')}`
        + `<Cell N='DirX' V='0'/><Cell N='DirY' V='0'/><Cell N='Type' V='0'/><Cell N='AutoGen' V='0'/><Cell N='Prompt' V='' F='No Formula'/></Row>`
    }
    return rows
  }
  const xml = () => {
    const children = master.children.map((child) => `<Shape ID='${childIds.get(child.id)}' Type='${child.type}' MasterShape='${child.id}'>`
      + sheetXml(child, spec.sub?.[child.id] ?? {}, (key) => cell(child.id, key), '') + '</Shape>').join('')
    return `<Shape ID='${spec.id}'${spec.nameU ? ` NameU='${escape(spec.nameU)}' Name='${escape(spec.nameU)}'` : ''} Type='${master.type}' Master='${spec.master}'>`
      + sheetXml(master, spec, (key) => cell(master.id, key), children ? `<Shapes>${children}</Shapes>` : '', appendedRows()) + '</Shape>'
  }
  return { spec, value, point, childIds, xml }
}
