// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { parseEr, type ErModel } from './er'
import { generateErVsdx } from './erd-vsdx'
import { ERD_MASTER, erdTemplate } from './native'
import manifest from './native-erd/manifest.json'
import { ER_SAMPLE_CODE } from '../sample'

const STENCIL_UNIQUE_IDS: Record<number, string> = {
  2: '{1C7F4242-0002-0000-8E40-00608CF305B2}', 4: '{1C7F4262-0004-0000-8E40-00608CF305B2}', 5: '{1C7F4281-0005-0000-8E40-00608CF305B2}',
  11: '{51466C63-0002-0000-8E40-00608CF305B2}', 12: '{514672F8-0005-0000-8E40-00608CF305B2}', 13: '{5146701B-0004-0000-8E40-00608CF305B2}',
  14: '{514673D3-0006-0000-8E40-00608CF305B2}', 15: '{514676B0-0008-0000-8E40-00608CF305B2}',
}

async function documentIn(zip: JSZip, name: string): Promise<Document> {
  const source = await zip.file(name)!.async('string')
  expect(XMLValidator.validate(source), name).toBe(true)
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}

const directCell = (element: Element, name: string) => Array.from(element.children).find((entry) => entry.localName === 'Cell' && entry.getAttribute('N') === name)
const userCell = (element: Element, name: string) => element.querySelector(`:scope > Section[N="User"] > Row[N="${name}"] > Cell[N="Value"]`)

async function load(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const page = await documentIn(zip, 'visio/pages/page1.xml')
  const masters = new Map<string, Element>()
  for (const master of erdTemplate.masters) masters.set(String(master.id), (await documentIn(zip, `visio/masters/${master.file}`)).querySelector('Shapes > Shape')!)
  const masterOf = (shape: Element): Element | undefined => {
    if (shape.hasAttribute('Master')) return masters.get(shape.getAttribute('Master')!)
    const group = shape.parentElement?.closest('Shape[Master]')
    return group ? masters.get(group.getAttribute('Master')!)?.querySelector(`Shape[ID="${shape.getAttribute('MasterShape')}"]`) ?? undefined : undefined
  }
  // Visio's initial-open value: the instance's local or Inh-cached value, otherwise the master's cache.
  const value = (shape: Element, name: string) => {
    const cell = directCell(shape, name) ?? directCell(masterOf(shape)!, name)
    expect(cell, `${shape.getAttribute('NameU')}.${name}`).toBeDefined()
    return Number(cell!.getAttribute('V'))
  }
  const user = (shape: Element, name: string) => Number((userCell(shape, name) ?? userCell(masterOf(shape)!, name))!.getAttribute('V'))
  const top = Array.from(page.querySelector('PageContents > Shapes')!.children)
  const entities = top.filter((shape) => [String(ERD_MASTER.Entity), String(ERD_MASTER.View)].includes(shape.getAttribute('Master')!))
  const relationships = top.filter((shape) => shape.getAttribute('Master') === String(ERD_MASTER.Relationship))
  const parts = (group: Element) => Array.from(group.querySelectorAll(':scope > Shapes > Shape'))
  const name = (group: Element) => parts(group)[0].querySelector('Text')!.textContent!.trim()
  const box = (group: Element) => {
    const width = value(group, 'Width'), height = value(group, 'Height'), x = value(group, 'PinX'), y = value(group, 'PinY')
    return { left: x - width / 2, right: x + width / 2, bottom: y - height / 2, top: y + height / 2 }
  }
  const pages = await documentIn(zip, 'visio/pages/pages.xml')
  const pageSize = { width: Number(pages.querySelector('PageSheet > Cell[N="PageWidth"]')!.getAttribute('V')), height: Number(pages.querySelector('PageSheet > Cell[N="PageHeight"]')!.getAttribute('V')) }
  const path = (relationship: Element): [number, number][] => {
    const width = value(relationship, 'Width'), height = value(relationship, 'Height')
    const originX = value(relationship, 'PinX') - width / 2, originY = value(relationship, 'PinY') - height / 2
    expect(value(relationship, 'LocPinX')).toBeCloseTo(width / 2, 9)
    expect(value(relationship, 'LocPinY')).toBeCloseTo(height / 2, 9)
    return Array.from(relationship.querySelectorAll(':scope > Section[N="Geometry"] > Row')).map((row) => [
      originX + Number(row.querySelector('Cell[N="X"]')!.getAttribute('V')), originY + Number(row.querySelector('Cell[N="Y"]')!.getAttribute('V'))])
  }
  return { zip, page, pages, pageSize, entities, relationships, parts, name, box, value, user, path }
}

const model = (source: string) => parseEr(source)
const onEdge = (point: [number, number], box: { left: number; right: number; bottom: number; top: number }) =>
  (Math.abs(point[0] - box.left) < 1e-9 || Math.abs(point[0] - box.right) < 1e-9) && point[1] >= box.bottom - 1e-9 && point[1] <= box.top + 1e-9
  || (Math.abs(point[1] - box.bottom) < 1e-9 || Math.abs(point[1] - box.top) < 1e-9) && point[0] >= box.left - 1e-9 && point[0] <= box.right + 1e-9

// A wider schema: hub tables, a chain, long relationships across layers and a cycle.
const WIDE = `erDiagram
  H1 { bigint Id PK }
  H2 { bigint Id PK }
  ${Array.from({ length: 9 }, (_, index) => `T${index} {\n    bigint Id PK\n    bigint H1_Id FK "NOT NULL"\n    nvarchar(100) Name_${'x'.repeat(index * 3)}\n  }`).join('\n  ')}
  ${Array.from({ length: 9 }, (_, index) => `H1 ||..o{ T${index} : r${index}`).join('\n  ')}
  H2 ||..o{ T2 : a
  T2 ||--|{ T5 : b
  T5 ||..o{ T7 : c
  H2 ||..o| T7 : d
  T7 |o..o{ T2 : back`

describe('native Database Model Diagram package', () => {
  it('packages the authentic stencil masters and template settings without the add-on model or customer content', async () => {
    const { zip, pages } = await load(await generateErVsdx(await model(ER_SAMPLE_CODE)))
    expect(manifest.reference).toBe('A0FD84EBB3C1E3E3FD273D5E28BD1041E29B9CED297E97D3B186CBEDD87FAD6D')
    expect(await zip.file('visio/masters/masters.xml')!.async('string')).toBe(erdTemplate.mastersXml)
    for (const master of erdTemplate.masters) expect(await zip.file(`visio/masters/${master.file}`)!.async('string')).toBe(master.xml)
    const entries = Array.from((await documentIn(zip, 'visio/masters/masters.xml')).querySelectorAll('Master'))
    expect(entries.map((entry) => entry.getAttribute('NameU'))).toEqual(['Tracking Text', 'Dynamic Connector', 'Optional', 'Entity', 'View', 'Relationship', 'Parent to category', 'Category to child'])
    for (const entry of entries) expect(entry.getAttribute('UniqueID')).toBe(STENCIL_UNIQUE_IDS[Number(entry.getAttribute('ID'))])
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
    expect(files.some((name) => /docProps|thumbnail|embeddings|media|oleObject|\.emf$|\.bin$/.test(name))).toBe(false)
    const document = await documentIn(zip, 'visio/document.xml')
    expect(document.querySelector('SolutionXML, DocumentProperties')).toBeNull()
    // The template's database add-on events open the drawing as a Database Model Diagram (Database tab).
    expect(Array.from(document.querySelectorAll('EventList > EventItem')).map((item) => [item.getAttribute('EventCode'), item.getAttribute('Target'), item.getAttribute('TargetArgs')]))
      .toEqual([['2', 'DB Engineer', '/CMD=1'], ['1', 'DB Engineer', '/CMD=1'], ['1', 'DB Engineer', '/CMD=2003']])
    expect(Array.from(document.querySelectorAll('StyleSheet')).map((sheet) => sheet.getAttribute('NameU'))).toEqual(['No Style', 'Text Only', 'None', 'Normal', 'Guide', 'Theme', 'Connector'])
    expect(Array.from(document.querySelectorAll('FaceName')).map((face) => face.getAttribute('NameU'))).toEqual(['Calibri', 'Arial'])
    // Template parts carry only the stencil's own placeholder text, never the reference drawing's tables.
    for (const name of files.filter((entry) => !entry.startsWith('visio/pages/'))) {
      const content = await zip.file(name)!.async('string')
      expect(content, name).not.toMatch(/Database Model|oleObject/)
      const texts = Array.from(content.matchAll(/<Text>([\s\S]*?)<\/Text>/g), (match) => match[1].replace(/<[^>]+>/g, '').trim())
      expect(texts.filter((text) => !['', 'text', 'Table', 'View'].includes(text)), name).toEqual([])
    }
    for (const name of files.filter((entry) => entry.endsWith('.rels'))) expect(await zip.file(name)!.async('string')).not.toMatch(/TargetMode|oleObject|image|https?:\/\/(?!schemas\.)/)
    // Relational notation with crow's feet, the template's layers and its PK/annotation/type display options.
    const sheet = pages.querySelector('PageSheet')!
    expect(userCell(sheet, 'DBNotation')!.getAttribute('V')).toBe('2')
    expect(userCell(sheet, 'DBCrowsFoot')!.getAttribute('V')).toBe('1')
    expect(['DBHideAnnotations', 'DBHidePKRow', 'DBHideTypes'].map((cell) => userCell(sheet, cell)!.getAttribute('V'))).toEqual(['0', '0', '0'])
    expect(Array.from(sheet.querySelectorAll('Section[N="Layer"] Cell[N="Name"]')).map((cell) => cell.getAttribute('V'))).toEqual(['Relationships', 'Entities', 'Categories'])
  })

  it('writes native Entity and View instances with the template\'s PK compartment, tab stops and text styles', async () => {
    const { entities, parts, name, value, user } = await load(await generateErVsdx(await model(ER_SAMPLE_CODE), 'Sales ERD'))
    expect(entities.map((group) => [name(group), group.getAttribute('Master')])).toEqual([
      ['sales.Customers', '11'], ['cfg.Currencies', '11'], ['sales.Orders', '11'], ['sales.Order_Items', '11'], ['sales.Products', '11'],
      ['sales.Product_Categories', '11'], ['sales.Payments', '11'], ['sales.Invoices', '11'], ['sales.Customer_Order_Summary_View', '12']])
    for (const group of entities) {
      const [header, body] = parts(group)
      expect([header.getAttribute('MasterShape'), body.getAttribute('MasterShape')]).toEqual(['6', '7'])
      expect(value(group, 'Width')).toBeCloseTo(Math.max(0.5, user(header, 'Width'), user(body, 'Width')), 12)
      expect(value(group, 'Height')).toBeCloseTo(user(header, 'Height') + user(body, 'Height'), 12)
      expect(value(body, 'Width')).toBeCloseTo(value(group, 'Width'), 12)
      expect(value(header, 'PinY')).toBeCloseTo(value(group, 'Height') - value(header, 'Height'), 12)
      // Free-form entities: no model reference, so the master's own rule enables text editing and silences the add-on.
      expect(userCell(group, 'RefShapeGuid')).toBeNull()
      expect(userCell(group, 'ManualEdits')).toBeNull()
      expect(directCell(group, 'LayerMember')!.getAttribute('V')).toBe('1')
      expect(user(body, 'LineCount') * (10 / 72) * 1.2 + 1 / 9).toBeCloseTo(user(body, 'Height'), 9)
    }
    const items = entities[3]
    const body = parts(items)[1]
    expect(body.querySelector('Text')!.textContent).toBe('PK,FK1\tOrder_Id\tbigint\nPK\tLine_Number\tint\n\nFK2\tProduct_Id\tbigint\n \tQuantity\tdecimal(18,4)\n \tUnit_Price\tdecimal(18,2)\n')
    expect(user(body, 'PKCount')).toBe(2)
    expect(user(body, 'LineCount')).toBe(6)
    expect(['DBHidePKSeperatorLine', 'DBHideTabLine1', 'DBHideTabLine2'].map((cell) => user(body, cell))).toEqual([0, 0, 0])
    const tabs = ['Position0', 'Position1'].map((cell) => Number(body.querySelector(`Section[N="Tabs"] Cell[N="${cell}"]`)!.getAttribute('V')))
    expect(tabs[0]).toBeGreaterThan(0.3)
    expect(tabs[1]).toBeGreaterThan(tabs[0] + 0.5)
    expect(value(body, 'Width')).toBeGreaterThan(tabs[1] + 0.3)
    const geometry = (ix: number, cell: string) => Number(body.querySelector(`Section[N="Geometry"][IX="${ix}"] Row[IX="1"] Cell[N="${cell}"]`)!.getAttribute('V'))
    expect([geometry(1, 'X'), geometry(2, 'X')]).toEqual(tabs)
    // PK separator: the master's own formula, halfway through the empty line below the key rows.
    const line = user(body, 'LineHeight'), height = value(body, 'Height')
    expect(line).toBeCloseTo(height / 6, 12)
    expect(geometry(3, 'Y')).toBeCloseTo((height - line * 2 + line * (6 - 1 - 2)) / 2, 12)
    // Bold rows (row 0), bold underlined key names (row 1) and regular nullable rows (row 2).
    expect(Array.from(body.querySelectorAll('Section[N="Character"] > Row')).map((row) => row.querySelector('Cell[N="Style"]')!.getAttribute('V'))).toEqual(['1', '5', '0'])
    const runs = Array.from(body.querySelector('Text')!.childNodes).filter((node) => node.nodeType === 1 && (node as Element).tagName === 'cp')
      .map((node) => [(node as Element).getAttribute('IX'), node.nextSibling?.textContent?.split('\t')[0]])
    expect(runs).toContainEqual(['1', 'Order_Id'])
    expect(runs).toContainEqual(['1', 'Line_Number'])
    const customers = parts(entities[0])[1]
    expect(customers.querySelector('Text')!.textContent).toContain(' \tName_Ar\tnvarchar(250)\n')
    const nullable = Array.from(customers.querySelector('Text')!.childNodes).find((node) => node.nodeType === 3 && node.textContent!.startsWith(' \tName_Ar'))!
    expect((nullable.previousSibling as Element).getAttribute('IX')).toBe('2')
    // Views: no key column, a single divider and no PK separator.
    const view = parts(entities[8])[1]
    expect(view.querySelector('Text')!.textContent).toBe('Customer_Id\tbigint\nName_En\tnvarchar(250)\nOrder_Count\tint\nTotal_Amount\tdecimal(18,2)\n')
    expect(['PKCount', 'DBHidePKSeperatorLine', 'DBHideTabLine1', 'DBHideTabLine2'].map((cell) => user(view, cell))).toEqual([-1, 1, 0, 1])
    expect(view.querySelector('Section[N="Tabs"] Cell[N="Position1"]')).toBeNull()
  })

  it('glues every relationship to its parent and child with native crow\'s-foot ends and orthogonal paths', async () => {
    const parsed = await model(ER_SAMPLE_CODE)
    const { page, entities, relationships, name, box, value, user, path } = await load(await generateErVsdx(parsed))
    expect(relationships).toHaveLength(8)
    const ids = new Map(entities.map((group) => [group.getAttribute('ID'), group]))
    const connects = Array.from(page.querySelectorAll('Connect'))
    expect(connects).toHaveLength(16)
    const expected = { one: 25, zeroOrOne: 30, oneOrMore: 28, zeroOrMore: 29 }
    relationships.forEach((relationship, index) => {
      const source = parsed.relationships[index]
      const id = relationship.getAttribute('ID')
      const begin = connects.find((connect) => connect.getAttribute('FromSheet') === id && connect.getAttribute('FromCell') === 'BeginX')!
      const end = connects.find((connect) => connect.getAttribute('FromSheet') === id && connect.getAttribute('FromCell') === 'EndX')!
      expect([begin.getAttribute('FromPart'), begin.getAttribute('ToPart'), begin.getAttribute('ToCell'), end.getAttribute('FromPart'), end.getAttribute('ToPart')]).toEqual(['9', '3', 'PinX', '12', '3'])
      const parent = ids.get(begin.getAttribute('ToSheet'))!, child = ids.get(end.getAttribute('ToSheet'))!
      expect(name(parent)).toBe(parsed.entities.find((entity) => entity.id === source.parent)!.name)
      expect(name(child)).toBe(parsed.entities.find((entity) => entity.id === source.child)!.name)
      expect(directCell(relationship, 'BeginX')!.getAttribute('F')).toBe('_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)')
      expect(directCell(relationship, 'BegTrigger')!.getAttribute('F')).toBe(`_XFTRIGGER(Sheet.${parent.getAttribute('ID')}!EventXFMod)`)
      expect(directCell(relationship, 'EndTrigger')!.getAttribute('F')).toBe(`_XFTRIGGER(Sheet.${child.getAttribute('ID')}!EventXFMod)`)
      // Arrowheads and dash pattern come from the master's own formulas over the User cells.
      expect(value(relationship, 'BeginArrow')).toBe(source.parentOptional ? 30 : 25)
      expect(value(relationship, 'EndArrow')).toBe(expected[source.childCardinality])
      expect(user(relationship, 'DBCardinality')).toBe(expected[source.childCardinality])
      expect(value(relationship, 'LinePattern')).toBe(source.identifying ? 1 : 9)
      expect([user(relationship, 'DBNotation'), user(relationship, 'CrowsFoot'), user(relationship, 'ManualEdits')]).toEqual([2, 1, 1])
      expect(directCell(relationship, 'HideText')!.getAttribute('V')).toBe('1')
      expect(relationship.querySelector(':scope > Text')!.textContent).toBe(source.label)
      const points = path(relationship)
      const start: [number, number] = [value(relationship, 'BeginX'), value(relationship, 'BeginY')], finish: [number, number] = [value(relationship, 'EndX'), value(relationship, 'EndY')]
      expect(points[0][0]).toBeCloseTo(start[0], 9); expect(points[0][1]).toBeCloseTo(start[1], 9)
      expect(points[points.length - 1][0]).toBeCloseTo(finish[0], 9); expect(points[points.length - 1][1]).toBeCloseTo(finish[1], 9)
      expect(onEdge(start, box(parent)), `${name(parent)} begin`).toBe(true)
      expect(onEdge(finish, box(child)), `${name(child)} end`).toBe(true)
      for (let segment = 1; segment < points.length; segment++) {
        const horizontal = Math.abs(points[segment][1] - points[segment - 1][1]) < 1e-9, vertical = Math.abs(points[segment][0] - points[segment - 1][0]) < 1e-9
        expect(horizontal || vertical, `${relationship.getAttribute('NameU')} segment ${segment}`).toBe(true)
      }
      if (Math.abs(finish[0] - start[0]) < 1e-9) expect(directCell(relationship, 'Width')!.getAttribute('F')).toBe('GUARD(0.19685039370079DL)')
      if (Math.abs(finish[1] - start[1]) < 1e-9) expect(directCell(relationship, 'Height')!.getAttribute('F')).toBe('GUARD(0.19685039370079DL)')
    })
    // The self-relationship loops out of one side of its table and back in.
    const self = relationships[parsed.relationships.findIndex((relationship) => relationship.parent === relationship.child)]
    expect(path(self)).toHaveLength(4)
  })

  it.each([['sample', ER_SAMPLE_CODE], ['wide schema', WIDE], ['left-to-right schema', WIDE.replace('erDiagram', 'erDiagram\n  direction LR')]])(
    'lays out the %s without overlapping tables or routing through unrelated tables', async (_, source) => {
      const { pageSize, entities, relationships, box, path, page } = await load(await generateErVsdx(await model(source)))
      const boxes = entities.map(box)
      for (const item of boxes) {
        expect(item.left).toBeGreaterThanOrEqual(0.99); expect(item.bottom).toBeGreaterThanOrEqual(0.99)
        expect(item.right).toBeLessThanOrEqual(pageSize.width - 0.99); expect(item.top).toBeLessThanOrEqual(pageSize.height - 0.99)
      }
      for (let first = 0; first < boxes.length; first++) for (let second = first + 1; second < boxes.length; second++) {
        const [a, b] = [boxes[first], boxes[second]]
        expect(a.right < b.left || b.right < a.left || a.top < b.bottom || b.top < a.bottom, `tables ${first} and ${second} overlap`).toBe(true)
      }
      const connects = Array.from(page.querySelectorAll('Connect'))
      for (const relationship of relationships) {
        const glued = new Set(connects.filter((connect) => connect.getAttribute('FromSheet') === relationship.getAttribute('ID')).map((connect) => connect.getAttribute('ToSheet')))
        const points = path(relationship)
        for (const [position, group] of entities.entries()) {
          if (glued.has(group.getAttribute('ID'))) continue
          const item = boxes[position]
          for (let segment = 1; segment < points.length; segment++) {
            const [a, b] = [points[segment - 1], points[segment]]
            const crosses = Math.max(a[0], b[0]) > item.left && Math.min(a[0], b[0]) < item.right && Math.max(a[1], b[1]) > item.bottom && Math.min(a[1], b[1]) < item.top
            expect(crosses, `${relationship.getAttribute('NameU')} crosses table ${position}`).toBe(false)
          }
        }
        for (const point of points) {
          expect(point[0]).toBeGreaterThan(0); expect(point[0]).toBeLessThan(pageSize.width)
          expect(point[1]).toBeGreaterThan(0); expect(point[1]).toBeLessThan(pageSize.height)
        }
      }
    })

  it('runs left-to-right diagrams from the parent\'s right edge to the child\'s left edge', async () => {
    const { relationships, box, entities, value } = await load(await generateErVsdx(await model('erDiagram\n  direction LR\n  A { bigint Id PK }\n  B {\n    bigint Id PK\n    bigint A_Id FK\n  }\n  A ||..o{ B : has')))
    const [a, b] = entities.map(box)
    expect(a.right).toBeLessThan(b.left)
    expect(value(relationships[0], 'BeginX')).toBeCloseTo(a.right, 9)
    expect(value(relationships[0], 'EndX')).toBeCloseTo(b.left, 9)
    expect(value(relationships[0], 'BeginY')).toBeCloseTo(value(relationships[0], 'EndY'), 9)
  })

  it('names the page after the diagram and rejects crafted models', async () => {
    const parsed = await model('erDiagram\n  A { bigint Id PK }')
    const { pages, relationships } = await load(await generateErVsdx(parsed, 'Billing & Accounts'))
    expect(pages.querySelector('Page')!.getAttribute('NameU')).toBe('Billing & Accounts')
    expect(relationships).toHaveLength(0)
    const broken: ErModel = { ...parsed, relationships: [{ parent: 'A', child: 'Missing', parentOptional: false, childCardinality: 'one', identifying: false, label: '' }] }
    await expect(generateErVsdx(broken)).rejects.toThrow('Invalid relationship.')
    await expect(generateErVsdx({ ...parsed, entities: [] })).rejects.toThrow('Invalid or oversized ER model.')
    await expect(generateErVsdx({ ...parsed, entities: [{ ...parsed.entities[0], name: 'bad\u0001name' }] })).rejects.toThrow('Invalid ER model text.')
  })
})
