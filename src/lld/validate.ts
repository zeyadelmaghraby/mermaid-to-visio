import type { ParsedErd } from './model'
import type { MissingDescription } from './descriptions'
import { singularWord, words } from './descriptions'
import { editDistance } from './similarity'

export type WarningKind = 'missing-description' | 'uncertain-description' | 'unresolved-fk' | 'loose-connector' | 'schema-prefix' | 'typo' | 'required-mismatch'
export interface ValidationWarning { kind: WarningKind; message: string; table?: string; column?: string }

const key = (word: string) => singularWord(word).toLowerCase()

// Schema prefixes that look like one schema spelled two ways (bil. / bill.).
function schemaPrefixes(erd: ParsedErd): ValidationWarning[] {
  const counts = new Map<string, number>()
  for (const table of erd.tables) if (table.schema) counts.set(table.schema, (counts.get(table.schema) ?? 0) + 1)
  const schemas = [...counts.keys()]
  const warnings: ValidationWarning[] = []
  for (let first = 0; first < schemas.length; first++) for (let second = first + 1; second < schemas.length; second++) {
    const [a, b] = [schemas[first], schemas[second]]
    const close = editDistance(a.toLowerCase(), b.toLowerCase()) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 3)) || a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase())
    if (close) warnings.push({ kind: 'schema-prefix', message: `Inconsistent schema prefixes: ${a}. (${counts.get(a)} tables) and ${b}. (${counts.get(b)} tables) look like the same schema.` })
  }
  return warnings
}

// A column word, or a whole column name, one edit away from a more common one in the same file.
// (Two edits also matched real word pairs in the Billing ERD: Maximum/Minimum, Notification/Modification, Account/Amount.)
function typos(erd: ParsedErd): ValidationWarning[] {
  const vocabulary = new Map<string, number>()
  const add = (word: string) => { if (/[a-z]/i.test(word)) vocabulary.set(key(word), (vocabulary.get(key(word)) ?? 0) + 1) }
  for (const table of erd.tables) {
    words(table.name).forEach(add)
    for (const column of table.columns) words(column.name).forEach(add)
  }
  const names = new Map<string, { count: number; places: string[] }>()
  for (const table of erd.tables) for (const column of table.columns) {
    const entry = names.get(column.name) ?? { count: 0, places: [] }
    entry.count++
    entry.places.push(`${table.full_name}.${column.name}`)
    names.set(column.name, entry)
  }
  const found = new Map<string, { suggestion: string; places: string[] }>()
  for (const [name, { count, places }] of names) {
    const parts = words(name)
    // Whole names: same words except one close word, and the other spelling is used more often (Last_Modifcation_Time / Last_Modification_Time).
    for (const [other, info] of names) {
      if (other === name || info.count <= count) continue
      const otherParts = words(other)
      if (otherParts.length !== parts.length) continue
      const different = parts.map((part, index) => [part, otherParts[index]]).filter(([a, b]) => a.toLowerCase() !== b.toLowerCase())
      if (different.length !== 1) continue
      const [a, b] = different[0]
      if (Math.min(a.length, b.length) >= 4 && editDistance(a.toLowerCase(), b.toLowerCase()) === 1 && key(a) !== key(b)) {
        found.set(name, { suggestion: other, places })
      }
    }
    if (found.has(name)) continue
    // Single words: close to a more frequent word of the file (Notifcation / Notification).
    for (const part of parts) {
      const word = key(part), frequency = vocabulary.get(word) ?? 0
      if (word.length < 5) continue
      const match = [...vocabulary.entries()].filter(([candidate, uses]) => candidate !== word && uses > frequency && candidate.length >= 5 && editDistance(candidate, word) === 1)
        .sort((first, second) => second[1] - first[1])[0]
      if (match) { found.set(name, { suggestion: name.replace(part, match[0][0].toUpperCase() + match[0].slice(1)), places }); break }
    }
  }
  return [...found.entries()].map(([name, { suggestion, places }]) => ({ kind: 'typo', column: name,
    message: `Possible typo: ${name} (did you mean ${suggestion}?) in ${places.join(', ')}.` }))
}

// Sibling tables share their name after the first word (Bill_Requests_Revenue_Entries / Refund_Request_Revenue_Entries).
function requiredMismatches(erd: ParsedErd): ValidationWarning[] {
  const families = new Map<string, typeof erd.tables>()
  for (const table of erd.tables.filter((entry) => entry.kind === 'table')) {
    const parts = words(table.name)
    if (parts.length < 2) continue
    const family = parts.slice(1).map(key).join('_')
    families.set(family, [...(families.get(family) ?? []), table])
  }
  const warnings: ValidationWarning[] = []
  for (const siblings of families.values()) {
    if (siblings.length < 2) continue
    const columns = new Map<string, { required: string[]; optional: string[] }>()
    for (const table of siblings) for (const column of table.columns) {
      const id = `${column.name}|${column.type.toLowerCase()}`
      const entry = columns.get(id) ?? { required: [], optional: [] }
      ;(column.required ? entry.required : entry.optional).push(table.full_name)
      columns.set(id, entry)
    }
    for (const [id, { required, optional }] of columns) {
      if (!required.length || !optional.length) continue
      const [column, type] = id.split('|')
      warnings.push({ kind: 'required-mismatch', column, message: `${column} (${type}) is Required in ${required.join(', ')} but Optional in ${optional.join(', ')}.` })
    }
  }
  return warnings
}

export function validate(erd: ParsedErd, missing: MissingDescription[], uncertain: MissingDescription[]): ValidationWarning[] {
  const warnings: ValidationWarning[] = [
    ...missing.map(({ table, column }): ValidationWarning => ({ kind: 'missing-description', table, column, message: `No description for ${table}.${column}.` })),
    ...uncertain.map(({ table, column }): ValidationWarning => ({ kind: 'uncertain-description', table, column, message: `Check the description of ${table}.${column}; its purpose is not clear from the ERD.` })),
  ]
  for (const table of erd.tables) for (const column of table.columns.filter((entry) => entry.fk && !entry.ref)) {
    warnings.push({ kind: 'unresolved-fk', table: table.full_name, column: column.name, message: `The parent table of FK ${table.full_name}.${column.name} could not be resolved from the relationships.` })
  }
  for (const connector of erd.looseConnectors) {
    warnings.push({ kind: 'loose-connector', message: `Connector ${connector.id} on page ${connector.page} is not glued to two tables (${connector.parent ?? 'nothing'} → ${connector.child ?? 'nothing'}).` })
  }
  return [...warnings, ...schemaPrefixes(erd), ...typos(erd), ...requiredMismatches(erd)]
}
