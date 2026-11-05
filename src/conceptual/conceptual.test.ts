// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { parseErd } from '../lld/parse'
import { buildErd } from '../lld/fixture'
import { conceptModel, conceptName } from './model'
import { generateConceptualVsdx } from './vsdx'
import { CONCEPT_MASTER, conceptualTemplate } from '../converter/native'
import manifest from '../converter/native-conceptual/manifest.json'

const VISIO = 'http://schemas.microsoft.com/office/visio/2012/main'
const pk = "<cp IX='0'/>PK\tId\tbigint\n\n"
// A small sales model with every rule: parts, a part with two mandatory parents, roots, references, optional links.
const erd = () => buildErd([{ name: 'Sales', entities: [
  { id: 10, name: 'sal.Orders', styles: { 0: 1 }, body: `${pk}FK1\tCustomer_Id\tbigint\nFK2\tTariff_Id\tbigint\n` },
  { id: 20, name: 'sal.Order_Lines', styles: { 0: 1 }, body: `${pk}FK1\tOrder_Id\tbigint\n` },
  { id: 30, name: 'sal.Order_Notes', styles: { 0: 1 }, body: `${pk}FK1\tOrder_Id\tbigint\n` },
  { id: 40, name: 'sal.Customers', styles: { 0: 1 }, body: pk },
  { id: 50, name: 'cfg.Tariffs', styles: { 0: 1 }, body: pk },
  { id: 60, name: 'sal.Sales_Reports', styles: { 0: 1 }, body: pk },
  { id: 70, name: 'sal.Sales_Report_Details', styles: { 0: 1 }, body: `${pk}FK1\tSales_Report_Id\tbigint\nFK2\tOrder_Id\tbigint\n` },
  { id: 80, name: 'sal.Shipments', styles: { 0: 1, 1: 0 }, body: `${pk}<cp IX='1'/>FK1\tOrder_Id\tbigint\n` },
  { id: 90, name: 'sal.Orders_View', styles: { 0: 0 }, body: "<cp IX='0'/>Id\tbigint\n" },
], connectors: [
  { id: 100, begin: 10, end: 20, ends: [25, 28] }, { id: 101, begin: 10, end: 30, ends: [25, 30] }, { id: 102, begin: 40, end: 10, ends: [25, 29] },
  { id: 103, begin: 50, end: 10, ends: [30, 29] }, { id: 104, begin: 60, end: 70, ends: [25, 29] }, { id: 105, begin: 10, end: 70, ends: [25, 29] },
  { id: 106, begin: 10, end: 80, ends: [30, 29] },
] }])

async function parts(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const xml = async (name: string) => {
    const source = await zip.file(name)!.async('string')
    expect(XMLValidator.validate(source), name).toBe(true)
    return new DOMParser().parseFromString(source, 'application/xml')
  }
  return { zip, xml }
}
const cell = (shape: Element, name: string) => Array.from(shape.children).find((entry) => entry.localName === 'Cell' && entry.getAttribute('N') === name)

describe('ERD to conceptual diagram', () => {
  it('names entities in business terms and derives composition, association and directed links', async () => {
    const parsed = await parseErd(await erd(), 'Sales_ERD.vsdx')
    expect(parsed.ends.map((end) => [end.parentEnd, end.childEnd])).toEqual([[25, 28], [25, 30], [25, 29], [30, 29], [25, 29], [25, 29], [30, 29]])
    const model = conceptModel(parsed, 'Sales')
    expect(model.entities.map((entity) => entity.name)).toEqual(['Order', 'Order Line', 'Order Note', 'Customer', 'Tariff', 'Sales Report', 'Sales Report Detail', 'Shipment'])
    const name = new Map(model.entities.map((entity) => [entity.id, entity.name]))
    expect(model.links.map((link) => [link.kind, name.get(link.from), link.fromMultiplicity, name.get(link.to), link.toMultiplicity, link.label])).toEqual([
      ['composition', 'Order', '1', 'Order Line', '1..*', 'owns'],
      ['composition', 'Order', '1', 'Order Note', '0..1', 'owns'],
      // Order owns parts, so it is a root: its mandatory parents become references, drawn from the referencing Order.
      ['directed', 'Order', '*', 'Customer', '1', ''],
      // A NOT NULL FK makes the parent end 1, even where the ERD line shows an optional end.
      ['directed', 'Order', '*', 'Tariff', '1', ''],
      // Two mandatory parents: the one the part's name extends owns it.
      ['composition', 'Sales Report', '1', 'Sales Report Detail', '*', 'owns'],
      ['association', 'Order', '1', 'Sales Report Detail', '*', ''],
      // A nullable FK is an association with an optional parent.
      ['association', 'Order', '0..1', 'Shipment', '*', ''],
    ])
    expect(conceptName({ ...parsed.tables[0], name: 'Bills_Timeline' })).toBe('Bill Timeline')
  })

  it('writes the template masters, themes and UML Class events without the reference model', async () => {
    const { zip, xml } = await parts(await generateConceptualVsdx(conceptModel(await parseErd(await erd(), 'Sales_ERD.vsdx'), 'Sales'), 'Sales'))
    expect(manifest.reference).toBe('DFED5D95041F71B5D93050E437E22EF085A17166F9D431214EE7736CEE11E869')
    expect(await zip.file('visio/masters/masters.xml')!.async('string')).toBe(conceptualTemplate.mastersXml)
    for (const master of conceptualTemplate.masters) expect(await zip.file(`visio/masters/${master.file}`)!.async('string')).toBe(master.xml)
    expect(conceptualTemplate.masters.map((master) => master.nameU)).toEqual(['Composite', 'Association', 'Rectangle', 'Composition.34', 'Rectangle.41', 'Directed Association'])
    expect(Object.keys(zip.files).filter((name) => name.startsWith('visio/theme/')).sort()).toEqual(['visio/theme/', 'visio/theme/theme1.xml', 'visio/theme/theme2.xml'])
    const document = await xml('visio/document.xml')
    expect(Array.from(document.getElementsByTagNameNS(VISIO, 'EventItem')).map((item) => item.getAttribute('TargetArgs'))).toEqual(['/soln=UMLClass /cmd=DocOpened', '/soln=UMLClass /cmd=DocCreated'])
    expect(document.getElementsByTagNameNS(VISIO, 'DocumentProperties')).toHaveLength(0)
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
    expect(files.some((name) => /docProps|thumbnail|\.emf$|\.bin$/.test(name))).toBe(false)
    for (const name of files.filter((entry) => !entry.startsWith('visio/pages/'))) expect(await zip.file(name)!.async('string'), name).not.toMatch(/Bill|Refund|Payment/)
  })

  it('places glued UML connectors with multiplicities between rectangles inside the module boundary', async () => {
    const model = conceptModel(await parseErd(await erd(), 'Sales_ERD.vsdx'), 'Sales')
    model.entities.find((entity) => entity.id === 'sal.Shipments')!.include = false
    const { xml } = await parts(await generateConceptualVsdx(model, 'Sales'))
    const page = await xml('visio/pages/page1.xml')
    const shapes = Array.from(page.getElementsByTagNameNS(VISIO, 'Shapes')[0].children)
    const byMaster = (master: number) => shapes.filter((shape) => shape.getAttribute('Master') === String(master))
    const entities = byMaster(CONCEPT_MASTER.Entity)
    expect(entities.map((shape) => shape.querySelector(':scope > Text')!.textContent)).toEqual(['Order', 'Order Line', 'Order Note', 'Customer', 'Tariff', 'Sales Report', 'Sales Report Detail'])
    expect([byMaster(CONCEPT_MASTER.Composition).length, byMaster(CONCEPT_MASTER.Association).length, byMaster(CONCEPT_MASTER.DirectedAssociation).length, byMaster(CONCEPT_MASTER.Boundary).length]).toEqual([3, 1, 2, 1])
    const value = (shape: Element, name: string) => Number(cell(shape, name)!.getAttribute('V'))
    const box = (shape: Element) => ({ left: value(shape, 'PinX') - value(shape, 'Width') / 2, right: value(shape, 'PinX') + value(shape, 'Width') / 2,
      bottom: value(shape, 'PinY') - value(shape, 'Height') / 2, top: value(shape, 'PinY') + value(shape, 'Height') / 2 })
    const boundary = box(byMaster(CONCEPT_MASTER.Boundary)[0])
    for (const entity of entities) {
      const item = box(entity)
      expect(item.left > boundary.left && item.right < boundary.right && item.bottom > boundary.bottom && item.top < boundary.top).toBe(true)
      expect(cell(entity, 'FillForegnd')!.getAttribute('V')).toBe('#9acfe8')
    }
    const ids = new Map(entities.map((shape) => [shape.getAttribute('ID'), shape]))
    const connects = Array.from(page.getElementsByTagNameNS(VISIO, 'Connect'))
    expect(connects).toHaveLength(12)
    for (const link of [...byMaster(CONCEPT_MASTER.Composition), ...byMaster(CONCEPT_MASTER.Association), ...byMaster(CONCEPT_MASTER.DirectedAssociation)]) {
      const id = link.getAttribute('ID')
      for (const [end, part] of [['Begin', '9'], ['End', '12']] as const) {
        const connect = connects.find((entry) => entry.getAttribute('FromSheet') === id && entry.getAttribute('FromCell') === `${end}X`)!
        expect([connect.getAttribute('FromPart'), connect.getAttribute('ToPart')]).toEqual([part, '3'])
        const target = box(ids.get(connect.getAttribute('ToSheet'))!)
        const [x, y] = [value(link, `${end}X`), value(link, `${end}Y`)]
        const onEdge = (Math.abs(y - target.top) < 1e-9 || Math.abs(y - target.bottom) < 1e-9) && x >= target.left - 1e-9 && x <= target.right + 1e-9
        expect(onEdge, `${link.getAttribute('NameU')} ${end}`).toBe(true)
        expect(cell(link, `${end}X`)!.getAttribute('F')).toMatch(/^_WALKGLUE\(/)
      }
      // Multiplicities in the master's sub-shapes 7 (begin) and 9 (end); role names removed; multiplicities shown.
      const subs = Array.from(link.getElementsByTagNameNS(VISIO, 'Shape'))
      expect(subs.filter((sub) => sub.getAttribute('Del') === '1').map((sub) => sub.getAttribute('MasterShape'))).toEqual(['6', '8'])
      expect(subs.filter((sub) => !sub.getAttribute('Del')).map((sub) => [sub.getAttribute('MasterShape'), sub.querySelector(':scope > Text')!.textContent!.length > 0])).toEqual([['7', true], ['9', true]])
      expect(link.querySelector(':scope > Section[N="User"] > Row[N="ShowMulti"] > Cell')!.getAttribute('V')).toBe('1')
    }
    expect(byMaster(CONCEPT_MASTER.Composition).map((link) => link.querySelector(':scope > Text')!.textContent)).toEqual(['owns', 'owns', 'owns'])
  })

  it('rejects empty or broken models', async () => {
    const model = conceptModel(await parseErd(await erd(), 'Sales_ERD.vsdx'), 'Sales')
    await expect(generateConceptualVsdx({ ...model, entities: model.entities.map((entity) => ({ ...entity, include: false })) })).rejects.toThrow('Include at least one entity.')
    await expect(generateConceptualVsdx({ ...model, links: [{ ...model.links[0], to: 'missing' }] })).rejects.toThrow('Invalid relationship.')
    await expect(generateConceptualVsdx({ ...model, module: 'bad\u0001' })).rejects.toThrow('Invalid conceptual model text.')
  })
})
