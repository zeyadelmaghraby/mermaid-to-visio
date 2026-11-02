import type { LldColumn, LldSchema, LldTable } from './model'
import { COMMON_DICTIONARY, entityName, prettify, singularWord, words, type Descriptions, type TableDescriptions } from './descriptions'

// Deterministic descriptions.json from the ERD alone (no AI): short possessive phrases in the template's style.
// Columns whose meaning the name does not make clear get a neutral phrase and are listed in _uncertain.
const lower = (value: string) => words(value).map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase())).join(' ')
const SIMPLE = new Set(['name', 'description', 'amount', 'status', 'type', 'category', 'reference', 'remarks', 'notes', 'email', 'phone', 'mobile',
  'currency', 'title', 'address', 'country', 'city', 'quantity', 'price', 'rate', 'balance', 'version', 'value', 'url', 'channel', 'priority', 'comment', 'comments', 'reason'])
// Name endings whose meaning is clear on their own: Due_Date, Beneficiary_Name, Credit_Amount.
const CLEAR_SUFFIX = new Set(['date', 'time', 'code', 'number', 'no', 'count', 'amount', 'name', 'type', 'status', 'description', 'label', 'percentage', 'email', 'phone', 'mobile', 'address', 'currency'])

export function moduleName(source: string) {
  const base = source.replace(/^.*[\\/]/, '').replace(/\.vsdx$/i, '').replace(/[\s_-]*ERD$/i, '').replace(/[_-]+/g, ' ').trim()
  return base || 'Database'
}

function describe(table: LldTable, column: LldColumn, byName: Map<string, LldTable>): { text?: string; uncertain: boolean } {
  if (COMMON_DICTIONARY[column.name]) return { uncertain: false }
  const entity = entityName(table), entityLower = entity.toLowerCase()
  const parts = words(column.name)
  // Drop a leading entity word: Bill_Number in Bills is the bill's number.
  const entityWords = words(table.name.replace(/_view$/i, '')).map((word) => singularWord(word).toLowerCase())
  const rest = parts.length > 1 && singularWord(parts[0]).toLowerCase() === entityWords[0] ? parts.slice(1) : parts
  const phrase = lower(rest.join('_'))
  if (column.fk && column.ref) {
    const parent = byName.get(column.ref)
    return { text: `${parent ? entityName(parent) : prettify(column.ref.split('.').pop()!)} that the ${entityLower} belongs to (ref. ${parent?.name ?? column.ref})`, uncertain: false }
  }
  if (/_Lookup_Id$/i.test(column.name)) return { text: `${entity}'s ${lower(rest.join('_').replace(/_?Lookup_Id$/i, '')) || 'value'} (lookup value)`, uncertain: false }
  if (column.fk) return { text: `Reference to the related ${lower(column.name.replace(/_?Id$/i, ''))}`, uncertain: true }
  const last = rest[rest.length - 1]?.toLowerCase() ?? ''
  const head = lower(rest.slice(0, -1).join('_'))
  if (/^(?:Ar|En)$/i.test(rest[rest.length - 1] ?? '') && rest.length > 1) return { text: `${entity}'s ${head} in ${/^ar$/i.test(last) ? 'Arabic' : 'English'}`, uncertain: false }
  if (/^(?:is|has|can|allow|allows)$/i.test(rest[0] ?? '') && rest.length > 1) {
    const verb = rest[0].toLowerCase() === 'has' ? 'has' : rest[0].toLowerCase() === 'can' ? 'can' : rest[0].toLowerCase() === 'is' ? 'is' : 'allows'
    return { text: `Whether the ${entityLower} ${verb} ${lower(rest.slice(1).join('_'))}`, uncertain: false }
  }
  if (last === 'at' && rest.length > 1) return { text: `Date and time the ${entityLower} was ${head}`, uncertain: false }
  if (CLEAR_SUFFIX.has(last)) return { text: `${entity}'s ${phrase}`, uncertain: false }
  if (rest.length === 1 && SIMPLE.has(last)) return { text: `${entity}'s ${phrase}`, uncertain: false }
  if (last === 'id' && rest.length > 1) return { text: `Identifier of the related ${head}`, uncertain: true }
  return { text: `${entity}'s ${phrase}`, uncertain: true }
}

// Functional groups by name family: each table joins the most common (singular) word it shares with other tables
// (Bill, Refund, Payment), earliest word on ties; tables sharing no word stay ungrouped ("Other Tables").
// Within a group, parents come before their children, then ERD order.
function groups(schema: LldSchema) {
  const tables = schema.tables.filter((table) => table.kind === 'table')
  const family = (table: LldTable) => [...new Set(words(table.name).map((word) => singularWord(word).toLowerCase()))]
  const counts = new Map<string, number>()
  for (const table of tables) for (const word of family(table)) counts.set(word, (counts.get(word) ?? 0) + 1)
  const members = new Map<string, LldTable[]>()
  for (const table of tables) {
    const best = family(table).filter((word) => counts.get(word)! >= 2 && !/^\d+$/.test(word)).sort((first, second) => counts.get(second)! - counts.get(first)!)[0]
    if (best) members.set(best, [...(members.get(best) ?? []), table])
  }
  const names = new Set(tables.map((table) => table.full_name))
  const links = schema.relationships.filter((link) => names.has(link.parent) && names.has(link.child) && link.parent !== link.child)
  const order = new Map(tables.map((table, index) => [table.full_name, index]))
  const depth = new Map<string, number>()
  const level = (name: string, trail: Set<string>): number => {
    if (depth.has(name)) return depth.get(name)!
    if (trail.has(name)) return 0
    trail.add(name)
    const parents = links.filter((link) => link.child === name).map((link) => link.parent)
    const value = parents.length ? Math.max(...parents.map((parent) => level(parent, trail) + 1)) : 0
    trail.delete(name)
    depth.set(name, value)
    return value
  }
  return [...members.entries()].filter(([, list]) => list.length >= 2)
    .map(([word, list]) => {
      const sorted = list.map((table) => table.full_name).sort((first, second) => level(first, new Set()) - level(second, new Set()) || order.get(first)! - order.get(second)!)
      const plural = /(s|x|ch|sh)$/i.test(word) ? `${word}es` : /[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`
      return { title: plural[0].toUpperCase() + plural.slice(1), tables: sorted }
    })
    .sort((first, second) => Math.min(...first.tables.map((name) => order.get(name)!)) - Math.min(...second.tables.map((name) => order.get(name)!)))
}

export function generateDescriptions(schema: LldSchema, module = moduleName(schema.source)): Descriptions {
  const byName = new Map(schema.tables.map((table) => [table.full_name, table]))
  const tables: Record<string, TableDescriptions> = {}
  for (const table of schema.tables) {
    const entry: TableDescriptions = { _entity: entityName(table) }
    const uncertain: string[] = []
    for (const column of table.columns) {
      const { text, uncertain: unsure } = describe(table, column, byName)
      if (text) entry[column.name] = text
      if (unsure) uncertain.push(column.name)
    }
    if (uncertain.length) entry._uncertain = uncertain
    tables[table.full_name] = entry
  }
  return { module, groups: groups(schema), common: { ...COMMON_DICTIONARY }, tables }
}

// Fallback-only descriptions (dictionary, FK and lookup fallbacks), for "Generate descriptions" switched off.
export function emptyDescriptions(schema: LldSchema, module = moduleName(schema.source)): Descriptions {
  return { module, groups: groups(schema), common: { ...COMMON_DICTIONARY }, tables: {} }
}
