import type { LldColumn, LldSchema, LldTable } from './model'
import type { DocRow, DocSection, LldDocument } from './docx'

// descriptions.json: module, functional groups, a common dictionary and per-table column descriptions.
// Underscore keys inside a table entry carry review data: _entity, _uncertain, _display (heading), _required (R/O overrides).
export interface TableDescriptions { _entity?: string; _uncertain?: string[]; _display?: string; _required?: Record<string, 'R' | 'O'>; [column: string]: unknown }
export interface Descriptions {
  module: string
  groups: { title: string; tables: string[] }[]
  common: Record<string, string>
  tables: Record<string, TableDescriptions>
}

// Standard ABP audit wording, always available whatever descriptions.json provides.
export const COMMON_DICTIONARY: Record<string, string> = {
  Id: "{entity}'s unique identifier",
  Creation_Time: 'Date and time the record was created',
  Creator_Id: 'User who created the record',
  Last_Modification_Time: 'Date and time the record was last modified',
  Last_Modifier_Id: 'User who last modified the record',
  Deletion_Time: 'Date and time the record was soft-deleted',
  Deleter_Id: 'User who soft-deleted the record',
  Is_Deleted: 'Whether the record is soft-deleted',
  Concurrency_Stamp: 'Optimistic concurrency token',
  Extra_Properties: 'Extension properties (JSON)',
}

export const VIEWS_TITLE = 'Referenced Views'
export const VIEWS_NOTE = 'Read-only views exposed by other modules and consumed by this module. Nullability is defined by the source module.'
export const OTHER_TITLE = 'Other Tables'

export const words = (value: string) => value.split('_').filter(Boolean)
export const prettify = (value: string) => words(value).join(' ')
function singular(word: string) {
  return /ies$/i.test(word) ? word.slice(0, -3) + 'y' : /(ss|us)$/i.test(word) ? word : /(xes|ches|shes|sses)$/i.test(word) ? word.slice(0, -2) : /s$/i.test(word) ? word.slice(0, -1) : word
}
// "Bills_Timeline" -> "Bill timeline", "Bill_Requests_Revenue_Entries" -> "Bill request revenue entry"; views drop "_View".
export function entityName(table: LldTable) {
  const parts = words(table.name.replace(/_view$/i, '')).map((part) => (/^[A-Z0-9]+$/.test(part) ? part : singular(part)))
  if (!parts.length) return table.name
  return [parts[0], ...parts.slice(1).map((part) => (/^[A-Z0-9]+$/.test(part) ? part : part.toLowerCase()))].join(' ')
}
export const singularWord = singular

const fill = (template: string, entity: string) => template.replace(/\{entity\}/g, entity).replace(/\{entity_lc\}/g, entity.toLowerCase())

export interface ResolvedDescription { text: string; source: 'table' | 'common' | 'reference' | 'lookup' | 'missing'; uncertain: boolean }

export function describeColumn(table: LldTable, column: LldColumn, descriptions: Descriptions, byName: Map<string, LldTable>): ResolvedDescription {
  const entry = descriptions.tables[table.full_name]
  const uncertain = !!entry?._uncertain?.includes(column.name)
  const own = entry?.[column.name]
  if (typeof own === 'string' && own.trim()) return { text: own.trim(), source: 'table', uncertain }
  const entity = typeof entry?._entity === 'string' && entry._entity ? entry._entity : entityName(table)
  const common = descriptions.common[column.name] ?? COMMON_DICTIONARY[column.name]
  if (common) return { text: fill(common, entity), source: 'common', uncertain }
  if (column.fk && column.ref) return { text: `Reference to ${byName.get(column.ref)?.name ?? column.ref.split('.').pop()}`, source: 'reference', uncertain }
  if (/_Lookup_Id$/i.test(column.name)) return { text: `${prettify(column.name.replace(/_Lookup_Id$/i, ''))} (lookup value)`, source: 'lookup', uncertain }
  return { text: '', source: 'missing', uncertain }
}

const FRIENDLY: [RegExp, string | ((match: RegExpMatchArray) => string)][] = [
  [/^bit$/i, 'boolean'], [/^(?:datetime2?(?:\(\d+\))?|smalldatetime|datetimeoffset(?:\(\d+\))?)$/i, 'datetime'], [/^date$/i, 'date'],
  [/^uniqueidentifier$/i, 'guid'], [/^(?:bigint|int|smallint|tinyint)$/i, 'integer'], [/^n?varchar\(max\)$|^n?text$/i, 'text'],
  [/^n?(?:var)?char\((\d+)\)$/i, (match) => `string(${match[1]})`],
]
export function friendlyType(type: string) {
  for (const [pattern, replacement] of FRIENDLY) {
    const match = type.trim().match(pattern)
    if (match) return typeof replacement === 'string' ? replacement : replacement(match)
  }
  return type
}

export function dataType(column: LldColumn, friendly = false) {
  const tags = [column.pk ? 'PK' : '', column.fk ? 'FK' : '', column.unique ? 'UK' : ''].filter(Boolean)
  const type = friendly ? friendlyType(column.type) : column.type
  return tags.length ? `${type} (${tags.join(', ')})` : type
}

export interface BuildOptions { includeViews: boolean; friendlyTypes: boolean }
export interface MissingDescription { table: string; column: string }

// Groups in descriptions order, then ungrouped tables under "Other Tables", then views under "Referenced Views".
export function buildDocument(schema: LldSchema, descriptions: Descriptions, options: BuildOptions): { document: LldDocument; missing: MissingDescription[]; uncertain: MissingDescription[] } {
  const byName = new Map(schema.tables.map((table) => [table.full_name, table]))
  const missing: MissingDescription[] = [], uncertain: MissingDescription[] = []
  const placed = new Set<string>()
  const toTable = (table: LldTable) => {
    const entry = descriptions.tables[table.full_name]
    const rows: DocRow[] = table.columns.map((column) => {
      const description = describeColumn(table, column, descriptions, byName)
      if (description.source === 'missing') missing.push({ table: table.full_name, column: column.name })
      if (description.uncertain) uncertain.push({ table: table.full_name, column: column.name })
      const override = entry?._required?.[column.name]
      const ro = table.kind === 'view' ? '-' : override ?? (column.required ? 'R' : 'O')
      return { field: column.name, dataType: dataType(column, options.friendlyTypes), ro, description: description.text }
    })
    return { displayName: typeof entry?._display === 'string' && entry._display.trim() ? entry._display.trim() : prettify(table.name), fullName: table.full_name, rows }
  }
  const sections: DocSection[] = []
  for (const group of descriptions.groups) {
    const tables = group.tables.map((name) => byName.get(name)).filter((table): table is LldTable => !!table && table.kind === 'table' && !placed.has(table.full_name))
    tables.forEach((table) => placed.add(table.full_name))
    sections.push({ title: group.title, tables: tables.map(toTable) })
  }
  const rest = schema.tables.filter((table) => table.kind === 'table' && !placed.has(table.full_name))
  if (rest.length) sections.push({ title: OTHER_TITLE, tables: rest.map(toTable) })
  const views = schema.tables.filter((table) => table.kind === 'view')
  if (options.includeViews && views.length) {
    const order = descriptions.groups.flatMap((group) => group.tables)
    views.sort((first, second) => (order.indexOf(first.full_name) + 1 || Infinity) - (order.indexOf(second.full_name) + 1 || Infinity))
    sections.push({ title: VIEWS_TITLE, note: VIEWS_NOTE, tables: views.map(toTable) })
  }
  return { document: { module: descriptions.module, source: schema.source, sections: sections.filter((section) => section.tables.length) }, missing, uncertain }
}

// descriptions.json from a file: shape-checked so a malformed upload never reaches the renderer.
export function readDescriptions(json: string): Descriptions {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('descriptions.json is not valid JSON.') }
  const data = value as Partial<Descriptions>
  const isText = (entry: unknown): entry is string => typeof entry === 'string'
  if (!data || typeof data !== 'object' || !isText(data.module)) throw new Error('descriptions.json needs a "module" name.')
  const groups = Array.isArray(data.groups) ? data.groups : []
  if (groups.some((group) => !group || !isText(group.title) || !Array.isArray(group.tables) || !group.tables.every(isText))) throw new Error('Each group needs a "title" and a "tables" list.')
  const common = data.common && typeof data.common === 'object' ? data.common : {}
  if (Object.values(common).some((entry) => !isText(entry))) throw new Error('"common" descriptions must be text.')
  const tables = data.tables && typeof data.tables === 'object' ? data.tables : {}
  for (const [name, entry] of Object.entries(tables)) {
    if (!entry || typeof entry !== 'object') throw new Error(`Descriptions of ${name} must be an object.`)
    for (const [key, item] of Object.entries(entry)) {
      if (key === '_uncertain' ? !Array.isArray(item) || !item.every(isText) : key === '_required' ? !item || typeof item !== 'object' || Object.values(item).some((ro) => ro !== 'R' && ro !== 'O') : !isText(item)) {
        throw new Error(`Invalid "${key}" in the descriptions of ${name}.`)
      }
    }
  }
  return { module: data.module, groups: groups.map((group) => ({ title: group.title, tables: [...group.tables] })), common: { ...common }, tables: JSON.parse(JSON.stringify(tables)) }
}
