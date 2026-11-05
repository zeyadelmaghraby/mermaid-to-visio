// Layered layout shared by the native ER and conceptual exports: tables in layers by relationship (parents first),
// ordered to reduce crossings, centred over their neighbours, with orthogonal relationship routes.
export interface LayoutNode { id: string; width: number; height: number }
export interface LayoutEdge { parent: string; child: string }
// Layout in inches.
const MARGIN = 1, CROSS_GAP = 1.25, MAIN_GAP = 1, CHANNEL = 0.2, CLEARANCE = 0.3, SELF_LOOP = 0.45

// Layout works in (u, w): u runs across a layer, w runs from parent layers to child layers.
// TB maps u to x and w downwards; LR maps w to x and u downwards.
interface Node { item: LayoutNode; cross: number; main: number; layer: number; order: number; u: number; w: number }
export type Point = [number, number]
interface Route<Edge> { relationship: Edge; points: Point[] }

// layering selects the edges that decide the layers (all by default); the others are only routed, possibly between
// entities of the same layer.
export function layout<Edge extends LayoutEdge>(direction: 'TB' | 'LR', items: LayoutNode[], relationships: Edge[], layering?: (edge: Edge) => boolean) {
  const lr = direction === 'LR'
  const nodes = new Map<string, Node>(items.map((entry) => [entry.id, {
    item: entry, cross: lr ? entry.height : entry.width, main: lr ? entry.width : entry.height, layer: 0, order: 0, u: 0, w: 0 }]))
  const index = new Map(items.map((entity, position) => [entity.id, position]))
  const edges = relationships.filter((relationship) => relationship.parent !== relationship.child)
  const linked = items.filter((entity) => edges.some((edge) => edge.parent === entity.id || edge.child === entity.id)).map((entity) => entity.id)
  const layered = layering ? edges.filter(layering) : edges

  // Break cycles for layering only (depth-first, in source order), then layer by longest path.
  const out = new Map<string, string[]>(linked.map((id) => [id, []]))
  const state = new Map<string, number>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const edge of layered.filter((candidate) => candidate.parent === id)) {
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
  const selfLoops = new Set(relationships.filter((relationship) => relationship.parent === relationship.child).map((relationship) => relationship.parent))
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
  type End = { relationship: Edge; node: Node; other: Node; side: 'near' | 'far' }
  const ends = new Map<string, End[]>()
  // Same-layer links leave through the side facing the gap they run in: above, or below for the first layer.
  const near = (from: Node, to: Node): 'near' | 'far' => (to.layer > from.layer || (to.layer === from.layer && from.layer === 0) ? 'far' : 'near')
  const sameLayerGap = (layer: number) => (layer > 0 ? layer - 1 : 0)
  for (const relationship of edges) {
    const parent = nodes.get(relationship.parent)!, child = nodes.get(relationship.child)!
    for (const [node, other] of [[parent, child], [child, parent]] as const) {
      const side = near(node, other), key = `${node.item.id}|${side}`
      ends.set(key, [...(ends.get(key) ?? []), { relationship, node, other, side }])
    }
  }
  const port = new Map<string, number>()
  const portKey = (relationship: Edge, id: string) => `${relationships.indexOf(relationship)}|${id}`
  for (const list of ends.values()) {
    list.sort((first, second) => centre(first.other) - centre(second.other) || relationships.indexOf(first.relationship) - relationships.indexOf(second.relationship))
    list.forEach((end, position) => port.set(portKey(end.relationship, end.node.item.id), end.node.u + end.node.cross * (position + 1) / (list.length + 1)))
  }
  const sideCount = (node: Node, other: Node) => ends.get(`${node.item.id}|${near(node, other)}`)!.length
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
  const straight = (relationship: Edge) => Math.abs(nodes.get(relationship.parent)!.layer - nodes.get(relationship.child)!.layer) === 1
    && Math.abs(port.get(portKey(relationship, relationship.parent))! - port.get(portKey(relationship, relationship.child))!) < 1e-9
  const gapUsers: Edge[][] = Array.from({ length: Math.max(1, layerCount) }, () => [])
  for (const relationship of edges.filter((candidate) => !straight(candidate))) {
    const first = Math.min(nodes.get(relationship.parent)!.layer, nodes.get(relationship.child)!.layer)
    if (nodes.get(relationship.parent)!.layer === nodes.get(relationship.child)!.layer) { gapUsers[sameLayerGap(first)].push(relationship); continue }
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
    sorted.forEach((relationship, slot) => channel.set(`${relationships.indexOf(relationship)}|${gap}`, start + gapSize[gap] * (slot + 1) / (sorted.length + 1)))
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

  const routes: Route<Edge>[] = []
  for (const relationship of relationships) {
    const relationshipIndex = relationships.indexOf(relationship)
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
    const first = Math.min(parent.layer, child.layer), last = Math.max(parent.layer, child.layer)
    let points: Point[]
    if (first === last) {
      const below = first === 0, lane = channel.get(`${relationshipIndex}|${sameLayerGap(first)}`)!
      const start: Point = [port.get(portKey(relationship, relationship.parent))!, edgeOf(parent, below)]
      const end: Point = [port.get(portKey(relationship, relationship.child))!, edgeOf(child, below)]
      routes.push({ relationship, points: simplify([start, [start[0], lane], [end[0], lane], end]) })
      continue
    }
    const start: Point = [port.get(portKey(relationship, relationship.parent))!, edgeOf(parent, down)]
    const end: Point = [port.get(portKey(relationship, relationship.child))!, edgeOf(child, !down)]
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
  const loose = items.filter((entity) => !linked.includes(entity.id)).map((entity) => nodes.get(entity.id)!)
  const rowLimit = Math.max(maxU - minU, 4 * CROSS_GAP + loose.slice(0, 4).reduce((total, node) => total + node.cross, 0))
  let rowStart = layerCount ? cursor - gapSize[layerCount - 1] + MAIN_GAP * 1.5 : 0, rowCursor = minU, rowMain = 0
  for (const node of loose) {
    if (rowCursor > minU && rowCursor + node.cross > minU + rowLimit) { rowStart += rowMain + MAIN_GAP; rowCursor = minU; rowMain = 0 }
    node.u = rowCursor; node.w = rowStart
    rowCursor += node.cross + gapAfter(node.item.id)
    rowMain = Math.max(rowMain, node.main)
  }
  // Self-relationships of loose tables loop on their right-hand side as well.
  for (const relationship of relationships.filter((candidate) => candidate.parent === candidate.child && !linked.includes(candidate.parent))) {
    const node = nodes.get(relationship.parent)!, right = node.u + node.cross, top = node.w + Math.min(0.5, node.main / 4), drop = Math.min(0.5, node.main / 4)
    routes.push({ relationship, points: [[right, top], [right + SELF_LOOP, top], [right + SELF_LOOP, top + drop], [right, top + drop]] })
  }
  routes.sort((first, second) => relationships.indexOf(first.relationship) - relationships.indexOf(second.relationship))

  // Map (u, w) to page inches with the origin at the bottom-left corner.
  const all = [...nodes.values()]
  const uLow = Math.min(...all.map((node) => node.u), ...routes.flatMap((route) => route.points.map((point) => point[0])))
  const uHigh = Math.max(...all.map((node) => node.u + node.cross), ...routes.flatMap((route) => route.points.map((point) => point[0])))
  const wHigh = Math.max(...all.map((node) => node.w + node.main), ...routes.flatMap((route) => route.points.map((point) => point[1])))
  const pageWidth = 2 * MARGIN + (lr ? wHigh : uHigh - uLow), pageHeight = 2 * MARGIN + (lr ? uHigh - uLow : wHigh)
  const toPage = ([u, w]: Point): Point => (lr ? [MARGIN + w, pageHeight - MARGIN - (u - uLow)] : [MARGIN + u - uLow, pageHeight - MARGIN - w])
  const boxes = new Map(all.map((node) => {
    const [left, top] = toPage([node.u, node.w])
    return [node.item.id, { left, top, width: node.item.width, height: node.item.height }]
  }))
  return { pageWidth, pageHeight, boxes, routes: routes.map((route) => ({ relationship: route.relationship, points: route.points.map(toPage) })) }
}

export function simplify(points: Point[]): Point[] {
  const distinct = points.filter((point, position) => position === 0 || Math.hypot(point[0] - points[position - 1][0], point[1] - points[position - 1][1]) > 1e-9)
  return distinct.filter((point, position) => {
    if (position === 0 || position === distinct.length - 1) return true
    const [a, b] = [distinct[position - 1], distinct[position + 1]]
    return Math.abs((point[0] - a[0]) * (b[1] - point[1]) - (point[1] - a[1]) * (b[0] - point[0])) > 1e-9
  })
}

// Point at a distance along a polyline, from its start or (reverse) from its end.
export function along(points: Point[], distance: number, reverse = false): Point {
  const path = reverse ? [...points].reverse() : points
  let remaining = distance
  for (let index = 1; index < path.length; index++) {
    const [a, b] = [path[index - 1], path[index]], length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (remaining <= length) return [a[0] + (b[0] - a[0]) * remaining / length, a[1] + (b[1] - a[1]) * remaining / length]
    remaining -= length
  }
  return path[path.length - 1]
}

