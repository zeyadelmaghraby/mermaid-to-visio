import JSZip from 'jszip'
import type { Cardinality, ErColumn, ErEntity, ErModel } from './er'
import { ER_LIMITS } from './er'
import { calibriWidth } from './calibri'
import { ERD_MASTER, erdTemplate, escapeXml, resolveInstance, type InstanceSpec, type Override, type ResolvedInstance } from './native'
import pageTemplate from './native-erd/page.json'
import { along, layout, type Point } from './layout'
import { NS, OFFICE_REL, VISIO_REL, number, relationships, xmlDeclaration } from './vsdx'

// Text metrics of the Entity/View masters: 10 pt Calibri, 120 % line spacing, 1/18 in margins on each side.
const SIZE = 0.13888888888889
const LINE = SIZE * 1.2
const MARGINS = 1 / 9
// Tab stops as the database add-on lays them out: each column is measured in bold Calibri, then padded
// (constants measured against the reference ERD's cached Position0/Position1/User.Width values).
const KEY_GAP = 0.1557, NAME_GAP = 0.1368, TYPE_GAP = 0.1177
// Axis-aligned relationships keep a fixed thickness instead of a zero Width/Height, as in the reference.
const THICKNESS = 0.19685039370079
const LAYER = { relationships: '0', entities: '1' }
// Native crow's-foot line ends of the Relationship master (User.DBCardinality is the End arrow index).
const CROWS_FOOT: Record<Cardinality, number> = { one: 25, zeroOrOne: 30, oneOrMore: 28, zeroOrMore: 29 }

const v = (value: number | string, formula?: string): Override => ({ V: value, ...(formula ? { F: formula } : {}) })
const bold = (text: string) => calibriWidth(text, SIZE, true)
// Full Character row as Visio writes appended runs (font from the theme, 10 pt, plain decorations).
const characterRow = (ix: number, style: number) => `<Row IX='${ix}'><Cell N='Font' V='Themed' F='THEMEVAL()'/><Cell N='Color' V='0'/><Cell N='Style' V='${style}'/>`
  + `<Cell N='Case' V='0'/><Cell N='Pos' V='0'/><Cell N='FontScale' V='1'/><Cell N='Size' V='${SIZE}'/><Cell N='DblUnderline' V='0'/><Cell N='Overline' V='0'/>`
  + `<Cell N='Strikethru' V='0'/><Cell N='DoubleStrikethrough' V='0'/><Cell N='Letterspace' V='0'/><Cell N='ColorTrans' V='0'/><Cell N='AsianFont' V='Themed' F='THEMEVAL()'/>`
  + `<Cell N='ComplexScriptFont' V='Themed' F='THEMEVAL()'/><Cell N='ComplexScriptSize' V='-1'/><Cell N='LangID' V='en-US'/></Row>`
// Character runs: 0 bold (master row), 1 bold + underline (primary key names), 2 regular (nullable columns).
const RUN = { bold: 0, key: 1, regular: 2 }
const RUN_ROWS = characterRow(1, 5) + characterRow(2, 0)

function indicator(column: ErColumn): string {
  return [column.pk ? 'PK' : '', column.fk ? `FK${column.fk}` : '', column.unique ? `U${column.unique}` : ''].filter(Boolean).join(',')
}

function plainText(value: string, max: number) {
  if (typeof value !== 'string' || value.length > max || Array.from(value).some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
  })) throw new Error('Invalid ER model text.')
}

function validateModel(model: ErModel) {
  if (!model || model.kind !== 'er' || !['TB', 'LR'].includes(model.direction) || !Array.isArray(model.entities) || !Array.isArray(model.relationships)
    || !model.entities.length || model.entities.length > ER_LIMITS.entities || model.relationships.length > ER_LIMITS.relationships) throw new Error('Invalid or oversized ER model.')
  const ids = new Set(model.entities.map((entity) => entity.id))
  if (ids.size !== model.entities.length) throw new Error('Duplicate entity IDs.')
  for (const entity of model.entities) {
    plainText(entity.id, ER_LIMITS.name); plainText(entity.name, ER_LIMITS.name)
    if (!entity.name || !Array.isArray(entity.columns) || entity.columns.length > ER_LIMITS.columns) throw new Error('Invalid entity.')
    for (const column of entity.columns) {
      plainText(column.name, ER_LIMITS.name); plainText(column.type, ER_LIMITS.name)
      for (const key of [column.fk, column.unique]) if (key !== undefined && (!Number.isInteger(key) || key < 1 || key > 99)) throw new Error('Invalid key number.')
      if (entity.view && (column.pk || column.fk || column.unique)) throw new Error('Views have no key column.')
    }
  }
  for (const relationship of model.relationships) {
    if (!ids.has(relationship.parent) || !ids.has(relationship.child) || !(relationship.childCardinality in CROWS_FOOT)) throw new Error('Invalid relationship.')
    plainText(relationship.label, 200)
  }
}

interface Measured { entity: ErEntity; width: number; height: number; spec: (id: number) => InstanceSpec }

function measure(entity: ErEntity): Measured {
  const header = calibriWidth(entity.name, SIZE) + MARGINS
  const headerHeight = LINE + MARGINS
  const widest = (values: string[]) => Math.max(0, ...values.map(bold))
  const lines: { key: string; name: string; type: string; run: number; pk: boolean }[] = entity.columns.map((column) => ({
    key: indicator(column) || ' ', name: column.name, type: column.type, pk: column.pk, run: column.notNull ? RUN.bold : RUN.regular }))
  let tabs: number[], body: number, lineCount: number, text: string, textXml: string
  const run = (ix: number) => `<cp IX='${ix}'/>`
  if (entity.view) {
    tabs = [widest(lines.map((line) => line.name)) + NAME_GAP]
    body = lines.length ? tabs[0] + widest(lines.map((line) => line.type)) + TYPE_GAP : MARGINS
    lineCount = lines.length
    text = lines.map((line) => `${line.name}\t${line.type}`).join('\n')
    textXml = `${run(RUN.bold)}<tp IX='0'/>` + lines.map((line) => `${run(line.run)}${escapeXml(line.name)}\t${escapeXml(line.type)}\n`).join('')
  } else {
    const keys = lines.filter((line) => line.pk), others = lines.filter((line) => !line.pk)
    tabs = [widest(lines.length ? lines.map((line) => line.key) : [' ']) + KEY_GAP]
    tabs.push(tabs[0] + widest(lines.map((line) => line.name)) + NAME_GAP)
    body = tabs[1] + widest(lines.map((line) => line.type)) + TYPE_GAP
    // Primary-key compartment (one empty line when there is no key), the separator line, then the other columns.
    lineCount = Math.max(1, keys.length) + 1 + others.length
    const plain = [...(keys.length ? keys.map((line) => `${line.key}\t${line.name}\t${line.type}`) : ['']), '', ...others.map((line) => `${line.key}\t${line.name}\t${line.type}`)]
    text = plain.join('\n')
    textXml = `${run(RUN.bold)}<tp IX='0'/>`
      + (keys.length ? keys.map((line) => `${run(RUN.bold)}${escapeXml(line.key)}\t${run(RUN.key)}${escapeXml(line.name)}${run(RUN.bold)}\t${escapeXml(line.type)}\n`).join('') : '\n')
      + '\n' + others.map((line) => `${run(line.run)}${escapeXml(line.key)}\t${escapeXml(line.name)}\t${escapeXml(line.type)}\n`).join('')
  }
  const bodyHeight = Math.max(1, lineCount) * LINE + MARGINS
  const width = Math.max(0.5, header, body), height = headerHeight + bodyHeight
  const bodyCells: Record<string, Override> = {
    'User.Width.Value': v(body, 'Inh'), 'User.Height.Value': v(bodyHeight, 'Inh'), Height: v(bodyHeight, 'Inh'), 'User.LineCount.Value': v(lineCount),
    'User.PKCount.Value': v(entity.view ? -1 : entity.columns.filter((column) => column.pk).length, 'Inh'),
    'User.DBHidePKSeperatorLine.Value': v(entity.view ? 1 : 0), 'User.DBHideTabLine1.Value': v(0), 'User.DBHideTabLine2.Value': v(entity.view ? 1 : 0),
    'Tabs.0.Position0': v(tabs[0]), 'Geometry2.X1': v(tabs[0], 'Inh'), 'Geometry2.X2': v(tabs[0], 'Inh'),
    'Char.Color': v(0), 'Char.Style': v(1), LayerMember: v(LAYER.entities),
  }
  if (!entity.view) Object.assign(bodyCells, { 'Tabs.0.Position1': v(tabs[1]), 'Geometry3.X1': v(tabs[1], 'Inh'), 'Geometry3.X2': v(tabs[1], 'Inh') })
  return { entity, width, height, spec: (id) => ({ id, master: entity.view ? ERD_MASTER.View : ERD_MASTER.Entity, template: erdTemplate,
    cells: { LayerMember: v(LAYER.entities) },
    sub: {
      6: { text: entity.name, textXml: `<cp IX='0'/>${escapeXml(entity.name)}\n`,
        cells: { 'User.Width.Value': v(header, 'Inh'), 'User.Height.Value': v(headerHeight, 'Inh'), Height: v(headerHeight, 'Inh'), 'Char.Color': v(0), LayerMember: v(LAYER.entities) } },
      7: { text, textXml, cells: bodyCells, rows: { 'Character|0': RUN_ROWS } },
    } }) }
}

export async function generateErVsdx(model: ErModel, title = 'ER Diagram'): Promise<Uint8Array> {
  validateModel(model)
  plainText(title, 200)
  const measured = model.entities.map(measure)
  const { pageWidth, pageHeight, boxes, routes } = layout(model.direction, measured.map((entry) => ({ id: entry.entity.id, width: entry.width, height: entry.height })), model.relationships)

  let nextId = 1
  const allocate = () => nextId++
  const shapeIds = new Map<string, number>()
  const entityXml = measured.map((entry, position) => {
    const id = allocate()
    shapeIds.set(entry.entity.id, id)
    const box = boxes.get(entry.entity.id)!
    const spec = entry.spec(id)
    spec.nameU = `${entry.entity.view ? 'View' : 'Entity'}.${position + 1}`
    spec.cells = { ...spec.cells, PinX: v(box.left + entry.width / 2), PinY: v(box.top - entry.height / 2) }
    const instance = resolveInstance(spec, allocate)
    for (const [key, expected] of [['Width', entry.width], ['Height', entry.height]] as const) {
      if (Math.abs(instance.value(key) - expected) > 1e-9) throw new Error(`Native ${spec.nameU} ${key} does not match its measured layout.`)
    }
    return instance.xml()
  })

  const connects: string[] = []
  const relationshipXml = routes.map(({ relationship, points }, position) => {
    const id = allocate()
    const parent = shapeIds.get(relationship.parent)!, child = shapeIds.get(relationship.child)!
    const [begin, end] = [points[0], points[points.length - 1]]
    const cells: Record<string, Override> = {
      BeginX: v(begin[0], '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)'), BeginY: v(begin[1], '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)'),
      EndX: v(end[0], '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)'), EndY: v(end[1], '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)'),
      BegTrigger: v(2, `_XFTRIGGER(Sheet.${parent}!EventXFMod)`), EndTrigger: v(2, `_XFTRIGGER(Sheet.${child}!EventXFMod)`),
      LayerMember: v(LAYER.relationships),
      'User.DBNotation.Value': v(2), 'User.CrowsFoot.Value': v(1), 'User.Identifying.Value': v(relationship.identifying ? 1 : 0),
      'User.Optional.Value': v(relationship.parentOptional ? 1 : 0), 'User.DBCardinality.Value': v(CROWS_FOOT[relationship.childCardinality]),
    }
    if (Math.abs(end[0] - begin[0]) < 1e-9) cells.Width = v(THICKNESS, `GUARD(${THICKNESS}DL)`)
    if (Math.abs(end[1] - begin[1]) < 1e-9) cells.Height = v(THICKNESS, `GUARD(${THICKNESS}DL)`)
    // Mermaid labels stay on the relationship as hidden text, matching the template's unlabelled lines.
    const spec: InstanceSpec = { id, master: ERD_MASTER.Relationship, template: erdTemplate, nameU: `Relationship.${position + 1}`, cells }
    if (relationship.label) { spec.text = relationship.label; cells.HideText = v(1) }
    const draft = resolveInstance(spec, () => { throw new Error('The Relationship master has no sub-shapes.') })
    const originX = draft.value('PinX') - draft.value('LocPinX'), originY = draft.value('PinY') - draft.value('LocPinY')
    const local = points.map(([x, y]): Point => [x - originX, y - originY])
    local.slice(0, 2).forEach(([x, y], row) => { cells[`Geometry1.X${row + 1}`] = v(x); cells[`Geometry1.Y${row + 1}`] = v(y) })
    const extraRows = local.slice(2).map(([x, y], row) => `<Row T='LineTo' IX='${row + 3}'><Cell N='X' V='${number(x)}'/><Cell N='Y' V='${number(y)}'/></Row>`).join('')
    if (extraRows) spec.rows = { 'Geometry|0': extraRows }
    // Connection points (and the role-text controls derived from them) sit on the drawn path, as Visio places them.
    const length = local.slice(1).reduce((total, point, index) => total + Math.hypot(point[0] - local[index][0], point[1] - local[index][1]), 0)
    const reach = Math.min(0.3, length / 4)
    for (const [row, point] of [along(local, reach), along(local, length / 2), along(local, reach, true)].entries()) {
      cells[`Connections.X${row + 1}`] = v(point[0]); cells[`Connections.Y${row + 1}`] = v(point[1])
    }
    const instance: ResolvedInstance = resolveInstance(spec, () => { throw new Error('The Relationship master has no sub-shapes.') })
    for (const [key, expected] of [['BeginX', begin[0]], ['BeginY', begin[1]], ['EndX', end[0]], ['EndY', end[1]]] as const) {
      if (Math.abs(instance.value(key) - expected) > 1e-9) throw new Error(`Native ${spec.nameU} ${key} does not match its route.`)
    }
    connects.push(`<Connect FromSheet='${id}' FromCell='BeginX' FromPart='9' ToSheet='${parent}' ToCell='PinX' ToPart='3'/>`,
      `<Connect FromSheet='${id}' FromCell='EndX' FromPart='12' ToSheet='${child}' ToCell='PinX' ToPart='3'/>`)
    return instance.xml()
  })

  // Relationships paint behind the tables they join, as in the reference.
  const shapesXml = [...relationshipXml, ...entityXml].join('')
  const pageXml = xmlDeclaration(`<PageContents xmlns='${NS}' xmlns:r='${OFFICE_REL}' xml:space='preserve'><Shapes>${shapesXml}</Shapes>${connects.length ? `<Connects>${connects.join('')}</Connects>` : ''}</PageContents>`)
  const used = new Set<number>([...model.entities.map((entity) => entity.view ? ERD_MASTER.View : ERD_MASTER.Entity), ...(routes.length ? [ERD_MASTER.Relationship] : [])])
  const masters = erdTemplate.masters

  const zip = new JSZip()
  zip.file('[Content_Types].xml', xmlDeclaration(`<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>`
    + `<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/>`
    + `<Override PartName='/visio/document.xml' ContentType='application/vnd.ms-visio.drawing.main+xml'/>`
    + `<Override PartName='/visio/masters/masters.xml' ContentType='application/vnd.ms-visio.masters+xml'/>`
    + masters.map((master) => `<Override PartName='/visio/masters/${master.file}' ContentType='application/vnd.ms-visio.master+xml'/>`).join('')
    + `<Override PartName='/visio/pages/pages.xml' ContentType='application/vnd.ms-visio.pages+xml'/>`
    + `<Override PartName='/visio/pages/page1.xml' ContentType='application/vnd.ms-visio.page+xml'/>`
    + `<Override PartName='/visio/windows.xml' ContentType='application/vnd.ms-visio.windows+xml'/></Types>`))
  zip.file('_rels/.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'document', target: 'visio/document.xml' }]))
  zip.file('visio/document.xml', erdTemplate.documentXml)
  zip.file('visio/_rels/document.xml.rels', relationships([
    { id: 'rId1', type: VISIO_REL + 'masters', target: 'masters/masters.xml' },
    { id: 'rId2', type: VISIO_REL + 'pages', target: 'pages/pages.xml' },
    { id: 'rId3', type: VISIO_REL + 'windows', target: 'windows.xml' },
  ]))
  zip.file('visio/masters/masters.xml', erdTemplate.mastersXml)
  zip.file('visio/masters/_rels/masters.xml.rels', relationships(masters.map((master) => ({ id: master.rel, type: VISIO_REL + 'master', target: master.file }))))
  for (const master of masters) zip.file(`visio/masters/${master.file}`, master.xml)
  zip.file('visio/windows.xml', xmlDeclaration(`<Windows xmlns='${NS}' xmlns:r='${OFFICE_REL}' ClientWidth='1200' ClientHeight='800'>`
    + `<Window ID='0' WindowType='Drawing' WindowState='1073741824' ContainerType='Page' Page='0' ViewScale='-1' ViewCenterX='${number(pageWidth / 2)}' ViewCenterY='${number(pageHeight / 2)}'>`
    + `<ShowRulers>1</ShowRulers><ShowGrid>0</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>0</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>39</SnapSettings></Window></Windows>`))
  const pageName = escapeXml(title || 'ER Diagram')
  const origins = new Set(['XRulerOrigin', 'YRulerOrigin', 'XGridOrigin', 'YGridOrigin'])
  const pageCells = Object.entries(pageTemplate.cells as Record<string, { V: string; U?: string }>)
    .map(([name, cell]) => `<Cell N='${name}' V='${origins.has(name) ? '0' : cell.V}'${cell.U ? ` U='${cell.U}'` : ''}/>`).join('')
  zip.file('visio/pages/pages.xml', xmlDeclaration(`<Pages xmlns='${NS}' xmlns:r='${OFFICE_REL}'><Page ID='0' NameU='${pageName}' Name='${pageName}'><PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>`
    + `<Cell N='PageWidth' V='${number(pageWidth)}' U='MM'/><Cell N='PageHeight' V='${number(pageHeight)}' U='MM'/>${pageCells}`
    + `${pageTemplate.user}${pageTemplate.layers}</PageSheet><Rel r:id='rId1'/></Page></Pages>`))
  zip.file('visio/pages/_rels/pages.xml.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'page', target: 'page1.xml' }]))
  zip.file('visio/pages/_rels/page1.xml.rels', relationships(masters.filter((master) => used.has(master.id))
    .map((master, position) => ({ id: `rId${position + 1}`, type: VISIO_REL + 'master', target: `../masters/${master.file}` }))))
  zip.file('visio/pages/page1.xml', pageXml)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
