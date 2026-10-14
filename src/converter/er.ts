import mermaid from 'mermaid'
import { serializedMermaid } from './sequence'

export type Cardinality = 'one' | 'zeroOrOne' | 'oneOrMore' | 'zeroOrMore'
export interface ErColumn { name: string; type: string; pk: boolean; fk?: number; unique?: number; notNull: boolean }
export interface ErEntity { id: string; name: string; view: boolean; columns: ErColumn[] }
// Visio relationships run from the parent ("one" side) to the child, whose end shows the crow's foot.
export interface ErRelationship { parent: string; child: string; parentOptional: boolean; childCardinality: Cardinality; identifying: boolean; label: string }
export interface ErModel { kind: 'er'; direction: 'TB' | 'LR'; entities: ErEntity[]; relationships: ErRelationship[] }

interface RawAttribute { type: string; name: string; keys: string[]; comment: string }
interface RawEntity { id: string; label: string; alias: string; attributes: RawAttribute[]; cssClasses?: string; cssStyles?: string[] }
interface RawRelationship { entityA: string; entityB: string; roleA: string; relSpec: { cardA: string; cardB: string; relType: string } }
interface ErDB {
  getEntities(): Map<string, RawEntity>
  getRelationships(): RawRelationship[]
  getDirection?(): string
  getClasses?(): Map<string, unknown>
}

export const ER_LIMITS = { source: 100_000, entities: 200, relationships: 400, columns: 300, name: 128 } as const
const CARDINALITY: Record<string, Cardinality> = { ONLY_ONE: 'one', ZERO_OR_ONE: 'zeroOrOne', ONE_OR_MORE: 'oneOrMore', ZERO_OR_MORE: 'zeroOrMore' }

function validateSource(source: string) {
  if (!source.trim() || source.length > ER_LIMITS.source) throw new Error('Enter an ER diagram of at most 100,000 characters.')
  if (/%%\s*\{|^\s*---|@\{|\b(?:javascript|data)\s*:/im.test(source)) throw new Error('Directives, frontmatter, metadata and external content are unsupported.')
  if (/<[^>]*>/.test(source) || Array.from(source).some((character) => {
    const code = character.codePointAt(0)!
    return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
  })) throw new Error('Only plain text is supported in ER diagrams; HTML is forbidden.')
  const statements = source.replace(/%%[^\n]*/g, '').split('\n').map((line) => line.trim())
  if (statements.find((line) => line)?.toLowerCase() !== 'erdiagram') throw new Error('Only erDiagram is supported here.')
  if (statements.some((line) => /^(?:style|classDef|title|accTitle|accDescr)\b/i.test(line))) throw new Error('Styling (style, classDef) and diagram titles are unsupported; use :::view to mark views.')
}

// Column comments carry the Visio-only details Mermaid has no syntax for: NOT NULL and explicit FKn / Un group numbers.
function commentFlags(comment: string, entity: string, column: string) {
  const text = comment.trim()
  const notNull = /\bNOT\s+NULL\b/i.test(text)
  const fk = text.match(/\bFK(\d{1,2})\b/i), unique = text.match(/\bU(\d{1,2})\b/i)
  if ((fk && Number(fk[1]) < 1) || (unique && Number(unique[1]) < 1)) throw new Error(`Key numbers start at 1 (${entity}.${column}).`)
  return { notNull, fk: fk ? Number(fk[1]) : undefined, unique: unique ? Number(unique[1]) : undefined }
}

function numbered(columns: { explicit?: number; set: (value: number) => void }[]) {
  const used = new Set(columns.map((column) => column.explicit).filter((value): value is number => value !== undefined))
  let next = 1
  for (const column of columns) {
    if (column.explicit !== undefined) { column.set(column.explicit); continue }
    while (used.has(next)) next++
    used.add(next)
    column.set(next)
  }
}

function toEntity(key: string, raw: RawEntity): ErEntity {
  const name = (raw.alias || key).trim()
  if (!name || name.length > ER_LIMITS.name) throw new Error(`Use entity names of 1 to ${ER_LIMITS.name} characters (${key}).`)
  const classes = (raw.cssClasses ?? '').split(/\s+/).filter((value) => value && value !== 'default')
  if (classes.some((value) => value !== 'view') || raw.cssStyles?.length) throw new Error(`Only the view class is supported (${name}).`)
  const view = classes.includes('view')
  if (raw.attributes.length > ER_LIMITS.columns) throw new Error(`Use at most ${ER_LIMITS.columns} columns per entity (${name}).`)
  const seen = new Set<string>()
  const draft = raw.attributes.map((attribute) => {
    const column = attribute.name.trim()
    if (seen.has(column.toLowerCase())) throw new Error(`Duplicate column ${name}.${column}.`)
    seen.add(column.toLowerCase())
    const keys = attribute.keys.map((value) => value.toUpperCase())
    if (keys.some((value) => !['PK', 'FK', 'UK'].includes(value))) throw new Error(`Unsupported key on ${name}.${column}; use PK, FK or UK.`)
    if (view && keys.length) throw new Error(`Views have no key column; remove PK/FK/UK from ${name}.${column}.`)
    const flags = commentFlags(attribute.comment ?? '', name, column)
    if (flags.fk !== undefined && !keys.includes('FK')) throw new Error(`${name}.${column} names FK${flags.fk} in its comment but is not marked FK.`)
    if (flags.unique !== undefined && !keys.includes('UK')) throw new Error(`${name}.${column} names U${flags.unique} in its comment but is not marked UK.`)
    return { keys, flags, column: { name: column, type: attribute.type.trim(), pk: keys.includes('PK'), notNull: flags.notNull || keys.includes('PK') } as ErColumn }
  })
  numbered(draft.filter((entry) => entry.keys.includes('FK')).map((entry) => ({ explicit: entry.flags.fk, set: (value: number) => { entry.column.fk = value } })))
  numbered(draft.filter((entry) => entry.keys.includes('UK')).map((entry) => ({ explicit: entry.flags.unique, set: (value: number) => { entry.column.unique = value } })))
  const columns = draft.map((entry) => entry.column)
  // The template's primary-key compartment sits above the separator line.
  return { id: key, name, view, columns: [...columns.filter((column) => column.pk), ...columns.filter((column) => !column.pk)] }
}

async function parseUnlocked(source: string): Promise<ErModel> {
  validateSource(source)
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: ER_LIMITS.source,
    suppressErrorRendering: true, secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'secure', 'suppressErrorRendering'],
    theme: 'base', fontFamily: 'Calibri',
    themeVariables: { fontFamily: 'Calibri', fontSize: '10pt', primaryColor: '#D9D9D9', primaryBorderColor: '#000000',
      primaryTextColor: '#000000', lineColor: '#000000', textColor: '#000000', tertiaryColor: '#FFFFFF',
      attributeBackgroundColorOdd: '#FFFFFF', attributeBackgroundColorEven: '#FFFFFF' },
    er: { useMaxWidth: false } })
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
  if (diagram.type !== 'er') throw new Error('Only erDiagram is supported here.')
  const db = diagram.db as unknown as ErDB
  if (db.getClasses?.().size) throw new Error('classDef styling is unsupported; use :::view to mark views.')
  const direction = (db.getDirection?.() ?? 'TB').toUpperCase()
  if (direction !== 'TB' && direction !== 'LR') throw new Error('Use direction TB (default) or LR.')
  const raw = [...db.getEntities()]
  if (!raw.length || raw.length > ER_LIMITS.entities) throw new Error(`Use between 1 and ${ER_LIMITS.entities} entities.`)
  const entities = raw.map(([key, entity]) => toEntity(key, entity))
  const names = new Set<string>()
  for (const entity of entities) {
    if (names.has(entity.name.toLowerCase())) throw new Error(`Duplicate entity name ${entity.name}.`)
    names.add(entity.name.toLowerCase())
  }
  const byInternal = new Map(raw.map(([key, entity]) => [entity.id, key]))
  const relationships = db.getRelationships().map((relationship): ErRelationship => {
    const a = byInternal.get(relationship.entityA), b = byInternal.get(relationship.entityB)
    if (!a || !b) throw new Error('Relationship references an unknown entity.')
    // Mermaid stores the marker drawn next to entity B as cardA and the marker next to entity A as cardB.
    const atA = CARDINALITY[relationship.relSpec.cardB], atB = CARDINALITY[relationship.relSpec.cardA]
    if (!atA || !atB) throw new Error(`Unsupported cardinality between ${a} and ${b}.`)
    const single = (value: Cardinality) => value === 'one' || value === 'zeroOrOne'
    const label = (relationship.roleA ?? '').trim()
    if (label.length > 200) throw new Error('Use relationship labels of at most 200 characters.')
    const identifying = relationship.relSpec.relType === 'IDENTIFYING'
    if (single(atA)) return { parent: a, child: b, parentOptional: atA === 'zeroOrOne', childCardinality: atB, identifying, label }
    if (single(atB)) return { parent: b, child: a, parentOptional: atB === 'zeroOrOne', childCardinality: atA, identifying, label }
    throw new Error(`Many-to-many relationship between ${a} and ${b}: add an associative table, as in a physical ERD.`)
  })
  if (relationships.length > ER_LIMITS.relationships) throw new Error(`Use at most ${ER_LIMITS.relationships} relationships.`)
  return { kind: 'er', direction, entities, relationships }
}

export function parseEr(source: string): Promise<ErModel> {
  return serializedMermaid(() => parseUnlocked(source))
}

export function prepareEr(source: string, renderId: string): Promise<{ svg: string; model: ErModel }> {
  return serializedMermaid(async () => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(renderId)) throw new Error('Invalid render ID.')
    const model = await parseUnlocked(source)
    const { svg } = await mermaid.mermaidAPI.render(renderId, source)
    return { svg, model }
  })
}
