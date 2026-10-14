import JSZip from 'jszip'
import type { Cardinality, ErColumn, ErEntity, ErModel, ErRelationship } from './er'
import { ER_LIMITS } from './er'
import { calibriWidth } from './calibri'
import { ERD_MASTER, erdTemplate, escapeXml, resolveInstance, type InstanceSpec, type Override, type ResolvedInstance } from './native'
import pageTemplate from './native-erd/page.json'
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
// Layout in inches.
const MARGIN = 1, CROSS_GAP = 1.25, MAIN_GAP = 1, CHANNEL = 0.2, CLEARANCE = 0.3, SELF_LOOP = 0.45

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

// Layout works in (u, w): u runs across a layer, w runs from parent layers to child layers.
// TB maps u to x and w downwards; LR maps w to x and u downwards.
interface Node { measured: Measured; cross: number; main: number; layer: number; order: number; u: number; w: number }
type Point = [number, number]
interface Route { relationship: ErRelationship; points: Point[] }

function layout(model: ErModel, measured: Measured[]) {
  const lr = model.direction === 'LR'
  const nodes = new Map<string, Node>(measured.map((entry) => [entry.entity.id, {
    measured: entry, cross: lr ? entry.height : entry.width, main: lr ? entry.width : entry.height, layer: 0, order: 0, u: 0, w: 0 }]))
  const index = new Map(model.entities.map((entity, position) => [entity.id, position]))
  const edges = model.relationships.filter((relationship) => relationship.parent !== relationship.child)
  const linked = model.entities.filter((entity) => edges.some((edge) => edge.parent === entity.id || edge.child === entity.id)).map((entity) => entity.id)

  // Break cycles for layering only (depth-first, in source order), then layer by longest path.
  const out = new Map<string, string[]>(linked.map((id) => [id, []]))
  const state = new Map<string, number>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const edge of edges.filter((candidate) => candidate.parent === id)) {
      if (state.get(edge.child) === 1) continue
      out.get(id)!.push(edge.child)
      if (!state.has(edge.child)) visit(edge.child)
    }
    state.set(id, 2)
  }
  for (const id of linked) if (!state.has(id)) visit(id)
  const parents = new Map<string, string[]>(linked.map((id) => [id, []]))
  for (const [id, children] of out) for (const child of children) parents.get(child)!.push(id)
  const ordered: string[] = []
  const pending = new Map(linked.map((id) => [id, parents.get(id)!.length]))
  const queue = linked.filter((id) => !pending.get(id))
  while (queue.length) {
    const id = queue.shift()!
    ordered.push(id)
    for (const child of out.get(id)!) { pending.set(child, pending.get(child)! - 1); if (!pending.get(child)) queue.push(child) }
  }
  for (const id of ordered) nodes.get(id)!.layer = Math.max(0, ...parents.get(id)!.map((parent) => nodes.get(parent)!.layer + 1))
  // Pull root tables down next to their children so their relationships stay short.
  for (const id of [...ordered].reverse()) {
    const children = out.get(id)!
    if (!parents.get(id)!.length && children.length) nodes.get(id)!.layer = Math.min(...children.map((child) => nodes.get(child)!.layer)) - 1
  }
  const layerCount = linked.length ? Math.max(...linked.map((id) => nodes.get(id)!.layer)) + 1 : 0
  const layers: string[][] = Array.from({ length: layerCount }, () => [])
  for (const id of linked) layers[nodes.get(id)!.layer].push(id)
  layers.forEach((layer) => layer.forEach((id, position) => { nodes.get(id)!.order = position }))

  // Barycentric ordering sweeps reduce crossings.
  const neighbours = (id: string, upward: boolean) => edges.flatMap((edge) => {
    const other = edge.parent === id ? edge.child : edge.child === id ? edge.parent : undefined
    if (!other) return []
    const node = nodes.get(other)!
    return (upward ? node.layer < nodes.get(id)!.layer : node.layer > nodes.get(id)!.layer) ? [node] : []
  })
  for (let pass = 0; pass < 8; pass++) {
    const upward = pass % 2 === 0
    const sequence = upward ? layers.slice(1) : layers.slice(0, -1).reverse()
    for (const layer of sequence) {
      const key = new Map(layer.map((id) => {
        const near = neighbours(id, upward)
        return [id, near.length ? near.reduce((total, node) => total + node.order, 0) / near.length : nodes.get(id)!.order]
      }))
      layer.sort((first, second) => key.get(first)! - key.get(second)! || index.get(first)! - index.get(second)!)
      layer.forEach((id, position) => { nodes.get(id)!.order = position })
    }
  }

  // Cross-axis placement: pack each layer, then pull tables towards their neighbours without changing the order.
  const selfLoops = new Set(model.relationships.filter((relationship) => relationship.parent === relationship.child).map((relationship) => relationship.parent))
  const gapAfter = (id: string) => CROSS_GAP + (selfLoops.has(id) ? SELF_LOOP + CLEARANCE : 0)
  // Closest placement to each table's desired centre that keeps the order and gaps (pool-adjacent-violators).
  const pack = (layer: string[], desired: Map<string, number>) => {
    const offsets: number[] = []
    let offset = 0
    for (const id of layer) { offsets.push(offset); offset += nodes.get(id)!.cross + gapAfter(id) }
    const blocks: { sum: number; count: number }[] = []
    layer.forEach((id, position) => {
      blocks.push({ sum: desired.get(id)! - nodes.get(id)!.cross / 2 - offsets[position], count: 1 })
      while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].count > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].count) {
        const last = blocks.pop()!
        blocks[blocks.length - 1].sum += last.sum
        blocks[blocks.length - 1].count += last.count
      }
    })
    let position = 0
    for (const block of blocks) for (let member = 0; member < block.count; member++, position++) nodes.get(layer[position])!.u = block.sum / block.count + offsets[position]
  }
  for (const layer of layers) {
    let cursor = 0
    for (const id of layer) { nodes.get(id)!.u = cursor; cursor += nodes.get(id)!.cross + gapAfter(id) }
  }
  const centre = (node: Node) => node.u + node.cross / 2
  for (let pass = 0; pass < 6; pass++) {
    const upward = pass % 2 === 0
    for (const layer of upward ? layers.slice(1) : layers.slice(0, -1).reverse()) {
      pack(layer, new Map(layer.map((id) => {
        const near = neighbours(id, upward)
        return [id, near.length ? near.reduce((total, node) => total + centre(node), 0) / near.length : centre(nodes.get(id)!)]
      })))
    }
  }

  // Endpoints ("ports") spread along the facing edges, ordered by the other end to avoid crossings at the box.
  type End = { relationship: ErRelationship; node: Node; other: Node; side: 'near' | 'far' }
  const ends = new Map<string, End[]>()
  const near = (from: Node, to: Node): 'near' | 'far' => (to.layer > from.layer ? 'far' : 'near')
  for (const relationship of edges) {
    const parent = nodes.get(relationship.parent)!, child = nodes.get(relationship.child)!
    for (const [node, other] of [[parent, child], [child, parent]] as const) {
      const side = near(node, other), key = `${node.measured.entity.id}|${side}`
      ends.set(key, [...(ends.get(key) ?? []), { relationship, node, other, side }])
    }
  }
  const port = new Map<string, number>()
  const portKey = (relationship: ErRelationship, id: string) => `${model.relationships.indexOf(relationship)}|${id}`
  for (const list of ends.values()) {
    list.sort((first, second) => centre(first.other) - centre(second.other) || model.relationships.indexOf(first.relationship) - model.relationships.indexOf(second.relationship))
    list.forEach((end, position) => port.set(portKey(end.relationship, end.node.measured.entity.id), end.node.u + end.node.cross * (position + 1) / (list.length + 1)))
  }
  const sideCount = (node: Node, other: Node) => ends.get(`${node.measured.entity.id}|${near(node, other)}`)!.length
  // Straight runs where adjacent tables overlap and one of the ends is free to move.
  for (const relationship of edges) {
    const parent = nodes.get(relationship.parent)!, child = nodes.get(relationship.child)!
    if (Math.abs(parent.layer - child.layer) !== 1) continue
    const low = Math.max(parent.u, child.u) + CLEARANCE, high = Math.min(parent.u + parent.cross, child.u + child.cross) - CLEARANCE
    if (low > high) continue
    const parentKey = portKey(relationship, relationship.parent), childKey = portKey(relationship, relationship.child)
    const parentFree = sideCount(parent, child) === 1, childFree = sideCount(child, parent) === 1
    const clamp = (value: number) => Math.min(high, Math.max(low, value))
    if (parentFree && childFree) { const u = clamp((centre(parent) + centre(child)) / 2); port.set(parentKey, u); port.set(childKey, u) }
    else if (childFree && port.get(parentKey)! >= low && port.get(parentKey)! <= high) port.set(childKey, port.get(parentKey)!)
    else if (parentFree && port.get(childKey)! >= low && port.get(childKey)! <= high) port.set(parentKey, port.get(childKey)!)
  }

  // Each gap between layers gets one horizontal channel per relationship that turns inside it.
  const straight = (relationship: ErRelationship) => Math.abs(nodes.get(relationship.parent)!.layer - nodes.get(relationship.child)!.layer) === 1
    && Math.abs(port.get(portKey(relationship, relationship.parent))! - port.get(portKey(relationship, relationship.child))!) < 1e-9
  const gapUsers: ErRelationship[][] = Array.from({ length: Math.max(0, layerCount - 1) }, () => [])
  for (const relationship of edges.filter((candidate) => !straight(candidate))) {
    const first = Math.min(nodes.get(relationship.parent)!.layer, nodes.get(relationship.child)!.layer)
    const last = Math.max(nodes.get(relationship.parent)!.layer, nodes.get(relationship.child)!.layer)
    gapUsers[first].push(relationship)
    if (last - 1 !== first) gapUsers[last - 1].push(relationship)
  }
  const layerTop: number[] = [], layerMain: number[] = [], gapSize: number[] = []
  let cursor = 0
  for (let layer = 0; layer < layerCount; layer++) {
    layerTop[layer] = cursor
    layerMain[layer] = Math.max(...layers[layer].map((id) => nodes.get(id)!.main))
    gapSize[layer] = Math.max(MAIN_GAP, CHANNEL * ((gapUsers[layer]?.length ?? 0) + 1) + 2 * CLEARANCE)
    cursor += layerMain[layer] + gapSize[layer]
    for (const id of layers[layer]) nodes.get(id)!.w = layerTop[layer]
  }
  const channel = new Map<string, number>()
  gapUsers.forEach((users, gap) => {
    const start = layerTop[gap] + layerMain[gap]
    const sorted = [...users].sort((first, second) => port.get(portKey(first, first.parent))! - port.get(portKey(second, second.parent))!)
    sorted.forEach((relationship, slot) => channel.set(`${model.relationships.indexOf(relationship)}|${gap}`, start + gapSize[gap] * (slot + 1) / (sorted.length + 1)))
  })

  // Relationships spanning several layers run down a corridor that is free in every layer they pass.
  const linkedNodes = linked.map((id) => nodes.get(id)!)
  const minU = Math.min(0, ...linkedNodes.map((node) => node.u)), maxU = Math.max(0, ...linkedNodes.map((node) => node.u + node.cross))
  const corridors: number[] = []
  const corridor = (from: number, to: number, target: number) => {
    let free: [number, number][] = [[minU - 3, maxU + 3]]
    for (let layer = from + 1; layer < to; layer++) {
      const blocked = layers[layer].map((id) => nodes.get(id)!).map((node): [number, number] => [node.u - CLEARANCE, node.u + node.cross + CLEARANCE])
      free = free.flatMap(([low, high]) => {
        let pieces: [number, number][] = [[low, high]]
        for (const [start, end] of blocked) pieces = pieces.flatMap(([a, b]): [number, number][] => (end <= a || start >= b ? [[a, b]] : [[a, start], [end, b]].filter(([x, y]) => y - x > 1e-9) as [number, number][]))
        return pieces
      })
    }
    const candidates = free.flatMap(([low, high]) => {
      const options: number[] = []
      for (let step = 0; step < 20; step++) for (const value of [target + step * CHANNEL, target - step * CHANNEL]) {
        if (value >= low && value <= high && corridors.every((used) => Math.abs(used - value) >= CHANNEL - 1e-9)) options.push(value)
      }
      for (const value of [(low + high) / 2, low + CHANNEL, high - CHANNEL]) if (value >= low && value <= high && corridors.every((used) => Math.abs(used - value) >= CHANNEL - 1e-9)) options.push(value)
      return options
    })
    const chosen = candidates.sort((first, second) => Math.abs(first - target) - Math.abs(second - target))[0] ?? maxU + 1 + corridors.length * CHANNEL
    corridors.push(chosen)
    return chosen
  }

  const routes: Route[] = []
  for (const relationship of model.relationships) {
    const relationshipIndex = model.relationships.indexOf(relationship)
    const parent = nodes.get(relationship.parent)!
    if (relationship.parent === relationship.child) {
      if (!linked.includes(relationship.parent)) continue
      const right = parent.u + parent.cross, top = parent.w + Math.min(0.5, parent.main / 4)
      routes.push({ relationship, points: [[right, top], [right + SELF_LOOP, top], [right + SELF_LOOP, top + Math.min(0.5, parent.main / 4)], [right, top + Math.min(0.5, parent.main / 4)]] })
      continue
    }
    const child = nodes.get(relationship.child)!
    const down = child.layer > parent.layer
    const edgeOf = (node: Node, outward: boolean) => (outward ? node.w + node.main : node.w)
    const start: Point = [port.get(portKey(relationship, relationship.parent))!, edgeOf(parent, down)]
    const end: Point = [port.get(portKey(relationship, relationship.child))!, edgeOf(child, !down)]
    const first = Math.min(parent.layer, child.layer), last = Math.max(parent.layer, child.layer)
    let points: Point[]
    if (straight(relationship)) points = [start, end]
    else if (last - first === 1) {
      const lane = channel.get(`${relationshipIndex}|${first}`)!
      points = [start, [start[0], lane], [end[0], lane], end]
    } else {
      const startLane = channel.get(`${relationshipIndex}|${down ? first : last - 1}`)!, endLane = channel.get(`${relationshipIndex}|${down ? last - 1 : first}`)!
      const lane = corridor(first, last, (start[0] + end[0]) / 2)
      points = [start, [start[0], startLane], [lane, startLane], [lane, endLane], [end[0], endLane], end]
    }
    routes.push({ relationship, points: simplify(points) })
  }

  // Tables without relationships (typically views) follow in rows below the connected diagram.
  const loose = model.entities.filter((entity) => !linked.includes(entity.id)).map((entity) => nodes.get(entity.id)!)
  const rowLimit = Math.max(maxU - minU, 4 * CROSS_GAP + loose.slice(0, 4).reduce((total, node) => total + node.cross, 0))
  let rowStart = layerCount ? cursor - gapSize[layerCount - 1] + MAIN_GAP * 1.5 : 0, rowCursor = minU, rowMain = 0
  for (const node of loose) {
    if (rowCursor > minU && rowCursor + node.cross > minU + rowLimit) { rowStart += rowMain + MAIN_GAP; rowCursor = minU; rowMain = 0 }
    node.u = rowCursor; node.w = rowStart
    rowCursor += node.cross + gapAfter(node.measured.entity.id)
    rowMain = Math.max(rowMain, node.main)
  }
  // Self-relationships of loose tables loop on their right-hand side as well.
  for (const relationship of model.relationships.filter((candidate) => candidate.parent === candidate.child && !linked.includes(candidate.parent))) {
    const node = nodes.get(relationship.parent)!, right = node.u + node.cross, top = node.w + Math.min(0.5, node.main / 4), drop = Math.min(0.5, node.main / 4)
    routes.push({ relationship, points: [[right, top], [right + SELF_LOOP, top], [right + SELF_LOOP, top + drop], [right, top + drop]] })
  }
  routes.sort((first, second) => model.relationships.indexOf(first.relationship) - model.relationships.indexOf(second.relationship))

  // Map (u, w) to page inches with the origin at the bottom-left corner.
  const all = [...nodes.values()]
  const uLow = Math.min(...all.map((node) => node.u), ...routes.flatMap((route) => route.points.map((point) => point[0])))
  const uHigh = Math.max(...all.map((node) => node.u + node.cross), ...routes.flatMap((route) => route.points.map((point) => point[0])))
  const wHigh = Math.max(...all.map((node) => node.w + node.main), ...routes.flatMap((route) => route.points.map((point) => point[1])))
  const pageWidth = 2 * MARGIN + (lr ? wHigh : uHigh - uLow), pageHeight = 2 * MARGIN + (lr ? uHigh - uLow : wHigh)
  const toPage = ([u, w]: Point): Point => (lr ? [MARGIN + w, pageHeight - MARGIN - (u - uLow)] : [MARGIN + u - uLow, pageHeight - MARGIN - w])
  const boxes = new Map(all.map((node) => {
    const [left, top] = toPage([node.u, node.w])
    return [node.measured.entity.id, { left, top, width: node.measured.width, height: node.measured.height }]
  }))
  return { pageWidth, pageHeight, boxes, routes: routes.map((route) => ({ relationship: route.relationship, points: route.points.map(toPage) })) }
}

function simplify(points: Point[]): Point[] {
  const distinct = points.filter((point, position) => position === 0 || Math.hypot(point[0] - points[position - 1][0], point[1] - points[position - 1][1]) > 1e-9)
  return distinct.filter((point, position) => {
    if (position === 0 || position === distinct.length - 1) return true
    const [a, b] = [distinct[position - 1], distinct[position + 1]]
    return Math.abs((point[0] - a[0]) * (b[1] - point[1]) - (point[1] - a[1]) * (b[0] - point[0])) > 1e-9
  })
}

// Point at a distance along a polyline, from its start or (reverse) from its end.
function along(points: Point[], distance: number, reverse = false): Point {
  const path = reverse ? [...points].reverse() : points
  let remaining = distance
  for (let index = 1; index < path.length; index++) {
    const [a, b] = [path[index - 1], path[index]], length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (remaining <= length) return [a[0] + (b[0] - a[0]) * remaining / length, a[1] + (b[1] - a[1]) * remaining / length]
    remaining -= length
  }
  return path[path.length - 1]
}

export async function generateErVsdx(model: ErModel, title = 'ER Diagram'): Promise<Uint8Array> {
  validateModel(model)
  plainText(title, 200)
  const measured = model.entities.map(measure)
  const { pageWidth, pageHeight, boxes, routes } = layout(model, measured)

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
