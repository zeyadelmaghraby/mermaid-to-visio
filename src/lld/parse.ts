import JSZip from 'jszip'
import type { LldColumn, LldLooseConnector, LldRelationship, LldTable, ParsedErd } from './model'
import { similarity } from './similarity'

const NS = 'http://schemas.microsoft.com/office/visio/2012/main'
const BOLD = 1
export const FK_MATCH_THRESHOLD = 0.75

const children = (element: Element, name: string) => Array.from(element.children).filter((child) => child.localName === name && child.namespaceURI === NS)
const child = (element: Element, name: string) => children(element, name)[0]

// Shape text with the Character row active at every character: <cp IX="n"/> switches rows mid-line, even mid-key.
interface StyledText { text: string; styles: number[] }
function styledText(shape: Element, masterStyles: Map<number, number>): StyledText {
  const rows = new Map(masterStyles)
  const section = children(shape, 'Section').find((entry) => entry.getAttribute('N') === 'Character')
  for (const row of section ? children(section, 'Row') : []) {
    const style = children(row, 'Cell').find((cell) => cell.getAttribute('N') === 'Style')
    if (style) rows.set(Number(row.getAttribute('IX') ?? 0), Number(style.getAttribute('V')))
  }
  const text = child(shape, 'Text')
  let content = '', current = 0
  const styles: number[] = []
  const append = (value: string | null) => {
    for (const character of value ?? '') { content += character; styles.push(rows.get(current) ?? 0) }
  }
  for (const node of text ? Array.from(text.childNodes) : []) {
    if (node.nodeType === 3 || node.nodeType === 4) append(node.nodeValue)
    else if (node.nodeType === 1 && (node as Element).localName === 'cp') current = Number((node as Element).getAttribute('IX') ?? 0)
  }
  return { text: content, styles }
}

// Character Style of each master sub-shape, used where an instance inherits its row from the master.
async function masterCharacterStyles(zip: JSZip) {
  const styles = new Map<string, Map<number, number>>()
  const parser = new DOMParser()
  const masters = await mastersIndex(zip, parser)
  for (const name of Object.keys(zip.files).filter((entry) => /^visio\/masters\/master\d+\.xml$/.test(entry))) {
    const doc = parser.parseFromString(await zip.file(name)!.async('string'), 'application/xml')
    const masterId = masters.get(name.replace('visio/masters/', ''))
    if (masterId === undefined) continue
    for (const shape of Array.from(doc.getElementsByTagNameNS(NS, 'Shape'))) {
      const rows = new Map<number, number>()
      const section = children(shape, 'Section').find((entry) => entry.getAttribute('N') === 'Character')
      for (const row of section ? children(section, 'Row') : []) {
        const style = children(row, 'Cell').find((cell) => cell.getAttribute('N') === 'Style')
        if (style) rows.set(Number(row.getAttribute('IX') ?? 0), Number(style.getAttribute('V')))
      }
      styles.set(`${masterId}|${shape.getAttribute('ID')}`, rows)
    }
  }
  return styles
}

// Master file name -> master ID, from masters.xml and its relationships.
async function mastersIndex(zip: JSZip, parser: DOMParser) {
  const map = new Map<string, string>()
  const rels = zip.file('visio/masters/_rels/masters.xml.rels'), masters = zip.file('visio/masters/masters.xml')
  if (rels && masters) {
    const targets = new Map(Array.from(parser.parseFromString(await rels.async('string'), 'application/xml').getElementsByTagName('Relationship'))
      .map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]))
    for (const master of Array.from(parser.parseFromString(await masters.async('string'), 'application/xml').getElementsByTagNameNS(NS, 'Master'))) {
      const rel = Array.from(master.getElementsByTagNameNS(NS, 'Rel'))[0]
      const id = rel?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      const target = id ? targets.get(id) : undefined
      if (target) map.set(target, master.getAttribute('ID')!)
    }
  }
  return map
}

function parseColumns(body: StyledText, view: boolean): LldColumn[] {
  const columns: LldColumn[] = []
  let offset = 0
  for (const line of body.text.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const nameIndex = parts.length >= 3 ? 1 : 0
    const key = parts.length >= 3 ? parts[0].trim() : ''
    const name = parts[nameIndex].trim()
    const type = (parts.length >= 3 ? parts.slice(2).join('\t') : parts[1]).trim()
    if (!name) continue
    const keys = key.split(/[\s,]+/).filter(Boolean)
    const pk = keys.includes('PK'), fk = keys.some((entry) => entry.startsWith('FK')), unique = keys.some((entry) => /^U\d*$/.test(entry))
    // NOT NULL columns are drawn bold: the style of the first non-space character of the name decides.
    const nameStart = start + parts.slice(0, nameIndex).reduce((total, part) => total + part.length + 1, 0) + (parts[nameIndex].length - parts[nameIndex].trimStart().length)
    const bold = ((body.styles[nameStart] ?? 0) & BOLD) === BOLD
    columns.push({ name, type, keys, pk, fk, unique, required: view ? null : pk || bold })
  }
  return columns
}

const normalize = (value: string) => value.replace(/_?Id$/i, '').toLowerCase().replace(/_/g, '')
function candidates(table: string) {
  const forms = [table, table.replace(/s$/i, ''), table.replace(/^([A-Za-z]+?)s_/, '$1_')]
  return [...new Set(forms.map((form) => form.toLowerCase().replace(/_/g, '')))]
}

// FK column -> parent table: the child's parent whose (singular) name is most similar to the column, if >= 0.75.
export function resolveReference(column: string, parents: LldTable[]): string | undefined {
  const target = normalize(column)
  let best: { table: string; score: number } | undefined
  for (const parent of parents) {
    for (const form of candidates(parent.name)) {
      const score = similarity(target, form)
      if (!best || score > best.score) best = { table: parent.full_name, score }
    }
  }
  return best && best.score >= FK_MATCH_THRESHOLD ? best.table : undefined
}

export async function parseErd(bytes: ArrayBuffer | Uint8Array, source: string): Promise<ParsedErd> {
  let zip: JSZip
  try { zip = await JSZip.loadAsync(bytes) } catch { throw new Error('This file is not a Visio .vsdx drawing.') }
  const pageFiles = Object.keys(zip.files).filter((name) => /^visio\/pages\/page\d+\.xml$/.test(name))
    .sort((first, second) => Number(first.match(/(\d+)\.xml$/)![1]) - Number(second.match(/(\d+)\.xml$/)![1]))
  if (!pageFiles.length) throw new Error('The .vsdx file has no pages.')
  const parser = new DOMParser()
  const pageNames = await pageNameIndex(zip, parser)
  const masterStyles = await masterCharacterStyles(zip)
  const tables: LldTable[] = []
  const relationships: LldRelationship[] = []
  const looseConnectors: LldLooseConnector[] = []
  for (const file of pageFiles) {
    const doc = parser.parseFromString(await zip.file(file)!.async('string'), 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) throw new Error(`${file} is not well-formed XML.`)
    const page = pageNames.get(file.replace('visio/pages/', '')) ?? file.replace(/^visio\/pages\/|\.xml$/g, '')
    const root = doc.documentElement
    const shapes = child(root, 'Shapes')
    const owner = new Map<string, string>()
    for (const shape of shapes ? children(shapes, 'Shape') : []) {
      const nested = child(shape, 'Shapes')
      const parts = nested ? children(nested, 'Shape') : []
      if (parts.length < 2) continue
      const master = shape.getAttribute('Master')
      const inherited = (part: Element) => masterStyles.get(`${master}|${part.getAttribute('MasterShape')}`) ?? new Map<number, number>()
      const fullName = styledText(parts[0], inherited(parts[0])).text.trim()
      const body = styledText(parts[1], inherited(parts[1]))
      if (!body.text.includes('\t') || !fullName) continue
      const dot = fullName.lastIndexOf('.')
      const view = (shape.getAttribute('NameU') ?? '').startsWith('View') || /_view$/i.test(fullName)
      const table: LldTable = { id: shape.getAttribute('ID')!, page, full_name: fullName, schema: dot >= 0 ? fullName.slice(0, dot) : '', name: dot >= 0 ? fullName.slice(dot + 1) : fullName,
        kind: view ? 'view' : 'table', columns: parseColumns(body, view) }
      tables.push(table)
      for (const element of [shape, ...Array.from(shape.getElementsByTagNameNS(NS, 'Shape'))]) owner.set(element.getAttribute('ID')!, fullName)
    }
    const connects = child(root, 'Connects')
    const ends = new Map<string, { parent?: string; child?: string }>()
    for (const connect of connects ? children(connects, 'Connect') : []) {
      const from = connect.getAttribute('FromSheet')!, cell = connect.getAttribute('FromCell')
      if (cell !== 'BeginX' && cell !== 'EndX') continue
      const entry = ends.get(from) ?? {}
      ends.set(from, entry)
      const entity = owner.get(connect.getAttribute('ToSheet')!)
      if (cell === 'BeginX') entry.parent = entity
      else entry.child = entity
    }
    for (const [id, { parent, child: childName }] of ends) {
      if (parent && childName) relationships.push({ parent, child: childName })
      else looseConnectors.push({ id, page, parent, child: childName })
    }
  }
  const byName = new Map(tables.map((table) => [table.full_name, table]))
  for (const table of tables) {
    const parents = [...new Set(relationships.filter((relationship) => relationship.child === table.full_name).map((relationship) => relationship.parent))]
      .map((name) => byName.get(name)!).filter(Boolean)
    for (const column of table.columns.filter((entry) => entry.fk)) {
      const ref = resolveReference(column.name, parents)
      if (ref) column.ref = ref
    }
  }
  return { source, tables, relationships, looseConnectors }
}

async function pageNameIndex(zip: JSZip, parser: DOMParser) {
  const names = new Map<string, string>()
  const pages = zip.file('visio/pages/pages.xml'), rels = zip.file('visio/pages/_rels/pages.xml.rels')
  if (!pages || !rels) return names
  const targets = new Map(Array.from(parser.parseFromString(await rels.async('string'), 'application/xml').getElementsByTagName('Relationship'))
    .map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]))
  for (const page of Array.from(parser.parseFromString(await pages.async('string'), 'application/xml').getElementsByTagNameNS(NS, 'Page'))) {
    const rel = Array.from(page.getElementsByTagNameNS(NS, 'Rel'))[0]
    const id = rel?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const target = id ? targets.get(id) : undefined
    if (target) names.set(target, page.getAttribute('NameU') ?? page.getAttribute('Name') ?? target)
  }
  return names
}
