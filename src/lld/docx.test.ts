// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { parseErd } from './parse'
import { sampleErd } from './fixture'
import { COLUMN_WIDTHS, renderDocx } from './docx'
import { buildDocument, dataType, friendlyType, readDescriptions, type Descriptions } from './descriptions'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const descriptions: Descriptions = {
  module: 'Billing',
  groups: [{ title: 'Bills', tables: ['bil.Bills', 'bil.Bills_Timeline'] }, { title: 'Payments', tables: ['bill.Payment_Notifications'] }],
  common: { Notes: "{entity}'s free-text notes" },
  tables: {
    'bil.Bills': { _entity: 'Bill', Bill_Number: "Bill's number", Due_Date: "Bill's due date" },
    'bil.Bills_Timeline': { _entity: 'Timeline entry', _display: 'Bill Timeline', _required: { Status_Lookup_Id: 'R' } },
    'bill.Payment_Notifications': { _uncertain: ['Provider_Status_Code'], Provider_Status_Code: 'Status code returned by the payment provider' },
  },
}

async function parts(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const xml = async (name: string) => {
    const source = await zip.file(name)!.async('string')
    expect(XMLValidator.validate(source), name).toBe(true)
    return new DOMParser().parseFromString(source, 'application/xml')
  }
  return { zip, document: await xml('word/document.xml'), numbering: await xml('word/numbering.xml'), styles: await xml('word/styles.xml') }
}
const all = (node: Document | Element, name: string) => Array.from(node.getElementsByTagNameNS(W, name))
const attr = (element: Element | undefined, name: string) => element?.getAttributeNS(W, name) ?? element?.getAttribute(`w:${name}`)
const textOf = (element: Element) => all(element, 't').map((node) => node.textContent).join('')

describe('LLD Word document', () => {
  it('resolves rows, sections and fallbacks from the schema and descriptions', async () => {
    const schema = await parseErd(await sampleErd(), 'Billing_ERD.vsdx')
    const { document, missing, uncertain } = buildDocument(schema, descriptions, { includeViews: true, friendlyTypes: false })
    expect(document.sections.map((section) => [section.title, section.tables.map((table) => table.fullName)])).toEqual([
      ['Bills', ['bil.Bills', 'bil.Bills_Timeline']], ['Payments', ['bill.Payment_Notifications']], ['Other Tables', ['bill.Payment_Matching']],
      ['Referenced Views', ['cfg.Courts_View', 'cfg.Banks_view']]])
    const [bills, timeline] = document.sections[0].tables
    expect(bills.displayName).toBe('Bills')
    expect(bills.rows).toEqual([
      { field: 'Id', dataType: 'bigint (PK)', ro: 'R', description: "Bill's unique identifier" },
      { field: 'Bill_Number', dataType: 'nvarchar(30)', ro: 'R', description: "Bill's number" },
      { field: 'Due_Date', dataType: 'datetime2(7)', ro: 'R', description: "Bill's due date" },
      { field: 'Notes', dataType: 'nvarchar(max)', ro: 'O', description: "Bill's free-text notes" }])
    expect(timeline.displayName).toBe('Bill Timeline')
    expect(timeline.rows.map((row) => [row.field, row.ro, row.description])).toEqual([
      ['Id', 'R', "Timeline entry's unique identifier"], ['Bill_Id', 'R', 'Reference to Bills'], ['Status_Lookup_Id', 'R', 'Status (lookup value)']])
    expect(document.sections[2].tables[0].rows[0]).toEqual({ field: 'Payment_Notifcation_Id', dataType: 'bigint (PK, FK)', ro: 'R', description: 'Reference to Payment_Notifications' })
    expect(document.sections[3].tables[0].rows.map((row) => row.ro)).toEqual(['-', '-'])
    expect(missing).toEqual([{ table: 'bill.Payment_Notifications', column: 'Reference' }, { table: 'cfg.Courts_View', column: 'Name_En' }])
    expect(uncertain).toEqual([{ table: 'bill.Payment_Notifications', column: 'Provider_Status_Code' }])
    expect(buildDocument(schema, descriptions, { includeViews: false, friendlyTypes: true }).document.sections.map((section) => section.title)).not.toContain('Referenced Views')
  })

  it('tags key columns and optionally uses friendly data types', () => {
    const column = { name: 'Code', type: 'nvarchar(13)', keys: ['PK', 'FK1', 'U1'], pk: true, fk: true, unique: true, required: true }
    expect(dataType(column)).toBe('nvarchar(13) (PK, FK, UK)')
    expect(dataType({ ...column, pk: false, fk: false }, true)).toBe('string(13) (UK)')
    expect(['bit', 'datetime2(7)', 'datetime', 'uniqueidentifier', 'bigint', 'nvarchar(max)', 'decimal(18,2)'].map(friendlyType))
      .toEqual(['boolean', 'datetime', 'datetime', 'guid', 'integer', 'text', 'decimal(18,2)'])
  })

  it('writes the template layout: A4, headings, real bullets and fixed 4-column tables', async () => {
    const schema = await parseErd(await sampleErd(), 'Billing_ERD.vsdx')
    const { document: model } = buildDocument(schema, descriptions, { includeViews: true, friendlyTypes: false })
    const { zip, document, numbering, styles } = await parts(await renderDocx(model))
    expect(Object.keys(zip.files).sort()).toEqual(['[Content_Types].xml', '_rels/', '_rels/.rels', 'word/', 'word/_rels/', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/numbering.xml', 'word/settings.xml', 'word/styles.xml'])
    const section = all(document, 'sectPr')[0]
    expect([attr(all(section, 'pgSz')[0], 'w'), attr(all(section, 'pgSz')[0], 'h')]).toEqual(['11906', '16838'])
    expect(['top', 'right', 'bottom', 'left'].map((side) => attr(all(section, 'pgMar')[0], side))).toEqual(['1440', '1440', '1440', '1440'])
    const fonts = all(styles, 'rPrDefault')[0]
    expect([attr(all(fonts, 'rFonts')[0], 'ascii'), attr(all(fonts, 'sz')[0], 'val')]).toEqual(['Calibri', '22'])
    const style = (id: string) => all(styles, 'style').find((entry) => attr(entry, 'styleId') === id)!
    expect([attr(all(style('Heading1'), 'sz')[0], 'val'), attr(all(style('Heading1'), 'color')[0], 'val'), all(style('Heading1'), 'b').length]).toEqual(['32', '002060', 1])
    expect([attr(all(style('Heading2'), 'sz')[0], 'val'), attr(all(style('Heading2'), 'color')[0], 'val'), all(style('Heading2'), 'keepNext').length]).toEqual(['26', '002060', 1])
    const paragraphs = all(document, 'p').filter((paragraph) => paragraph.parentElement?.localName === 'body')
    expect(textOf(paragraphs[0])).toBe('Detailed Field Description – Billing Module')
    expect(textOf(paragraphs[1])).toBe('Generated from Billing_ERD.vsdx. R = Required (NOT NULL), O = Optional. PK = Primary Key, FK = Foreign Key, UK = Unique Key.')
    expect(all(paragraphs[1], 'i').length).toBe(1)
    expect(paragraphs.filter((paragraph) => attr(all(paragraph, 'pStyle')[0], 'val') === 'Heading2').map(textOf)).toEqual(['Bills', 'Payments', 'Other Tables', 'Referenced Views'])
    expect(paragraphs.map(textOf)).toContain('Read-only views exposed by other modules and consumed by this module. Nullability is defined by the source module.')
    // Bulleted table headings: real numbering, bold 12 pt name, gray 10 pt (schema.Table), kept with the table.
    const level = all(numbering, 'lvl')[0]
    expect([attr(all(level, 'numFmt')[0], 'val'), attr(all(level, 'lvlText')[0], 'val'), attr(all(level, 'ind')[0], 'left'), attr(all(level, 'ind')[0], 'hanging')]).toEqual(['bullet', '▪', '1080', '360'])
    const bullets = paragraphs.filter((paragraph) => all(paragraph, 'numPr').length)
    expect(bullets.map(textOf)).toEqual(['Bills  (bil.Bills)', 'Bill Timeline  (bil.Bills_Timeline)', 'Payment Notifications  (bill.Payment_Notifications)',
      'Payment Matching  (bill.Payment_Matching)', 'Courts View  (cfg.Courts_View)', 'Banks view  (cfg.Banks_view)'])
    for (const bullet of bullets) {
      const [name, schemaRun] = all(bullet, 'r')
      expect([all(name, 'b').length, attr(all(name, 'sz')[0], 'val'), attr(all(schemaRun, 'sz')[0], 'val'), attr(all(schemaRun, 'color')[0], 'val'), all(bullet, 'keepNext').length]).toEqual([1, '24', '20', '595959', 1])
      expect(bullet.nextElementSibling?.localName).toBe('tbl')
    }
    const tables = all(document, 'tbl')
    expect(tables).toHaveLength(6)
    for (const table of tables) {
      expect(attr(all(table, 'tblW')[0], 'w')).toBe('9026')
      expect(attr(all(table, 'tblLayout')[0], 'type')).toBe('fixed')
      expect(all(table, 'gridCol').map((column) => Number(attr(column, 'w')))).toEqual([...COLUMN_WIDTHS])
      const borders = all(all(table, 'tblBorders')[0], '*')
      expect(borders.map((border) => border.localName)).toEqual(['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
      for (const border of borders) expect([attr(border, 'val'), attr(border, 'sz'), attr(border, 'color')]).toEqual(['single', '4', '8EAADB'])
      const margins = all(table, 'tblCellMar')[0]
      expect(['top', 'left', 'bottom', 'right'].map((side) => attr(all(margins, side)[0], 'w'))).toEqual(['50', '100', '50', '100'])
      const rows = all(table, 'tr')
      const header = rows[0]
      expect([all(header, 'tblHeader').length, all(header, 'cantSplit').length]).toEqual([1, 1])
      expect(all(header, 'tc').map(textOf)).toEqual(['Field', 'Data Type', 'Required/ Optional', 'Description'])
      for (const cell of all(header, 'tc')) {
        const shade = all(cell, 'shd')[0]
        expect([attr(shade, 'val'), attr(shade, 'fill'), attr(all(cell, 'color')[0], 'val'), all(cell, 'b').length, attr(all(cell, 'jc')[0], 'val')]).toEqual(['clear', '002060', 'FFFFFF', 1, 'center'])
      }
      for (const row of rows) {
        expect(all(row, 'cantSplit').length).toBe(1)
        all(row, 'tc').forEach((cell, index) => {
          expect(Number(attr(all(cell, 'tcW')[0], 'w'))).toBe(COLUMN_WIDTHS[index])
          expect(attr(all(cell, 'vAlign')[0], 'val')).toBe('center')
          expect(attr(all(cell, 'sz')[0], 'val')).toBe('20')
          if (index === 2) expect(attr(all(cell, 'jc')[0], 'val')).toBe('center')
        })
      }
    }
    const fields = tables.flatMap((table) => all(table, 'tr').slice(1).map((row) => textOf(all(row, 'tc')[0])))
    expect(fields).toEqual(schema.tables.flatMap((table) => table.columns.map((column) => column.name)))
  })

  it('validates uploaded descriptions.json', () => {
    expect(readDescriptions(JSON.stringify(descriptions))).toEqual(descriptions)
    expect(() => readDescriptions('{')).toThrow('not valid JSON')
    expect(() => readDescriptions('{"groups":[]}')).toThrow('"module"')
    expect(() => readDescriptions('{"module":"B","groups":[{"title":"x"}]}')).toThrow('"tables" list')
    expect(() => readDescriptions('{"module":"B","tables":{"a.T":{"_required":{"Id":"X"}}}}')).toThrow('Invalid "_required"')
    expect(readDescriptions('{"module":"B"}')).toEqual({ module: 'B', groups: [], common: {}, tables: {} })
  })
})
