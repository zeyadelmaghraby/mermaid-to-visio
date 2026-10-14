// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import { parseEr } from './er'
import { detectKind, prepareDiagram } from './diagram'
import { ER_SAMPLE_CODE, SAMPLE_CODE } from '../sample'

vi.mock('mermaid', async (importOriginal) => {
  const original = await importOriginal<typeof import('mermaid')>()
  return { ...original, default: { ...original.default, mermaidAPI: { ...original.default.mermaidAPI } } }
})

describe('Mermaid ER adapter', () => {
  it('maps the sample to tables, a view, ordered key columns and parent/child relationships', async () => {
    const model = await parseEr(ER_SAMPLE_CODE)
    expect(model.direction).toBe('TB')
    expect(model.entities.filter((entity) => !entity.view).map((entity) => entity.name)).toEqual(['sales.Customers', 'cfg.Currencies', 'sales.Orders',
      'sales.Order_Items', 'sales.Products', 'sales.Product_Categories', 'sales.Payments', 'sales.Invoices'])
    expect(model.entities.filter((entity) => entity.view).map((entity) => entity.name)).toEqual(['sales.Customer_Order_Summary_View'])
    const items = model.entities.find((entity) => entity.id === 'ITM')!
    expect(items.columns.map((column) => [column.name, column.pk, column.fk ?? null, column.notNull])).toEqual([
      ['Order_Id', true, 1, true], ['Line_Number', true, null, true], ['Product_Id', false, 2, true], ['Quantity', false, null, true], ['Unit_Price', false, null, true]])
    const products = model.entities.find((entity) => entity.id === 'PRD')!
    expect(products.columns.filter((column) => column.unique).map((column) => [column.name, column.unique, column.fk ?? null])).toEqual([['Sku', 1, null], ['Category_Id', 1, 1]])
    expect(model.entities.find((entity) => entity.id === 'CUS')!.columns.find((column) => column.name === 'Name_Ar')!.notNull).toBe(false)
    expect(model.relationships).toHaveLength(8)
    expect(model.relationships.find((relationship) => relationship.child === 'ITM' && relationship.parent === 'ORD')).toMatchObject({ identifying: true, parentOptional: false, childCardinality: 'oneOrMore', label: 'contains' })
    expect(model.relationships.find((relationship) => relationship.child === 'INV')).toMatchObject({ parent: 'ORD', identifying: false, childCardinality: 'zeroOrOne' })
    expect(model.relationships.find((relationship) => relationship.label === 'parent of')).toMatchObject({ parent: 'CAT', child: 'CAT', parentOptional: true, childCardinality: 'zeroOrMore' })
  })

  it('orients relationships from the single side regardless of the Mermaid writing order', async () => {
    const model = await parseEr('erDiagram\n  B }o..|| A : "belongs to"\n  C |{--o| D : owns\n  E ||--|| F : twin')
    expect(model.relationships.map(({ parent, child, parentOptional, childCardinality, identifying }) => ({ parent, child, parentOptional, childCardinality, identifying }))).toEqual([
      { parent: 'A', child: 'B', parentOptional: false, childCardinality: 'zeroOrMore', identifying: false },
      { parent: 'D', child: 'C', parentOptional: true, childCardinality: 'oneOrMore', identifying: true },
      { parent: 'E', child: 'F', parentOptional: false, childCardinality: 'one', identifying: true },
    ])
  })

  it('accepts schema-qualified names directly or as aliases, physical types and LR direction', async () => {
    const model = await parseEr('erDiagram\n  direction LR\n  hr.Departments {\n    nvarchar(max) Extra_Properties\n    decimal(18,4) Amount "NOT NULL"\n    datetime2(7) At\n  }\n  X["cfg.Cost_Centers"] {\n    bigint Id PK\n  }\n  X ||..o{ hr.Departments : ""')
    expect(model.direction).toBe('LR')
    expect(model.entities.map((entity) => entity.name)).toEqual(['hr.Departments', 'cfg.Cost_Centers'])
    expect(model.entities[0].columns.map((column) => [column.type, column.notNull])).toEqual([['nvarchar(max)', false], ['decimal(18,4)', true], ['datetime2(7)', false]])
    expect(model.relationships[0].label).toBe('')
  })

  it.each([
    ['many-to-many', 'erDiagram\n  A }o--o{ B : links', /Many-to-many relationship between A and B: add an associative table/],
    ['keys on a view', 'erDiagram\n  V:::view {\n    bigint Id PK\n  }', /Views have no key column/],
    ['other classes', 'erDiagram\n  V:::big {\n    bigint Id\n  }', /Only the view class is supported/],
    ['classDef styling', 'erDiagram\n  classDef view fill:#f00\n  V:::view {\n    bigint Id\n  }', /Styling \(style, classDef\)/],
    ['FK number without FK', 'erDiagram\n  A {\n    bigint B_Id "FK2"\n  }', /names FK2 in its comment but is not marked FK/],
    ['U number without UK', 'erDiagram\n  A {\n    bigint Code "U1"\n  }', /names U1 in its comment but is not marked UK/],
    ['duplicate columns', 'erDiagram\n  A {\n    bigint Id\n    int id\n  }', /Duplicate column A\.id/],
    ['bottom-up direction', 'erDiagram\n  direction BT\n  A ||--o{ B : x', /Use direction TB \(default\) or LR/],
    ['HTML', 'erDiagram\n  A["<b>A</b>"] {\n    bigint Id\n  }', /HTML is forbidden/],
    ['frontmatter', '---\ntitle: x\n---\nerDiagram\n  A {\n    bigint Id\n  }', /frontmatter/],
    ['other families', 'flowchart TD\n  A-->B', /Only erDiagram is supported here/],
  ])('rejects %s explicitly', async (_, source, message) => {
    await expect(parseEr(source)).rejects.toThrow(message)
  })

  it('selects the diagram family from the first statement', async () => {
    expect(detectKind('%% comment\n  erDiagram\n  A ||--o{ B : x')).toBe('er')
    expect(detectKind(SAMPLE_CODE)).toBe('sequence')
    expect(detectKind('classDiagram\n  A <|-- B')).toBeNull()
    await expect(prepareDiagram('classDiagram\n  A <|-- B', 'probe')).rejects.toThrow('Only sequenceDiagram and erDiagram are supported.')
    // jsdom has no SVG layout (getBBox); real ER rendering is covered by the browser workflow.
    const render = vi.spyOn(mermaid.mermaidAPI, 'render').mockImplementation(async (id) => ({ svg: `<svg id="${id}"></svg>`, diagramType: 'er' }))
    try {
      const er = await prepareDiagram(ER_SAMPLE_CODE, 'erProbe')
      expect(er.model.kind).toBe('er')
      expect(er.svg).toBe('<svg id="erProbe"></svg>')
      const sequence = await prepareDiagram('sequenceDiagram\nA->>B: hi', 'seqProbe')
      expect(sequence.model.kind).toBe('sequence')
      await expect(prepareDiagram(ER_SAMPLE_CODE, '../bad')).rejects.toThrow(/render ID/)
    } finally { render.mockRestore() }
  })
})
