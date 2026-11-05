// Visio ERD schema model (JSON interchange format of the LLD field-description export).
export interface LldColumn {
  name: string
  type: string
  keys: string[]
  pk: boolean
  fk: boolean
  unique: boolean
  // NOT NULL as drawn in the ERD (bold column name or PK); null for views, whose nullability the source module defines.
  required: boolean | null
  // Parent table of an FK column, when it can be resolved from the relationships.
  ref?: string
}

export interface LldTable {
  id: string
  page: string
  full_name: string
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: LldColumn[]
}

export interface LldRelationship { parent: string; child: string }

// Connectors that are not glued to two entities, kept for the validation report.
export interface LldLooseConnector { id: string; page: string; parent?: string; child?: string }

export interface LldSchema {
  source: string
  tables: LldTable[]
  relationships: LldRelationship[]
}

// Crow's-foot line ends of a glued relationship, as Visio arrow indexes: parent 25 one, 30 zero-or-one;
// child 25 one, 28 one-or-more, 29 zero-or-more, 30 zero-or-one. Undefined when the drawing does not say.
export interface LldRelationshipEnds extends LldRelationship { parentEnd?: number; childEnd?: number }

export interface ParsedErd extends LldSchema { looseConnectors: LldLooseConnector[]; ends: LldRelationshipEnds[] }
