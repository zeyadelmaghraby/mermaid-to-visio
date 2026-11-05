import JSZip from 'jszip'
import type { ConceptLink, ConceptModel } from './model'
import { MULTIPLICITIES } from './model'
import { calibriWidth } from '../converter/calibri'
import { CONCEPT_MASTER, conceptualTemplate, escapeXml, resolveInstance, type InstanceSpec, type Override } from '../converter/native'
import { along, layout, type Point } from '../converter/layout'
import conceptualManifest from '../converter/native-conceptual/manifest.json'
import pageTemplate from '../converter/native-conceptual/page.json'
import theme1 from '../converter/native-conceptual/theme1.xml?raw'
import theme2 from '../converter/native-conceptual/theme2.xml?raw'
import { NS, OFFICE_REL, VISIO_REL, number, relationships, xmlDeclaration } from '../converter/vsdx'

// Entity boxes as in the reference conceptual diagram: 2.25 x 1.54 in, wider (2.92) and taller (2.0) for long names.
const NAME_SIZE = 24 / 72
const BOX = { width: 2.25, wide: 2.92, height: 1.54, tall: 2.0 }
const TEXT_MARGIN = 0.2
// Multiplicity anchors sit this far along the connector from each end (past the composition diamond).
const END_OFFSET = 0.116
const BOUNDARY_PADDING = 0.6
const THEMES: Record<string, string> = { 'theme1.xml': theme1, 'theme2.xml': theme2 }
const KIND_MASTER = { composition: CONCEPT_MASTER.Composition, association: CONCEPT_MASTER.Association, directed: CONCEPT_MASTER.DirectedAssociation }

const v = (value: number | string, formula?: string): Override => ({ V: value, ...(formula ? { F: formula } : {}) })

function plainText(value: string, max: number) {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
  })) throw new Error('Invalid conceptual model text.')
}

function validateModel(model: ConceptModel) {
  if (!model || !Array.isArray(model.entities) || !Array.isArray(model.links) || model.entities.length > 300 || model.links.length > 600) throw new Error('Invalid or oversized conceptual model.')
  plainText(model.module, 120)
  const ids = new Set(model.entities.map((entity) => entity.id))
  if (ids.size !== model.entities.length) throw new Error('Duplicate entity IDs.')
  for (const entity of model.entities) { plainText(entity.id, 200); plainText(entity.name, 200) }
  for (const link of model.links) {
    if (!ids.has(link.from) || !ids.has(link.to) || !(link.kind in KIND_MASTER)) throw new Error('Invalid relationship.')
    plainText(link.label, 120); plainText(link.fromMultiplicity, 20); plainText(link.toMultiplicity, 20)
  }
  if (!model.entities.some((entity) => entity.include)) throw new Error('Include at least one entity.')
}

// Box size for a name in 24 pt bold: two lines fit the standard box, longer names get the wide or tall box.
function boxFor(name: string) {
  const lines = (width: number) => {
    let count = 1, line = 0
    for (const word of name.split(/\s+/)) {
      const size = calibriWidth(word, NAME_SIZE, true), space = calibriWidth(' ', NAME_SIZE, true)
      if (line && line + space + size > width - TEXT_MARGIN) { count++; line = size } else line += (line ? space : 0) + size
    }
    return count
  }
  if (lines(BOX.width) <= 2) return { width: BOX.width, height: BOX.height }
  return { width: BOX.wide, height: lines(BOX.wide) <= 2 ? BOX.height : BOX.tall }
}

export async function generateConceptualVsdx(model: ConceptModel, title = 'Conceptual Diagram'): Promise<Uint8Array> {
  validateModel(model)
  plainText(title, 200)
  const entities = model.entities.filter((entity) => entity.include)
  const included = new Set(entities.map((entity) => entity.id))
  const links = model.links.filter((link) => included.has(link.from) && included.has(link.to))
  const sizes = new Map(entities.map((entity) => [entity.id, boxFor(entity.name)]))
  // Layers run from the owner / referenced entity down to its parts and dependants.
  const edges = links.map((link) => link.kind === 'directed' ? { parent: link.to, child: link.from, link } : { parent: link.from, child: link.to, link })
  // Ownership, references and mandatory associations shape the layers; optional associations are only routed.
  const placed = layout('TB', entities.map((entity) => ({ id: entity.id, ...sizes.get(entity.id)! })), edges,
    (edge) => edge.link.kind !== 'association' || edge.link.fromMultiplicity === '1')
  const offset = BOUNDARY_PADDING
  const pageWidth = placed.pageWidth + 2 * offset, pageHeight = placed.pageHeight + 2 * offset
  const shift = ([x, y]: Point): Point => [x + offset, y + offset]

  let nextId = 1
  const allocate = () => nextId++
  const shapeIds = new Map<string, number>()
  const used = new Set<number>()
  const resolve = (spec: InstanceSpec) => { used.add(spec.master); return resolveInstance(spec, allocate) }

  // Module boundary: the template's dashed teal Rectangle around the whole model.
  const boxes = [...placed.boxes.values()].map((box) => ({ ...box, left: box.left + offset, top: box.top + offset }))
  const left = Math.min(...boxes.map((box) => box.left)) - BOUNDARY_PADDING, right = Math.max(...boxes.map((box) => box.left + box.width)) + BOUNDARY_PADDING
  const top = Math.max(...boxes.map((box) => box.top)) + BOUNDARY_PADDING, bottom = Math.min(...boxes.map((box) => box.top - box.height)) - BOUNDARY_PADDING
  const boundaryXml = resolve({ id: allocate(), master: CONCEPT_MASTER.Boundary, template: conceptualTemplate, nameU: 'Boundary', cells: {
    PinX: v((left + right) / 2), PinY: v((top + bottom) / 2), Width: v(right - left), Height: v(top - bottom),
    LineWeight: v(6 / 72), LineColor: v('#3ec8b4', 'THEMEGUARD(RGB(62,200,180))'), LinePattern: v(2), FillPattern: v(0), FillGradientEnabled: v(0) } }).xml()

  const entityXml = entities.map((entity, index) => {
    const id = allocate()
    shapeIds.set(entity.id, id)
    const box = placed.boxes.get(entity.id)!, size = sizes.get(entity.id)!
    return resolve({ id, master: CONCEPT_MASTER.Entity, template: conceptualTemplate, nameU: `Entity.${index + 1}`, text: entity.name, cells: {
      PinX: v(box.left + offset + size.width / 2), PinY: v(box.top + offset - size.height / 2), Width: v(size.width), Height: v(size.height), ObjType: v(1),
      FillForegnd: v('#9acfe8', 'THEMEGUARD(MSOTINT(THEMEVAL("AccentColor"),60))'), FillBkgnd: v('#000000', 'THEMEGUARD(SHADE(FillForegnd,LUMDIFF(THEMEVAL("FillColor"),THEMEVAL("FillColor2"))))'),
      FillGradientEnabled: v(0), 'Char.Color': v('#000000', 'THEMEGUARD(RGB(0,0,0))'), 'Char.Style': v(17), 'Char.Size': v(NAME_SIZE) } }).xml()
  })

  const connects: string[] = []
  const linkXml = placed.routes.map(({ relationship: edge, points: raw }, index) => {
    const link: ConceptLink = edge.link
    const id = allocate()
    // Directed associations are laid out parent-first but drawn from the referencing entity to the referenced one.
    const points = (edge.child === link.from ? [...raw].reverse() : raw).map(shift)
    const [begin, end] = [points[0], points[points.length - 1]]
    const from = shapeIds.get(link.from)!, to = shapeIds.get(link.to)!
    const cells: Record<string, Override> = {
      BeginX: v(begin[0], '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)'), BeginY: v(begin[1], '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)'),
      EndX: v(end[0], '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)'), EndY: v(end[1], '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)'),
      BegTrigger: v(2, `_XFTRIGGER(Sheet.${from}!EventXFMod)`), EndTrigger: v(2, `_XFTRIGGER(Sheet.${to}!EventXFMod)`), LayerMember: v(0),
      'User.ShowMulti.Value': v(1),
    }
    const spec: InstanceSpec = { id, master: KIND_MASTER[link.kind], template: conceptualTemplate, nameU: `${link.kind === 'composition' ? 'Composition' : link.kind === 'directed' ? 'Directed Association' : 'Association'}.${index + 1}`,
      cells, deleted: [6, 8], sub: { 7: { text: link.fromMultiplicity }, 9: { text: link.toMultiplicity } } }
    if (link.label) spec.text = link.label
    const draft = resolveInstance(spec, () => 0)
    const originX = draft.value('PinX') - draft.value('LocPinX'), originY = draft.value('PinY') - draft.value('LocPinY')
    const snap = (value: number) => (Math.abs(value) < 1e-9 ? 0 : value)
    const local = points.map(([x, y]): Point => [snap(x - originX), snap(y - originY)])
    local.slice(0, 3).forEach(([x, y], row) => { cells[`Geometry1.X${row + 1}`] = v(x); cells[`Geometry1.Y${row + 1}`] = v(y) })
    if (local.length === 2) { cells['Geometry1.X3'] = v(local[1][0]); cells['Geometry1.Y3'] = v(local[1][1]) }
    const extra = local.slice(3).map(([x, y], row) => `<Row T='LineTo' IX='${row + 4}'><Cell N='X' V='${number(x)}'/><Cell N='Y' V='${number(y)}'/></Row>`).join('')
    if (extra) spec.rows = { 'Geometry|0': extra }
    const length = local.slice(1).reduce((total, point, position) => total + Math.hypot(point[0] - local[position][0], point[1] - local[position][1]), 0)
    const [first, last] = [along(local, Math.min(END_OFFSET, length / 3)), along(local, Math.min(END_OFFSET, length / 3), true)]
    Object.assign(cells, { 'Connections.X1': v(first[0]), 'Connections.Y1': v(first[1]), 'Connections.X2': v(last[0]), 'Connections.Y2': v(last[1]) })
    // The label sits beside the middle of the longest segment, clear of the multiplicities at the ends.
    const segments = local.slice(1).map((point, position) => [local[position], point] as const)
    const [a, b] = segments.reduce((best, segment) => (Math.hypot(segment[1][0] - segment[0][0], segment[1][1] - segment[0][1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1]) ? segment : best))
    const vertical = Math.abs(a[0] - b[0]) < 1e-9
    const label: Point = [(a[0] + b[0]) / 2 + (vertical ? 0.28 : 0), (a[1] + b[1]) / 2 + (vertical ? 0 : 0.14)]
    Object.assign(cells, { 'Controls.TextPosition.X': v(label[0]), 'Controls.TextPosition.Y': v(label[1]) })
    connects.push(`<Connect FromSheet='${id}' FromCell='BeginX' FromPart='9' ToSheet='${from}' ToCell='PinX' ToPart='3'/>`,
      `<Connect FromSheet='${id}' FromCell='EndX' FromPart='12' ToSheet='${to}' ToCell='PinX' ToPart='3'/>`)
    return resolve(spec).xml()
  })

  const pageXml = xmlDeclaration(`<PageContents xmlns='${NS}' xmlns:r='${OFFICE_REL}' xml:space='preserve'><Shapes>${boundaryXml}${linkXml.join('')}${entityXml.join('')}</Shapes>`
    + `${connects.length ? `<Connects>${connects.join('')}</Connects>` : ''}</PageContents>`)
  const masters = conceptualTemplate.masters
  const themes = conceptualManifest.themes
  const zip = new JSZip()
  zip.file('[Content_Types].xml', xmlDeclaration(`<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>`
    + `<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/>`
    + `<Override PartName='/visio/document.xml' ContentType='application/vnd.ms-visio.drawing.main+xml'/>`
    + `<Override PartName='/visio/masters/masters.xml' ContentType='application/vnd.ms-visio.masters+xml'/>`
    + masters.map((master) => `<Override PartName='/visio/masters/${master.file}' ContentType='application/vnd.ms-visio.master+xml'/>`).join('')
    + `<Override PartName='/visio/pages/pages.xml' ContentType='application/vnd.ms-visio.pages+xml'/>`
    + `<Override PartName='/visio/pages/page1.xml' ContentType='application/vnd.ms-visio.page+xml'/>`
    + `<Override PartName='/visio/windows.xml' ContentType='application/vnd.ms-visio.windows+xml'/>`
    + themes.map((theme) => `<Override PartName='/visio/theme/${theme.file}' ContentType='application/vnd.openxmlformats-officedocument.theme+xml'/>`).join('') + `</Types>`))
  zip.file('_rels/.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'document', target: 'visio/document.xml' }]))
  zip.file('visio/document.xml', conceptualTemplate.documentXml)
  zip.file('visio/_rels/document.xml.rels', relationships([
    { id: 'rId1', type: VISIO_REL + 'masters', target: 'masters/masters.xml' },
    { id: 'rId2', type: VISIO_REL + 'pages', target: 'pages/pages.xml' },
    { id: 'rId3', type: VISIO_REL + 'windows', target: 'windows.xml' },
    ...themes.map((theme) => ({ id: theme.rel, type: OFFICE_REL + '/theme', target: `theme/${theme.file}` })),
  ]))
  for (const theme of themes) zip.file(`visio/theme/${theme.file}`, THEMES[theme.file])
  zip.file('visio/masters/masters.xml', conceptualTemplate.mastersXml)
  zip.file('visio/masters/_rels/masters.xml.rels', relationships(masters.map((master) => ({ id: master.rel, type: VISIO_REL + 'master', target: master.file }))))
  for (const master of masters) zip.file(`visio/masters/${master.file}`, master.xml)
  zip.file('visio/windows.xml', xmlDeclaration(`<Windows xmlns='${NS}' xmlns:r='${OFFICE_REL}' ClientWidth='1200' ClientHeight='800'>`
    + `<Window ID='0' WindowType='Drawing' WindowState='1073741824' ContainerType='Page' Page='0' ViewScale='-1' ViewCenterX='${number(pageWidth / 2)}' ViewCenterY='${number(pageHeight / 2)}'>`
    + `<ShowRulers>1</ShowRulers><ShowGrid>0</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>0</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings></Window></Windows>`))
  const pageName = escapeXml(title || 'Conceptual Diagram')
  const pageCells = Object.entries(pageTemplate.cells as Record<string, { V: string; U?: string; F?: string }>)
    .map(([name, cell]) => `<Cell N='${name}' V='${cell.V}'${cell.U ? ` U='${cell.U}'` : ''}${cell.F ? ` F='${cell.F}'` : ''}/>`).join('')
  zip.file('visio/pages/pages.xml', xmlDeclaration(`<Pages xmlns='${NS}' xmlns:r='${OFFICE_REL}'><Page ID='0' NameU='${pageName}' Name='${pageName}'><PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>`
    + `<Cell N='PageWidth' V='${number(pageWidth)}'/><Cell N='PageHeight' V='${number(pageHeight)}'/>${pageCells}${pageTemplate.sections.join('')}</PageSheet><Rel r:id='rId1'/></Page></Pages>`))
  zip.file('visio/pages/_rels/pages.xml.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'page', target: 'page1.xml' }]))
  zip.file('visio/pages/_rels/page1.xml.rels', relationships(masters.filter((master) => used.has(master.id))
    .map((master, position) => ({ id: `rId${position + 1}`, type: VISIO_REL + 'master', target: `../masters/${master.file}` }))))
  zip.file('visio/pages/page1.xml', pageXml)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export { MULTIPLICITIES }
