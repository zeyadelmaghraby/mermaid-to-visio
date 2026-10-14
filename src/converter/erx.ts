import type { Cardinality, ErColumn, ErEntity, ErModel, ErRelationship } from './er'
import { layoutEntities } from './erd-vsdx'
import { ERX_SECTIONS } from './erx-sections'

// ERwin 3.5 ERX: Visio's Database Model Diagram imports it (Database > Import > ERwin ERX) into real model
// tables, columns, keys and relationships. Codes and fixed rows follow an ERwin-written ERX 3.5 file.
const CARDINALITY: Record<Cardinality, string> = { zeroOrMore: 'CT_ZM', oneOrMore: 'CT_OM', zeroOrOne: 'CT_ZO', one: 'CT_EX' }
const MANDATORY_RULES = ['DR_RE', 'UR_RE', 'IR_RE', 'RI_NO', 'UR_CRE', 'RI_NO', 'NR_NN']
const OPTIONAL_RULES = ['DR_SN', 'UR_SN', 'IR_SN', 'RI_NO', 'UR_CSN', 'RI_NO', 'NR_NA']
// ERwin's built-in domains: 7 root, 8 <unknown>, 9 String, 10 Number, 11 Datetime, 12 Blob; columns start at 13.
const DOMAIN = { unknown: 8, string: 9, number: 10, datetime: 11, blob: 12 }
const FIRST_ATTRIBUTE = 13
const PIXELS_PER_INCH = 96

const FIXED: Record<string, string[]> = {
  ERWIN_DOMAIN: ['7,"DOMAIN",0,0,4', '8,"DOMAIN",0,7,3', '9,"DOMAIN",0,8,5', '10,"DOMAIN",0,8,6', '11,"DOMAIN",0,8,7', '12,"DOMAIN",0,8,8'],
  DOMAIN_PROP_VALUE: [
    '7,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"CHAR(18)",0', '7,"DOMAIN",0,"TB_OB",0,"CD_NUL",0,0,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_NAM",0,0,0,"%AttName",0',
    '7,"DOMAIN",0,"TB_OB",0,"CD_PLB",0,0,0,"%AttName:",0', '7,"DOMAIN",0,"TB_OB",0,"CD_PHD",0,0,0,"%AttName",0', '7,"DOMAIN",0,"TB_OB",0,"CD_CMT",2,0,0,"",0',
    '7,"DOMAIN",0,"TB_OB",0,"CD_DMC",3,0,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_DMN",0,0,0,"%DomainName",0', '7,"DOMAIN",0,"TB_OB",0,"CD_ANM",0,0,0,"%AttDomain",0',
    '7,"DOMAIN",0,"TB_OB",0,"CD_PCM",4,0,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_PLP",0,23,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_PHP",0,25,0,"",0',
    '7,"DOMAIN",0,"TB_OB",0,"CD_PJT",0,23,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_PCS",0,26,0,"",0', '7,"DOMAIN",0,"TB_OB",0,"CD_PBM",0,110,0,"",0',
    '7,"DOMAIN",0,"TB_OB",0,"CD_VSB",0,121,0,"",0', '11,"DOMAIN",0,"TB_OB",0,"CD_DLN",0,0,0,"Datetime",0', '11,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"TIMESTAMP",0',
    '10,"DOMAIN",0,"TB_OB",0,"CD_DLN",0,0,0,"Number",0', '10,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"NUMERIC",0', '8,"DOMAIN",0,"TB_OB",0,"CD_DLN",0,0,0,"<unknown>",0',
    '8,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"CHAR(18)",0', '12,"DOMAIN",0,"TB_OB",0,"CD_DLN",0,0,0,"Blob",0', '12,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"LONG VARBINARY",0',
    '9,"DOMAIN",0,"TB_OB",0,"CD_DLN",0,0,0,"String",0', '9,"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,"VARCHAR(20)",0'],
  DIAGRAM_OPTION: ['"DO_DL",0,1,0,"1"', '"DO_PDL",0,1,0,"1"', '"DO_FK",0,1,0,"1"', '"DO_DFK",0,1,0,"1"', '"DO_DSN",0,1,0,"1"', '"DO_SMA",0,1,0,"1"',
    '"DO_LFK",0,1,0,"1"', '"DO_TD",0,1,0,"194"', '"DO_TV",0,1,0,"2"', '"DO_TM",0,1,0,"0"'],
  FONT: ['0,"TX_FNT",0,10,0,0,0,400,0,0,0,0,7,2,1,34,"Arial",-13', '1,"TX_FNT",0,10,0,0,0,400,0,0,0,0,7,2,1,34,"Microsoft Sans Serif",-13'],
  COLOR: ['0,"TX_COL",0,0', '1,"TX_COL",0,16777215'],
  ERWIN_UDP: ['2,"5",0,"DiagAuth",0,2,0,3,1,0,0', '5,"5",0,"DiagDbName",0,2,0,3,2,0,0', '3,"5",0,"DiagDef",0,2,0,3,3,0,0', '4,"5",0,"DiagImpType",0,1,0,3,4,0,0',
    '1,"5",0,"DiagTitle",0,2,0,3,5,0,0'],
  ERWIN_UDPU: ['0,"DIAG_T",1,"5",0,1,0'],
}

function domainOf(type: string): number {
  const base = type.toLowerCase().replace(/\(.*$/, '').trim()
  if (/^(?:n?char|n?varchar|n?text|uniqueidentifier|xml|sysname|string)$/.test(base)) return DOMAIN.string
  if (/^(?:bigint|int|integer|smallint|tinyint|decimal|numeric|float|real|money|smallmoney|bit|number|double)$/.test(base)) return DOMAIN.number
  if (/^(?:date|datetime|datetime2|smalldatetime|time|datetimeoffset|timestamp)$/.test(base)) return DOMAIN.datetime
  if (/^(?:binary|varbinary|image|blob)$/.test(base)) return DOMAIN.blob
  return DOMAIN.unknown
}

export interface ForeignKey { relationship: ErRelationship; pairs: { child: ErColumn; parent: ErColumn }[]; added: boolean; identifying: boolean }

const shortName = (entity: ErEntity) => entity.name.slice(entity.name.lastIndexOf('.') + 1)
const squash = (value: string) => value.toLowerCase().replace(/_/g, '')
function singular(name: string) {
  const lower = name.toLowerCase()
  return lower.endsWith('ies') ? `${lower.slice(0, -3)}y` : lower.endsWith('sses') ? lower.slice(0, -2) : lower.endsWith('s') ? lower.slice(0, -1) : lower
}
function matchScore(child: ErColumn, parentKey: ErColumn, parent: ErEntity) {
  const column = squash(child.name), key = squash(parentKey.name), base = squash(singular(shortName(parent)))
  if (column === base + key || (column.endsWith(key) && column.includes(base))) return 3
  if (column === key) return 2
  return column.endsWith(key) ? 1 : 0
}

// Binds every relationship to the child columns that carry its foreign key: the FK group (FKn) whose names best
// match the parent's primary key. Relationships without such columns get migrated columns, as Visio adds them.
export function bindForeignKeys(model: ErModel): { entities: ErEntity[]; foreignKeys: ForeignKey[]; notes: string[] } {
  const entities = model.entities.filter((entity) => !entity.view).map((entity) => ({ ...entity, columns: entity.columns.map((column) => ({ ...column })) }))
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const notes: string[] = []
  const views = model.entities.filter((entity) => entity.view)
  if (views.length) notes.push(`${views.length} view${views.length > 1 ? 's are' : ' is'} not part of the ERX model (ERwin ERX carries tables only): ${views.map((view) => view.name).join(', ')}.`)
  const relationships = model.relationships.filter((relationship) => {
    const keep = byId.has(relationship.parent) && byId.has(relationship.child)
    if (!keep) notes.push(`Relationship ${relationship.parent} - ${relationship.child} involves a view and is not exported.`)
    return keep
  })
  for (const relationship of relationships) {
    if (!byId.get(relationship.parent)!.columns.some((column) => column.pk)) throw new Error(`${byId.get(relationship.parent)!.name} needs a primary key for its relationship to ${byId.get(relationship.child)!.name}.`)
  }
  const used = new Set<ErColumn>()
  const chosen = new Map<ErRelationship, ErColumn[]>()
  // Best-scoring (relationship, FK group) pairs first, so one table's FK groups are shared out sensibly.
  const candidates = relationships.flatMap((relationship) => {
    const parent = byId.get(relationship.parent)!, child = byId.get(relationship.child)!
    const keys = parent.columns.filter((column) => column.pk)
    const groups = [...new Set(child.columns.filter((column) => column.fk).map((column) => column.fk!))]
    return groups.flatMap((group) => {
      const members = child.columns.filter((column) => column.fk === group)
      if (members.length !== keys.length) return []
      const ordered = keys.map((key) => [...members].sort((first, second) => matchScore(second, key, parent) - matchScore(first, key, parent))[0])
      if (new Set(ordered).size !== keys.length) return []
      return [{ relationship, columns: ordered, score: ordered.reduce((total, column, index) => total + matchScore(column, keys[index], parent), 0), group }]
    })
  }).sort((first, second) => second.score - first.score || first.group - second.group || relationships.indexOf(first.relationship) - relationships.indexOf(second.relationship))
  for (const candidate of candidates) {
    if (chosen.has(candidate.relationship) || candidate.columns.some((column) => used.has(column))) continue
    chosen.set(candidate.relationship, candidate.columns)
    candidate.columns.forEach((column) => used.add(column))
  }
  const foreignKeys = relationships.map((relationship): ForeignKey => {
    const parent = byId.get(relationship.parent)!, child = byId.get(relationship.child)!
    const keys = parent.columns.filter((column) => column.pk)
    let columns = chosen.get(relationship)
    const added = !columns
    if (!columns) {
      const group = Math.max(0, ...child.columns.map((column) => column.fk ?? 0)) + 1
      columns = keys.map((key, position) => {
        let name = child.columns.some((column) => column.name.toLowerCase() === key.name.toLowerCase()) ? `${shortName(parent)}_${key.name}` : key.name
        for (let suffix = 2; child.columns.some((column) => column.name.toLowerCase() === name.toLowerCase()); suffix++) name = `${shortName(parent)}_${key.name}_${suffix}`
        const column: ErColumn = { name, type: key.type, pk: relationship.identifying, fk: group, notNull: relationship.identifying || !relationship.parentOptional }
        // Migrated key columns lead the child's primary key, as ERwin and Visio place them.
        const at = column.pk ? position : child.columns.length
        child.columns.splice(at, 0, column)
        return column
      })
      notes.push(`Added ${columns.map((column) => column.name).join(', ')} to ${child.name} for its relationship to ${parent.name}.`)
    }
    const identifying = columns.every((column) => column.pk)
    if (identifying !== relationship.identifying) notes.push(`${parent.name} - ${child.name} is ${identifying ? 'identifying' : 'non-identifying'} because its FK columns ${identifying ? 'are' : 'are not'} part of ${child.name}'s primary key.`)
    return { relationship, pairs: columns.map((column, index) => ({ child: column, parent: keys[index] })), added, identifying }
  })
  return { entities, foreignKeys, notes }
}

function quoted(value: string) {
  return `"${value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`
}

export function generateErx(model: ErModel, title = 'ER Diagram'): { bytes: Uint8Array; notes: string[] } {
  const { pageHeight, boxes } = layoutEntities(model)
  const { entities, foreignKeys, notes } = bindForeignKeys(model)
  if (!entities.length) throw new Error('The ERX model needs at least one table; views are not exported to ERX.')
  const rows = new Map<string, string[]>(ERX_SECTIONS.map(([name]) => [name, [...(FIXED[name] ?? [])]]))
  const add = (section: string, row: string) => rows.get(section)!.push(row)
  let nextText = 1
  const text = (value: string) => { const id = nextText++; add('ERW_TEXT', `${id},0,${quoted(value)}`); return id }
  const modelText = text(title.trim() || 'ER Diagram')
  text('%AttDef'); text('%DomainDef'); text('%AttDef')
  if (modelText !== 1 || nextText !== 5) throw new Error('ERX text pool out of order.')

  const entityIds = new Map(entities.map((entity, index) => [entity.id, index + 1]))
  const dependent = new Set(foreignKeys.filter((key) => key.identifying).map((key) => key.relationship.child))
  const kind = (id: string) => (dependent.has(id) ? 'ET_DE' : 'ET_IE')
  const relationshipIds = new Map(foreignKeys.map((key, index) => [key.relationship, index + 1]))
  const attributeIds = new Map<ErColumn, number>()
  let nextAttribute = FIRST_ATTRIBUTE
  for (const entity of entities) for (const column of entity.columns) attributeIds.set(column, nextAttribute++)
  const migrated = new Map<ErColumn, ForeignKey>()
  for (const key of foreignKeys) for (const pair of key.pairs) migrated.set(pair.child, key)

  for (const entity of entities) {
    const id = entityIds.get(entity.id)!, type = kind(entity.id)
    add('ERWIN_ENTITY', `${id},"${type}",0,${quoted(entity.name)},"",0,0,0,0`)
    const box = boxes.get(entity.id)!
    const [x1, y1] = [Math.round(box.left * PIXELS_PER_INCH), Math.round((pageHeight - box.top) * PIXELS_PER_INCH)]
    add('ERWIN_DIAG_VIEW_OBJ', `1,0,${id},"${type}",0,${x1},${y1},${x1 + Math.round(box.width * PIXELS_PER_INCH)},${y1 + Math.round(box.height * PIXELS_PER_INCH)},1,0,0,1,0,0,"TX_FNT","TX_COL",${Array(17).fill(0).join(',')}`)
    entity.columns.forEach((column, order) => {
      const attribute = attributeIds.get(column)!, key = migrated.get(column)
      const via = key ? `${relationshipIds.get(key.relationship)},"${key.identifying ? 'RT_ID' : 'RT_NI'}",${attributeIds.get(key.pairs.find((pair) => pair.child === column)!.parent)}` : '-1,"RT_OA",0'
      add('ERWIN_ATTRIBUTE', `${attribute},"DOMAIN",0,"${column.pk ? 'AT_PK' : 'AT_NK'}",${id},"${type}",${via},${order},-1,-1,-1,4`)
      add('ERWIN_DOMAIN', `${attribute},"DOMAIN",0,${domainOf(column.type)},2`)
      add('DOMAIN_PROP_VALUE', `${attribute},"DOMAIN",0,"TB_OB",0,"CD_NAM",0,0,0,${quoted(column.name)},0`)
      add('DOMAIN_PROP_VALUE', `${attribute},"DOMAIN",0,"TB_OB",0,"CD_TYP",0,0,0,${quoted(column.type)},0`)
      add('DOMAIN_PROP_VALUE', `${attribute},"DOMAIN",0,"TB_OB",0,"CD_NUL",0,${column.notNull ? 1 : 0},0,"",0`)
      add('DOMAIN_PROP_VALUE', `${attribute},"DOMAIN",0,"TB_OB",0,"CD_ANM",0,0,0,${quoted(column.name)},0`)
    })
    // Indexes: primary key (id 0), alternate keys (AK1...) and one inversion entry per foreign key (id = relationship).
    const tag = entity.name.replace(/[^A-Za-z0-9_]/g, '_')
    const index = (indexId: number, indexType: string, name: string, unique: boolean, members: ErColumn[]) => {
      add('ENTITY_INDEX', `${indexId},"${indexType}",${id},"${type}",0,0,${quoted(name)},"",4`)
      members.forEach((member, position) => add('INDEX_MEMBER', `${indexId},"${indexType}",${id},"${type}",${attributeIds.get(member)},"DOMAIN",0,${position + 1}`))
      add('INDEX_PHYSICAL_PV', `${indexId},"${indexType}",${id},"${type}",0,"TB_OB","IP_LNM",-1,${text(name)}`)
      add('INDEX_PHYSICAL_PV', `${indexId},"${indexType}",${id},"${type}",0,"TB_OB","IP_UNQ",-1,${text(unique ? 'Yes' : 'No')}`)
    }
    const keys = entity.columns.filter((column) => column.pk)
    if (keys.length) index(0, 'IT_PK', `XPK${tag}`, true, keys)
    for (const group of [...new Set(entity.columns.filter((column) => column.unique).map((column) => column.unique!))].sort((a, b) => a - b)) {
      index(group, 'IT_AK', `XAK${group}${tag}`, true, entity.columns.filter((column) => column.unique === group))
    }
    foreignKeys.filter((key) => key.relationship.child === entity.id).forEach((key, position) => {
      index(relationshipIds.get(key.relationship)!, 'IT_IF', `XIF${position + 1}${tag}`, false, key.pairs.map((pair) => pair.child))
    })
  }
  for (const key of foreignKeys) {
    const { relationship } = key
    const id = relationshipIds.get(relationship)!, type = key.identifying ? 'RT_ID' : 'RT_NI'
    // An identifying relationship's parent is always mandatory: its key is part of the child's primary key.
    const rules = key.identifying || !relationship.parentOptional ? MANDATORY_RULES : OPTIONAL_RULES
    add('ERWIN_RELATIONSHIP', `${id},"${type}",0,${entityIds.get(relationship.parent)},"${kind(relationship.parent)}",${entityIds.get(relationship.child)},"${kind(relationship.child)}",`
      + `${quoted(relationship.label)},"${CARDINALITY[relationship.childCardinality]}",${rules.map((rule) => `"${rule}"`).join(',')},0,"","",0,0,0,0`)
    add('ERWIN_DIAG_VIEW_OBJ', `1,0,${id},"${type}",0,0,0,0,0,1,0,0,0,0,0,"TX_FNT","TX_COL",${Array(17).fill(0).join(',')}`)
  }
  const now = Math.floor(Date.now() / 1000)
  add('SUBJECT', `0,1,"<Main Subject Area>",0,"",${now},${now},0,0`)
  add('DISPLAY', `0,1,0,"Display1",0,"",${now},${now},-1,-1,0,0,0,-1,-1,-1,-1,"TX_FNT","TX_COL"`)

  const body = ['/* PLATINUM ERwin/ERX 3.5 */', ...ERX_SECTIONS.flatMap(([name, header]) => [...header.split('\n'), ...rows.get(name)!])].join('\r\n') + '\r\n'
  const bytes = new Uint8Array(body.length)
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index)
    if (code > 0xff || (code >= 0x80 && code < 0xa0)) throw new Error('ERX files are Windows-1252 text: use Latin letters, digits and punctuation in table, column and type names.')
    bytes[index] = code
  }
  return { bytes, notes }
}
