import type { LldTable, ParsedErd } from '../lld/model'
import { singularWord, words } from '../lld/descriptions'

// Conceptual model derived from a physical ERD: business entities and UML relationships between them.
export type LinkKind = 'composition' | 'association' | 'directed'
export interface ConceptEntity { id: string; name: string; include: boolean }
// Composition and association run from the parent (owner / referenced side) to the child; a directed
// association points from the referencing child to the parent, so `from`/`to` say how it is drawn.
export interface ConceptLink { id: string; kind: LinkKind; from: string; to: string; label: string; fromMultiplicity: string; toMultiplicity: string }
export interface ConceptModel { module: string; entities: ConceptEntity[]; links: ConceptLink[] }

const CHILD_END: Record<number, string> = { 25: '1', 28: '1..*', 29: '*', 30: '0..1' }
export const MULTIPLICITIES = ['1', '0..1', '*', '1..*', '0..*']

// "Bill_Requests_Revenue_Entries" -> "Bill Request Revenue Entry": singular words, spaced, schema dropped.
export function conceptName(table: LldTable) {
  return words(table.name).map((word) => (/^[A-Z0-9]+$/.test(word) ? word : singularWord(word))).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

const shared = (a: string, b: string) => {
  const [first, second] = [words(a).map((word) => singularWord(word).toLowerCase()), words(b).map((word) => singularWord(word).toLowerCase())]
  let count = 0
  while (count < first.length && count < second.length && first[count] === second[count]) count++
  return count
}

export function conceptModel(erd: ParsedErd, module: string): ConceptModel {
  const tables = erd.tables.filter((table) => table.kind === 'table')
  const byName = new Map(tables.map((table) => [table.full_name, table]))
  const links = erd.ends.filter((end) => byName.has(end.parent) && byName.has(end.child))
  // A relationship is mandatory when one of the child's FK columns that reference the parent is NOT NULL.
  const mandatory = (parent: string, child: string, parentEnd?: number) => {
    const columns = byName.get(child)!.columns.filter((column) => column.fk && column.ref === parent)
    return columns.length ? columns.some((column) => column.required) : parentEnd !== 30
  }
  // Each part has one owner: its mandatory parent, or the one whose name it extends (Report -> Report_Details).
  const owner = new Map<string, string>()
  for (const table of tables) {
    const parents = [...new Set(links.filter((link) => link.child === table.full_name && link.parent !== link.child && mandatory(link.parent, link.child, link.parentEnd)).map((link) => link.parent))]
    if (!parents.length) continue
    owner.set(table.full_name, parents.map((name, index) => ({ name, index, score: shared(byName.get(name)!.name, table.name) }))
      .sort((first, second) => second.score - first.score || first.index - second.index)[0].name)
  }
  // An entity that keeps parts of its own is an aggregate root and is never composed into another one.
  // Decided from the leaves up, so a root's status only depends on parts that really stay composed.
  const composed = new Set<string>(), roots = new Set<string>(), done = new Set<string>()
  const settle = (name: string, trail: Set<string>) => {
    if (done.has(name) || trail.has(name)) return
    trail.add(name)
    const parts = [...owner].filter(([, parent]) => parent === name).map(([part]) => part)
    parts.forEach((part) => settle(part, trail))
    if (parts.some((part) => composed.has(part))) roots.add(name)
    if (owner.has(name) && !roots.has(name)) composed.add(name)
    trail.delete(name)
    done.add(name)
  }
  tables.forEach((table) => settle(table.full_name, new Set()))
  const referenced = (name: string) => !roots.has(name) && !links.some((link) => link.child === name)
  const result: ConceptLink[] = links.map((link, index) => {
    const required = mandatory(link.parent, link.child, link.parentEnd)
    // The parent end follows the FK's nullability (some drawings show an optional end on a NOT NULL FK).
    const parentMultiplicity = required ? '1' : '0..1'
    const childMultiplicity = CHILD_END[link.childEnd ?? 29] ?? '*'
    const id = `link-${index + 1}`
    if (composed.has(link.child) && owner.get(link.child) === link.parent) return { id, kind: 'composition', from: link.parent, to: link.child, label: 'owns', fromMultiplicity: parentMultiplicity, toMultiplicity: childMultiplicity }
    if (referenced(link.parent)) return { id, kind: 'directed', from: link.child, to: link.parent, label: '', fromMultiplicity: childMultiplicity, toMultiplicity: parentMultiplicity }
    return { id, kind: 'association', from: link.parent, to: link.child, label: '', fromMultiplicity: parentMultiplicity, toMultiplicity: childMultiplicity }
  })
  return { module, entities: tables.map((table) => ({ id: table.full_name, name: conceptName(table), include: true })), links: result }
}
