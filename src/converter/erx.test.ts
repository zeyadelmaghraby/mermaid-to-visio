// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseEr } from './er'
import { bindForeignKeys, generateErx } from './erx'
import { ERX_SECTIONS } from './erx-sections'
import { ER_SAMPLE_CODE } from '../sample'

// Fields per data row in an ERwin-written ERX 3.5 file, by section (ERwin's own rows, not its schema comments).
const ERWIN_FIELDS: Record<string, number> = {
  ERW_TEXT: 3, ERWIN_ENTITY: 9, ERWIN_RELATIONSHIP: 23, ERWIN_ATTRIBUTE: 14, ERWIN_DIAG_VIEW_OBJ: 34, ENTITY_INDEX: 9, INDEX_MEMBER: 8,
  DIAGRAM_OPTION: 5, INDEX_PHYSICAL_PV: 9, ERWIN_DOMAIN: 5, DOMAIN_PROP_VALUE: 11, FONT: 18, COLOR: 4, SUBJECT: 9, DISPLAY: 19, ERWIN_UDP: 11, ERWIN_UDPU: 7,
}

function fields(row: string): string[] {
  return Array.from(row.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)).slice(0, -1).map((match) => match[2] ?? match[1])
}

function read(bytes: Uint8Array) {
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  expect(text.startsWith('/* PLATINUM ERwin/ERX 3.5 */\r\n')).toBe(true)
  expect(text.endsWith('\r\n')).toBe(true)
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
  const sections = new Map<string, string[][]>()
  const order: string[] = []
  let current = ''
  const lines = text.split('\r\n').slice(1, -1)
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === '/*') {
      current = lines[index + 1].replace('CREATE TABLE ', '')
      order.push(current)
      sections.set(current, [])
      while (lines[index] !== '*/') index++
      continue
    }
    sections.get(current)!.push(fields(lines[index]))
  }
  expect(order).toEqual(ERX_SECTIONS.map(([name]) => name))
  return sections
}

describe('ERwin ERX model export', () => {
  it('writes the ERwin 3.5 section layout with rows shaped like ERwin\'s own', async () => {
    const sections = read(generateErx(await parseEr(ER_SAMPLE_CODE), 'Sales Model').bytes)
    for (const [name, rows] of sections) {
      if (ERWIN_FIELDS[name] !== undefined) for (const row of rows) expect(row, `${name} row`).toHaveLength(ERWIN_FIELDS[name])
    }
    expect(sections.get('ERW_TEXT')!.slice(0, 4).map((row) => row[2])).toEqual(['Sales Model', '%AttDef', '%DomainDef', '%AttDef'])
    expect(sections.get('DIAGRAM_OPTION')!.find((row) => row[0] === 'DO_TD')![4]).toBe('194')
  })

  it('exports tables, keys, migrated foreign keys and relationships as model objects', async () => {
    const sections = read(generateErx(await parseEr(ER_SAMPLE_CODE)).bytes)
    const entities = sections.get('ERWIN_ENTITY')!
    expect(entities.map((row) => [row[0], row[1], row[3]])).toEqual([
      ['1', 'ET_IE', 'sales.Customers'], ['2', 'ET_IE', 'cfg.Currencies'], ['3', 'ET_IE', 'sales.Orders'], ['4', 'ET_DE', 'sales.Order_Items'],
      ['5', 'ET_IE', 'sales.Products'], ['6', 'ET_IE', 'sales.Product_Categories'], ['7', 'ET_IE', 'sales.Payments'], ['8', 'ET_IE', 'sales.Invoices']])
    const attributes = sections.get('ERWIN_ATTRIBUTE')!
    const props = sections.get('DOMAIN_PROP_VALUE')!
    const prop = (id: string, name: string) => props.find((row) => row[0] === id && row[5] === name)!
    const column = (entity: string, name: string) => attributes.find((row) => row[4] === entity && prop(row[0], 'CD_NAM')[9] === name)!
    // Order_Items: PK,FK Order_Id migrated through the identifying relationship from Orders.Id.
    const orderId = column('4', 'Order_Id'), ordersId = column('3', 'Id')
    expect([orderId[3], orderId[6], orderId[7], orderId[8]]).toEqual(['AT_PK', '3', 'RT_ID', ordersId[0]])
    const customerId = column('3', 'Customer_Id')
    expect([customerId[3], customerId[7], customerId[8]]).toEqual(['AT_NK', 'RT_NI', column('1', 'Id')[0]])
    expect(column('3', 'Currency_Code')[8]).toBe(column('2', 'Code')[0])
    expect(column('6', 'Parent_Category_Id')[8]).toBe(column('6', 'Id')[0])
    // Physical types, nullability and the column's name.
    expect(prop(column('1', 'Name_Ar')[0], 'CD_TYP')[9]).toBe('nvarchar(250)')
    expect(prop(column('1', 'Name_Ar')[0], 'CD_NUL')[7]).toBe('0')
    expect(prop(column('1', 'Name_En')[0], 'CD_NUL')[7]).toBe('1')
    expect(prop(column('3', 'Total_Amount')[0], 'CD_TYP')[9]).toBe('decimal(18,2)')
    expect(sections.get('ERWIN_DOMAIN')!.find((row) => row[0] === column('3', 'Order_Date')[0])![3]).toBe('11')
    // Relationships: parent, child, cardinality, null rule.
    const relationships = sections.get('ERWIN_RELATIONSHIP')!
    expect(relationships.map((row) => [row[1], row[3], row[5], row[7], row[8], row[15]])).toEqual([
      ['RT_NI', '1', '3', 'places', 'CT_ZM', 'NR_NN'], ['RT_NI', '2', '3', 'prices', 'CT_ZM', 'NR_NN'], ['RT_ID', '3', '4', 'contains', 'CT_OM', 'NR_NN'],
      ['RT_NI', '5', '4', 'ordered as', 'CT_ZM', 'NR_NN'], ['RT_NI', '6', '5', 'groups', 'CT_ZM', 'NR_NA'], ['RT_NI', '6', '6', 'parent of', 'CT_ZM', 'NR_NA'],
      ['RT_NI', '3', '7', 'paid by', 'CT_ZM', 'NR_NN'], ['RT_NI', '3', '8', 'invoiced as', 'CT_ZO', 'NR_NN']])
    // Indexes: PK, alternate keys (composite U1 on Products) and one inversion entry per foreign key.
    const indexes = sections.get('ENTITY_INDEX')!, members = sections.get('INDEX_MEMBER')!
    expect(indexes.filter((row) => row[2] === '5').map((row) => [row[0], row[1], row[6]])).toEqual([['0', 'IT_PK', 'XPKsales_Products'], ['1', 'IT_AK', 'XAK1sales_Products'], ['5', 'IT_IF', 'XIF1sales_Products']])
    expect(members.filter((row) => row[1] === 'IT_AK' && row[2] === '5').map((row) => row[4])).toEqual([column('5', 'Sku')[0], column('5', 'Category_Id')[0]])
    expect(members.filter((row) => row[1] === 'IT_PK' && row[2] === '4').map((row) => row[4])).toEqual([orderId[0], column('4', 'Line_Number')[0]])
    expect(sections.get('INDEX_PHYSICAL_PV')!.filter((row) => row[2] === '5')).toHaveLength(6)
    expect(sections.get('ERWIN_DIAG_VIEW_OBJ')!.filter((row) => row[3].startsWith('ET_'))).toHaveLength(8)
  })

  it('reports views, adds missing FK columns and derives identifying relationships from the keys', async () => {
    const sample = bindForeignKeys(await parseEr(ER_SAMPLE_CODE))
    expect(sample.notes).toEqual(['1 view is not part of the ERX model (ERwin ERX carries tables only): sales.Customer_Order_Summary_View.'])
    expect(sample.foreignKeys.every((key) => !key.added)).toBe(true)
    const missing = bindForeignKeys(await parseEr('erDiagram\n  A {\n    bigint Id PK\n  }\n  B {\n    bigint Id PK\n  }\n  C {\n    int Line PK\n  }\n  A ||..o{ B : has\n  A ||--|{ C : owns'))
    const b = missing.entities.find((entity) => entity.id === 'B')!, c = missing.entities.find((entity) => entity.id === 'C')!
    expect(b.columns.map((column) => [column.name, column.pk, column.fk ?? null, column.notNull])).toEqual([['Id', true, null, true], ['A_Id', false, 1, true]])
    expect(c.columns.map((column) => [column.name, column.pk, column.fk ?? null])).toEqual([['Id', true, 1], ['Line', true, null]])
    expect(missing.notes).toEqual(['Added A_Id to B for its relationship to A.', 'Added Id to C for its relationship to A.'])
    const mismatch = bindForeignKeys(await parseEr('erDiagram\n  A {\n    bigint Id PK\n  }\n  B {\n    bigint Id PK\n    bigint A_Id FK\n  }\n  A ||--o{ B : has'))
    expect(mismatch.foreignKeys[0].identifying).toBe(false)
    expect(mismatch.notes).toEqual(['A - B is non-identifying because its FK columns are not part of B\'s primary key.'])
  })

  it('rejects models the ERX format cannot carry', async () => {
    await expect(parseEr('erDiagram\n  A {\n    bigint Code\n  }\n  B {\n    bigint Id PK\n  }\n  A ||..o{ B : has').then(generateErx)).rejects.toThrow('A needs a primary key for its relationship to B.')
    await expect(parseEr('erDiagram\n  V:::view {\n    bigint Id\n  }').then(generateErx)).rejects.toThrow('The ERX model needs at least one table')
    await expect(parseEr('erDiagram\n  A["جدول"] {\n    bigint Id PK\n  }').then(generateErx)).rejects.toThrow('ERX files are Windows-1252 text')
    // Quotes cannot come from Mermaid labels, but crafted models must still produce well-formed rows.
    const parsed = await parseEr('erDiagram\n  A {\n    bigint Id PK\n  }\n  B {\n    bigint Id PK\n    bigint A_Id FK\n  }\n  A ||..o{ B : has')
    const quoted = read(generateErx({ ...parsed, relationships: [{ ...parsed.relationships[0], label: 'says "hi"' }] }).bytes)
    expect(quoted.get('ERWIN_RELATIONSHIP')![0]).toHaveLength(23)
    expect(quoted.get('ERWIN_RELATIONSHIP')![0][7]).toBe("says 'hi'")
  })
})
