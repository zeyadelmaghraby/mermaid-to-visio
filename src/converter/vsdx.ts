import JSZip from 'jszip'
import type { SequenceModel } from './sequence'
import { connectorLayer, pageSettings, referenceTheme as theme, semanticColor } from './theme'
import nativeTheme from './reference-theme.xml?raw'
import { MASTER, escapeXml, masterCell, masterConnectionRows, measureText, nativeTemplate, resolveInstance, type InstanceSpec, type Override, type ResolvedInstance } from './native'

const NS = 'http://schemas.microsoft.com/office/visio/2012/main'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const VISIO_REL = 'http://schemas.microsoft.com/visio/2010/relationships/'
// Native UML Activation and lifeline masters expose connection points every quarter inch.
export const PITCH = 0.25
const MAX_LIFELINE_POINTS = 100
const HEADER_TOP_MARGIN = 0.975
const PAGE_MARGIN = 0.25

function validateModel(model: SequenceModel) {
  if (!model || !Array.isArray(model.participants) || !model.participants.length || model.participants.length > 30
    || !Number.isInteger(model.steps) || model.steps < 0 || model.steps > 1000
    || model.messages.length > 500 || model.frames.length > 500 || model.notes.length > 1000 || model.activations.length > 1000) throw new Error('Invalid or oversized sequence model.')
  const ids = new Set(model.participants.map((participant) => participant.id))
  if (ids.size !== model.participants.length) throw new Error('Duplicate participant IDs.')
  const text = (value: string) => {
    if (typeof value !== 'string' || value.length > 100_000 || Array.from(value).some((character) => {
      const code = character.codePointAt(0)!
      return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
    })) throw new Error('Invalid model text.')
  }
  const step = (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value >= model.steps) throw new Error('Invalid event position.')
  }
  model.participants.forEach((participant) => {
    text(participant.id); text(participant.label)
    if (participant.type && !['participant', 'actor'].includes(participant.type)) throw new Error('Invalid participant type.')
  })
  model.messages.forEach((message) => {
    if (!ids.has(message.from) || !ids.has(message.to) || !['filled', 'open', 'cross', 'none'].includes(message.arrow)) throw new Error('Invalid message reference or arrow.')
    step(message.step); text(message.text)
  })
  model.frames.forEach((frame) => {
    if (!['alt', 'opt', 'loop', 'par'].includes(frame.kind) || !Number.isInteger(frame.depth) || frame.depth < 0 || frame.depth > 7 || frame.end < frame.start) throw new Error('Invalid frame.')
    step(frame.start); step(frame.end); text(frame.text)
    frame.branches.forEach((branch) => { step(branch.step); text(branch.text); if (branch.step <= frame.start || branch.step >= frame.end) throw new Error('Branch outside frame.') })
  })
  model.notes.forEach((note) => {
    if (!note.participants.length || note.participants.some((id) => !ids.has(id)) || ![0, 1, 2].includes(note.placement)) throw new Error('Invalid note.')
    step(note.step); text(note.text)
  })
  model.activations.forEach((activation) => {
    if (!ids.has(activation.participant) || activation.end < activation.start || !Number.isInteger(activation.depth) || activation.depth < 0 || activation.depth > 30) throw new Error('Invalid activation.')
    step(activation.start); step(activation.end)
  })
}

function xmlDeclaration(body: string) {
  return `<?xml version='1.0' encoding='utf-8' ?>\n${body}`
}
function relationships(items: { id: string; type: string; target: string }[]) {
  return xmlDeclaration(`<Relationships xmlns='${REL}'>${items.map((item) => `<Relationship Id='${item.id}' Type='${item.type}' Target='${item.target}'/>`).join('')}</Relationships>`)
}
const number = (value: number) => String(Number(value.toPrecision(15)))
const v = (value: number | string, formula?: string): Override => ({ V: value, ...(formula ? { F: formula } : {}) })

type Message = SequenceModel['messages'][number]
type Frame = SequenceModel['frames'][number]
type Activation = SequenceModel['activations'][number]
interface Bar { activation: Activation; top: number; bottom: number; x: number; instance?: ResolvedInstance; parent?: Bar }

export async function generateVsdx(model: SequenceModel, title = 'Sequence Diagram'): Promise<Uint8Array> {
  validateModel(model)
  if (title.length > 200 || Array.from(title).some((character) => {
    const code = character.codePointAt(0)!
    return code < 32 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
  })) throw new Error('Use a title of at most 200 plain-text characters.')

  const pageWidth = pageSettings.PageWidth, pageHeight = pageSettings.PageHeight
  const messageSize = theme.messagePoints / 72, branchSize = theme.branchPoints / 72
  const participantCount = model.participants.length
  const naturalSpan = participantCount > 1 ? theme.firstParticipantGap + (participantCount - 2) * theme.participantGap : 0
  const availableSpan = pageWidth - PAGE_MARGIN - theme.headerWidth / 2 - theme.firstParticipantX
  const compression = naturalSpan > availableSpan ? availableSpan / naturalSpan : 1
  if (compression * theme.participantGap < theme.headerWidth + 0.125) throw new Error('Too many participants for the fixed 21.5-inch page; split the diagram.')
  const x = new Map(model.participants.map((participant, index) => [participant.id,
    theme.firstParticipantX + (index === 0 ? 0 : (theme.firstParticipantGap + (index - 1) * theme.participantGap) * compression)]))
  const gap = theme.participantGap * compression
  const labelCap = Math.max(0.6, gap - 0.4)
  const label = (text: string) => {
    const natural = measureText(text, messageSize)
    const width = Math.min(Math.max(natural.width, 5 * messageSize), labelCap)
    return { width, height: measureText(text, messageSize, width).height, capped: natural.width > labelCap }
  }

  // Vertical layout in native connection-point levels below the header bottom.
  const headerBottom = pageHeight - HEADER_TOP_MARGIN - theme.headerHeight
  const y = (level: number) => headerBottom - level * PITCH
  const messageAt = new Map(model.messages.map((message) => [message.step, message]))
  const beginLevel = new Map<Message, number>(), endLevel = new Map<Message, number>()
  const frameTop = new Map<Frame, number>(), frameBottom = new Map<Frame, number>(), branchLevel = new Map<number, number>()
  const noteTop = new Map<number, number>()
  const stepLevel: number[] = []
  const tabHeight = resolveInstance({ id: 0, master: MASTER.Loop }, () => 0).value('Height', 6)
  let previous = 0
  for (let step = 0; step < model.steps; step++) {
    stepLevel[step] = previous
    const message = messageAt.get(step)
    const starting = model.frames.filter((frame) => frame.start === step)
    for (const frame of starting) {
      const top = previous + 0.5
      frameTop.set(frame, top)
      previous = Math.ceil(top + (tabHeight + measureText(`[${frame.text}]`, branchSize).height) / PITCH)
    }
    for (const frame of model.frames) for (const branch of frame.branches.filter((entry) => entry.step === step)) {
      const divider = previous + 0.5
      branchLevel.set(step, divider)
      previous = Math.ceil(divider + measureText(`[${branch.text}]`, branchSize).height / PITCH)
    }
    for (const frame of model.frames.filter((entry) => entry.end === step)) {
      frameBottom.set(frame, previous + 0.5)
      previous += 1
    }
    for (const note of model.notes.filter((entry) => entry.step === step)) {
      const top = previous + 0.5
      noteTop.set(step, top)
      previous = Math.ceil(top + (measureText(note.text, messageSize, 2.7).height + 0.05) / PITCH)
    }
    if (message) {
      const { height } = label(message.text)
      if (message.from === message.to) {
        const above = Math.max(1, Math.ceil((height / 2 - PITCH + 0.06) / PITCH))
        const level = previous + above
        beginLevel.set(message, level)
        endLevel.set(message, level + 2)
        previous = Math.max(level + 2, level + 1 + Math.ceil((height / 2 - PITCH) / PITCH))
      } else {
        const level = previous + Math.max(1, Math.ceil((height + 0.03) / PITCH))
        beginLevel.set(message, level)
        endLevel.set(message, level)
        previous = level
      }
    }
  }
  const lastLevel = previous + 2
  if (lastLevel > MAX_LIFELINE_POINTS - 1 || y(lastLevel) < PAGE_MARGIN) throw new Error('Diagram is too tall for the fixed 24.5-inch page at the native 0.25-inch connection pitch. Split the diagram.')

  // Explicit lifetimes: a bar runs to its deactivation marker, including idle stretches while others work.
  const levelAt = (message: Message, participant: string) => (message.to === participant ? endLevel.get(message)! : beginLevel.get(message)!)
  const layoutSteps = new Set([...model.messages.map((message) => message.step), ...model.notes.map((note) => note.step),
    ...model.frames.flatMap((frame) => [frame.start, frame.end, ...frame.branches.map((branch) => branch.step)])])
  // Activation markers take no space: a marker sits on the arrow of the last message before it, else below the preceding frame/note.
  const markerLevel = (step: number) => {
    let previousStep = step - 1
    while (previousStep >= 0 && !layoutSteps.has(previousStep)) previousStep--
    const message = messageAt.get(previousStep)
    return message ? endLevel.get(message)! : stepLevel[step]
  }
  const bars: Bar[] = model.activations.map((activation) => {
    const touching = model.messages.filter((message) => (message.from === activation.participant || message.to === activation.participant)
      && message.step >= activation.start - 1 && message.step <= activation.end)
    const incoming = touching.find((message) => message.step === activation.start - 1 && message.to === activation.participant)
    const inside = touching.filter((message) => message.step >= activation.start)
    const top = incoming ? endLevel.get(incoming)! : inside.length ? levelAt(inside[0], activation.participant) : stepLevel[activation.start] + 1
    const last = inside.length ? Math.max(...inside.map((message) => levelAt(message, activation.participant))) : top + 1
    const bottom = Math.max(top + 1, last, markerLevel(activation.end))
    return { activation, top, bottom, x: x.get(activation.participant)! + activation.depth * theme.activationWidth / 2 }
  })
  for (const bar of bars) {
    bar.parent = bars.filter((candidate) => candidate.activation.participant === bar.activation.participant
      && candidate.activation.depth === bar.activation.depth - 1 && candidate.activation.start <= bar.activation.start && candidate.activation.end >= bar.activation.end)
      .sort((first, second) => second.activation.start - first.activation.start)[0]
  }

  let nextId = 1
  const allocate = () => nextId++
  const connects: string[] = []
  const usedMasters = new Set<number>()
  const glueFormula = (target: ResolvedInstance, row: number) => `PAR(PNT(Sheet.${target.spec.id}!Connections.X${row + 1},Sheet.${target.spec.id}!Connections.Y${row + 1}))`
  function attach(spec: InstanceSpec, endpoint: 'Begin' | 'End', target: ResolvedInstance, row: number, trigger = false) {
    const [pointX, pointY] = target.point(row)
    const formula = glueFormula(target, row)
    spec.cells![`${endpoint}X`] = v(pointX, formula)
    spec.cells![`${endpoint}Y`] = v(pointY, formula)
    if (trigger) spec.cells![endpoint === 'Begin' ? 'BegTrigger' : 'EndTrigger'] = v(2, `_XFTRIGGER(Sheet.${target.spec.id}!EventXFMod)`)
    connects.push(`<Connect FromSheet='${spec.id}' FromCell='${endpoint}X' FromPart='${endpoint === 'Begin' ? 9 : 12}' ToSheet='${target.spec.id}' ToCell='Connections.X${row + 1}' ToPart='${100 + row}'/>`)
  }
  function resolve(spec: InstanceSpec) {
    usedMasters.add(spec.master)
    return resolveInstance(spec, allocate)
  }

  // Fragment containers paint behind everything; operands paint above the bars (see shapesXml).
  const frameBounds = new Map<Frame, { left: number; right: number }>()
  const selfExtent = (message: Message) => x.get(message.from)! + theme.activationWidth / 2 + theme.selfLoopWidth + label(message.text).width + 0.08
  for (const frame of [...model.frames].sort((first, second) => second.depth - first.depth)) {
    const extents: number[] = []
    for (const message of model.messages.filter((entry) => entry.step > frame.start && entry.step < frame.end)) {
      extents.push(x.get(message.from)! - 0.18, x.get(message.to)! + 0.18, x.get(message.from)! + 0.18, x.get(message.to)! - 0.18)
      if (message.from === message.to) extents.push(selfExtent(message))
    }
    for (const note of model.notes.filter((entry) => entry.step > frame.start && entry.step < frame.end)) {
      const { left, width } = noteBox(note)
      extents.push(left, left + width)
    }
    for (const [child, bounds] of frameBounds) if (child.start > frame.start && child.end < frame.end) extents.push(bounds.left, bounds.right)
    if (!extents.length) extents.push(theme.firstParticipantX, theme.firstParticipantX + gap)
    const left = Math.min(...extents) - (frame.depth === 0 ? theme.headerWidth - 0.18 : theme.headerWidth / 2 - 0.18)
    frameBounds.set(frame, { left, right: Math.max(left + theme.minimumFrameWidth, Math.max(...extents) + 0.18) })
  }
  function noteBox(note: SequenceModel['notes'][number]) {
    const centers = note.participants.map((id) => x.get(id)!)
    const width = note.placement === 2 ? Math.max(2.7, Math.max(...centers) - Math.min(...centers)) : 2.7
    const left = note.placement === 0 ? centers[0] - width - 0.15 : note.placement === 1 ? centers[0] + 0.15 : (Math.min(...centers) + Math.max(...centers) - width) / 2
    return { left, width, height: measureText(note.text, messageSize, width).height + 0.05 }
  }
  const characterColor = (color: string) => {
    const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
    return v(color.toLowerCase(), `THEMEGUARD(RGB(${red},${green},${blue}))`)
  }
  const frameXml: string[] = []
  const operandXml: string[] = []
  for (const [index, frame] of model.frames.entries()) {
    const { left, right } = frameBounds.get(frame)!
    const width = right - left
    const top = y(frameTop.get(frame)!), bottom = y(frameBottom.get(frame)!)
    const base = { PinX: v(left + width / 2), PinY: v((top + bottom) / 2), Width: v(width), Height: v(top - bottom) }
    if (frame.kind === 'loop' || frame.kind === 'opt') {
      const spec: InstanceSpec = { id: allocate(), master: frame.kind === 'loop' ? MASTER.Loop : MASTER.Optional, nameU: `Fragment.${index + 1}`, cells: base,
        sub: { 7: { text: `[${frame.text}]`, cells: { 'Char.Color': characterColor(semanticColor(frame.text)) } } } }
      frameXml.push(resolve(spec).xml())
      continue
    }
    const containerId = allocate()
    const branches = [{ text: frame.text, top: top - tabHeight }, ...frame.branches.map((branch) => ({ text: branch.text, top: y(branchLevel.get(branch.step)!) }))]
    const operandIds = branches.map(() => allocate())
    const container: InstanceSpec = { id: containerId, master: MASTER.Alternative, nameU: `Fragment.${index + 1}`, cells: { ...base,
      'Controls.Row_1.X': v(width, `BOUND(${number(width)}DL,0,FALSE,1IN,100IN)`),
      Relationships: v(0, `SUM(DEPENDSON(1),DEPENDSON(2,${operandIds.map((id) => `Sheet.${id}!SheetRef()`).join(',')}),DEPENDSON(4))`) },
      ...(frame.kind === 'par' ? { sub: { 6: { text: 'par' } } } : {}) }
    frameXml.push(resolve(container).xml())
    branches.forEach((branch, branchIndex) => {
      const operandBottom = branchIndex + 1 < branches.length ? branches[branchIndex + 1].top : bottom
      const height = branch.top - operandBottom
      const operand: InstanceSpec = { id: operandIds[branchIndex], master: MASTER.Operand, nameU: `Operand.${index + 1}.${branchIndex + 1}`, text: `[${branch.text}]`, listOrder: branchIndex + 1,
        cells: { PinX: v(left + width / 2), PinY: v(operandBottom + height / 2), Width: v(width, 'IFERROR(LISTSHEETREF()!Controls.ROW_1,User.UserWidth)'),
          Height: v(height), LocPinY: v(height / 2, 'Height*0.5'), Relationships: v(0, `SUM(DEPENDSON(5,Sheet.${containerId}!SheetRef()))`),
          'Char.Color': characterColor(semanticColor(branch.text)), 'Char.Style': v(17),
          // Opaque only behind the guard text; the operand body keeps the master's transparent GUARD(0) fill.
          TextBkgnd: v('#ffffff', 'THEMEGUARD(RGB(255,255,255))'), TextBkgndTrans: v(0) } }
      operandXml.push(resolve(operand).xml())
    })
  }

  // Lifelines (authentic Object/Actor lifeline groups with 100 native connection points).
  const lifelines = new Map<string, ResolvedInstance>()
  const lineColor = v('#5b9bd5', 'THEMEGUARD(RGB(91,155,213))')
  for (const participant of model.participants) {
    const spec: InstanceSpec = { id: allocate(), master: participant.type === 'actor' ? MASTER.ActorLifeline : MASTER.ObjectLifeline, nameU: `Lifeline.${participant.id}`,
      text: participant.label,
      cells: { PinX: v(x.get(participant.id)!), PinY: v(headerBottom + theme.headerHeight / 2), Width: v(theme.headerWidth), Height: v(theme.headerHeight),
        LineColor: lineColor, 'Controls.Row_1.Y': v(-lastLevel * PITCH), 'Char.Size': v(theme.headerPoints / 72) },
      sub: Object.fromEntries([6, 7, 8, 9].map((id) => [id, { cells: { LineColor: lineColor } }])) }
    lifelines.set(participant.id, resolve(spec))
  }

  // Activation bars: Begin at the bottom, End at the top, both glued like the reference instances.
  const barSpecs: InstanceSpec[] = []
  const activationRows = masterConnectionRows(MASTER.Activation)
  bars.forEach((bar, index) => {
    const spec: InstanceSpec = { id: allocate(), master: MASTER.Activation, nameU: `Activation.${index + 1}`, cells: {
      LineColor: v('#42829e', 'THEMEGUARD(THEMEVAL("AccentColor"))'),
      FillForegnd: v('#d6e6ee', 'THEMEGUARD(MSOTINT(THEMEVAL("AccentColor"),80))'),
      FillBkgnd: v('#3f7996', 'THEMEGUARD(SHADE(FillForegnd,LUMDIFF(THEMEVAL("FillColor"),THEMEVAL("FillColor2"))))'),
      FillGradientEnabled: v(0) } }
    for (const [endpoint, level] of [['Begin', bar.bottom], ['End', bar.top]] as const) {
      const parent = bar.parent
      if (parent?.instance && level >= parent.top && level <= parent.bottom) {
        const row = sideRow(parent, level, true)
        attach(spec, endpoint, parent.instance, row)
      } else if (!bar.activation.depth) attach(spec, endpoint, lifelines.get(bar.activation.participant)!, level - 1)
      else { spec.cells![`${endpoint}X`] = v(bar.x); spec.cells![`${endpoint}Y`] = v(y(level)) }
    }
    bar.instance = resolve(spec)
    barSpecs.push(spec)
  })
  // Pick the native point by its evaluated position: the original master's rows 91-99 do not follow the pair pattern.
  // The master's 100 rows reach 12.25 in (right) / 11.75 in (left); a longer bar gets instance-only rows past them on demand.
  function sideRow(bar: Bar, level: number, right: boolean) {
    const spec = bar.instance!.spec
    const centre = bar.instance!.value('PinX'), targetY = y(level)
    const matches = (row: number) => {
      const [pointX, pointY] = bar.instance!.point(row)
      return Math.abs(pointY - targetY) < 1e-9 && (pointX > centre) === right
    }
    const rows = activationRows + (spec.connectionRows?.length ?? 0)
    let sideTemplate: number | undefined
    for (let row = 0; row < rows; row++) {
      if (matches(row)) return row
      if (sideTemplate === undefined && row < activationRows && (bar.instance!.point(row)[0] > centre) === right) sideTemplate = row
    }
    if (level < bar.top || level > bar.bottom || sideTemplate === undefined || rows - activationRows >= 2 * MAX_LIFELINE_POINTS) {
      throw new Error(`The native Activation of ${bar.activation.participant} has no ${right ? 'right' : 'left'} connection point ${number((level - bar.top) * PITCH)} in from its top.`)
    }
    // Same X rule as the master's even rows, side (local Y) formula copied from a master row on that edge.
    const distance = `${number((level - bar.top) * PITCH)}IN`
    spec.connectionRows = [...(spec.connectionRows ?? []), { X: `IF(Width>=${distance},Width-${distance},Width)`, Y: masterYFormula(sideTemplate) }]
    bar.instance = resolveInstance(spec, () => { throw new Error('The Activation master has no sub-shapes.') })
    if (!matches(rows)) throw new Error(`Extended connection point of the ${bar.activation.participant} Activation does not evaluate to its ${right ? 'right' : 'left'} edge.`)
    return rows
  }
  function masterYFormula(row: number) {
    const formula = masterCell(MASTER.Activation, `CONNECTIONS.Y${row + 1}`)?.F
    if (!formula) throw new Error(`Native Activation connection row ${row} has no Y formula.`)
    return formula
  }

  // Messages glue to the deepest active bar's side point, otherwise to the lifeline point.
  const messageXml: string[] = []
  const crossXml: string[] = []
  model.messages.forEach((message, index) => {
    const self = message.from === message.to
    const master = self ? MASTER.SelfMessage : message.dashed ? MASTER.Return : message.arrow === 'open' ? MASTER.Async : MASTER.Message
    const { width: textWidth, capped } = label(message.text)
    const spec: InstanceSpec = { id: allocate(), master, nameU: `Message.${index + 1}`, text: message.text, cells: {
      LineColor: v('#316176', 'THEMEGUARD(MSOTINT(THEMEVAL("AccentColor"),-25))'),
      'Char.Color': v('#000000', 'THEMEGUARD(RGB(0,0,0))'), 'Char.Size': v(messageSize) } }
    if (capped) spec.cells!.TxtWidth = v(textWidth, `MIN(MAX(TEXTWIDTH(TheText),5*Char.Size),${number(labelCap)})`)
    if (self) spec.cells!.Width = v(theme.selfLoopWidth, `GUARD(${number(theme.selfLoopWidth)}DL)`)
    // Native User.IsReturn would also clear User.IsSelfMessage and hide the loop: dash locally, open head via the master's IsAsync rule.
    if (self && message.dashed) spec.cells!.LinePattern = v(2, 'GUARD(2)')
    if (self && (message.arrow === 'open' || (message.dashed && message.arrow === 'filled'))) spec.cells!['User.IsAsync.Value'] = v(1)
    if (message.arrow === 'none' || message.arrow === 'cross') spec.cells!.EndArrow = v(0, 'GUARD(0)')
    const direction = self ? 1 : Math.sign(x.get(message.to)! - x.get(message.from)!)
    for (const [endpoint, participant, level, right] of [['Begin', message.from, beginLevel.get(message)!, direction > 0],
      ['End', message.to, endLevel.get(message)!, self || direction < 0]] as const) {
      const bar = bars.filter((entry) => entry.activation.participant === participant && message.step >= entry.activation.start - 1
        && message.step <= entry.activation.end && level >= entry.top && level <= entry.bottom).sort((first, second) => second.activation.depth - first.activation.depth)[0]
      if (bar) {
        const row = sideRow(bar, level, right)
        attach(spec, endpoint, bar.instance!, row, true)
      } else attach(spec, endpoint, lifelines.get(participant)!, level - 1, true)
    }
    const draft = resolveInstance(spec, () => 0)
    const width = draft.value('Width'), height = draft.value('Height'), locY = draft.value('LocPinY')
    const txtWidth = draft.value('TxtWidth'), txtHeight = draft.value('TxtHeight')
    if (self) {
      spec.cells!['Geometry1.X1'] = v(width / 2); spec.cells!['Geometry1.Y1'] = v(0)
      spec.cells!['Geometry1.X2'] = v(width / 2); spec.cells!['Geometry1.Y2'] = v(height)
      spec.cells!['Controls.TextPosition.X'] = v(width / 2 + theme.selfLoopWidth + txtWidth / 2)
      spec.cells!['Controls.TextPosition.Y'] = v(height / 2)
    } else {
      spec.cells!['Geometry1.X1'] = v(0); spec.cells!['Geometry1.Y1'] = v(locY)
      spec.cells!['Geometry1.X2'] = v(width); spec.cells!['Geometry1.Y2'] = v(locY)
      spec.cells!['Controls.TextPosition.X'] = v(width / 2)
      spec.cells!['Controls.TextPosition.Y'] = v(locY + txtHeight / 2 + 0.01)
    }
    const instance = resolve(spec)
    messageXml.push(instance.xml())
    if (message.arrow === 'cross') {
      const id = allocate()
      const endX = instance.value('EndX'), endY = instance.value('EndY')
      crossXml.push(plainShape(id, `Cross.${index + 1}`, endX, endY, 0.12, 0.12,
        `<Cell N='PinX' V='${number(endX)}' F='Sheet.${spec.id}!EndX'/><Cell N='PinY' V='${number(endY)}' F='Sheet.${spec.id}!EndY'/>`,
        `<Section N='Geometry' IX='0'><Cell N='NoFill' V='1'/><Row T='MoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='LineTo' IX='2'><Cell N='X' V='0.12'/><Cell N='Y' V='0.12'/></Row><Row T='MoveTo' IX='3'><Cell N='X' V='0'/><Cell N='Y' V='0.12'/></Row><Row T='LineTo' IX='4'><Cell N='X' V='0.12'/><Cell N='Y' V='0'/></Row></Section>`, theme.messageLine))
    }
  })

  // Notes have no master in the UML Sequence stencil and stay plain editable shapes.
  const noteXml = model.notes.map((note, index) => {
    const { left, width, height } = noteBox(note)
    const top = y(noteTop.get(note.step)!)
    return plainShape(allocate(), `Note.${index + 1}`, left + width / 2, top - height / 2, width, height, '',
      `<Section N='Geometry' IX='0'><Cell N='NoFill' V='0'/><Row T='RelMoveTo' IX='1'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='2'><Cell N='X' V='1'/><Cell N='Y' V='0'/></Row><Row T='RelLineTo' IX='3'><Cell N='X' V='1'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='4'><Cell N='X' V='0'/><Cell N='Y' V='1'/></Row><Row T='RelLineTo' IX='5'><Cell N='X' V='0'/><Cell N='Y' V='0'/></Row></Section>`
      + `<Section N='Character'><Row IX='0'><Cell N='Color' V='${theme.text}'/><Cell N='Size' V='${number(messageSize)}'/></Row></Section>`,
      theme.frameLine, '#FFF4BF', note.text)
  })

  const shapesXml = [...frameXml, ...[...lifelines.values()].map((lifeline) => lifeline.xml()), ...bars.map((bar) => bar.instance!.xml()), ...operandXml, ...messageXml, ...crossXml, ...noteXml].join('')
  const pageXml = xmlDeclaration(`<PageContents xmlns='${NS}' xmlns:r='${OFFICE_REL}' xml:space='preserve'><Shapes>${shapesXml}</Shapes>${connects.length ? `<Connects>${connects.join('')}</Connects>` : ''}</PageContents>`)

  const zip = new JSZip()
  const masters = nativeTemplate.masters
  zip.file('[Content_Types].xml', xmlDeclaration(`<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'>`
    + `<Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/>`
    + `<Override PartName='/visio/document.xml' ContentType='application/vnd.ms-visio.drawing.main+xml'/>`
    + `<Override PartName='/visio/masters/masters.xml' ContentType='application/vnd.ms-visio.masters+xml'/>`
    + masters.map((master) => `<Override PartName='/visio/masters/${master.file}' ContentType='application/vnd.ms-visio.master+xml'/>`).join('')
    + `<Override PartName='/visio/pages/pages.xml' ContentType='application/vnd.ms-visio.pages+xml'/>`
    + `<Override PartName='/visio/pages/page1.xml' ContentType='application/vnd.ms-visio.page+xml'/>`
    + `<Override PartName='/visio/windows.xml' ContentType='application/vnd.ms-visio.windows+xml'/>`
    + `<Override PartName='/visio/theme/theme1.xml' ContentType='application/vnd.openxmlformats-officedocument.theme+xml'/></Types>`))
  zip.file('_rels/.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'document', target: 'visio/document.xml' }]))
  zip.file('visio/document.xml', nativeTemplate.documentXml)
  zip.file('visio/_rels/document.xml.rels', relationships([
    { id: 'rId1', type: VISIO_REL + 'masters', target: 'masters/masters.xml' },
    { id: 'rId2', type: VISIO_REL + 'pages', target: 'pages/pages.xml' },
    { id: 'rId3', type: VISIO_REL + 'windows', target: 'windows.xml' },
    { id: 'rId4', type: OFFICE_REL + '/theme', target: 'theme/theme1.xml' },
  ]))
  zip.file('visio/masters/masters.xml', nativeTemplate.mastersXml)
  zip.file('visio/masters/_rels/masters.xml.rels', relationships(masters.map((master) => ({ id: master.rel, type: VISIO_REL + 'master', target: master.file }))))
  for (const master of masters) zip.file(`visio/masters/${master.file}`, master.xml)
  zip.file('visio/theme/theme1.xml', nativeTheme)
  zip.file('visio/windows.xml', xmlDeclaration(`<Windows xmlns='${NS}' xmlns:r='${OFFICE_REL}' ClientWidth='1200' ClientHeight='800'>`
    + `<Window ID='0' WindowType='Drawing' WindowState='1073741824' ContainerType='Page' Page='0' ViewScale='-1' ViewCenterX='${number(pageWidth / 2)}' ViewCenterY='${number(pageHeight / 2)}'>`
    + `<ShowRulers>1</ShowRulers><ShowGrid>0</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides><ShowConnectionPoints>0</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings></Window></Windows>`))
  const pageName = escapeXml(title || 'Sequence Diagram')
  zip.file('visio/pages/pages.xml', xmlDeclaration(`<Pages xmlns='${NS}' xmlns:r='${OFFICE_REL}'><Page ID='0' NameU='${pageName}' Name='${pageName}'><PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>`
    + Object.entries(pageSettings).map(([name, value]) => `<Cell N='${name}' V='${number(value)}'/>`).join('')
    + `<Section N='User'><Row N='msvThemeOrder'><Cell N='Value' V='0'/></Row></Section>`
    + `<Section N='Layer'><Row IX='0'>${Object.entries(connectorLayer).map(([name, value]) => `<Cell N='${name}' V='${value}'/>`).join('')}</Row></Section>`
    + `</PageSheet><Rel r:id='rId1'/></Page></Pages>`))
  zip.file('visio/pages/_rels/pages.xml.rels', relationships([{ id: 'rId1', type: VISIO_REL + 'page', target: 'page1.xml' }]))
  zip.file('visio/pages/_rels/page1.xml.rels', relationships(masters.filter((master) => usedMasters.has(master.id))
    .map((master, index) => ({ id: `rId${index + 1}`, type: VISIO_REL + 'master', target: `../masters/${master.file}` }))))
  zip.file('visio/pages/page1.xml', pageXml)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

function plainShape(id: number, name: string, pinX: number, pinY: number, width: number, height: number, pinCells: string, sections: string, line: string, fill?: string, text?: string) {
  const cells = pinCells || `<Cell N='PinX' V='${number(pinX)}'/><Cell N='PinY' V='${number(pinY)}'/>`
  return `<Shape ID='${id}' NameU='${escapeXml(name)}' Name='${escapeXml(name)}' Type='Shape' LineStyle='3' FillStyle='3' TextStyle='3'>${cells}`
    + `<Cell N='Width' V='${number(width)}'/><Cell N='Height' V='${number(height)}'/><Cell N='LocPinX' V='${number(width / 2)}' F='Width*0.5'/><Cell N='LocPinY' V='${number(height / 2)}' F='Height*0.5'/>`
    + `<Cell N='Angle' V='0'/><Cell N='LineWeight' V='${number(theme.lineWeight)}'/><Cell N='LineColor' V='${line}'/>`
    + `<Cell N='FillPattern' V='${fill ? 1 : 0}'/>${fill ? `<Cell N='FillForegnd' V='${fill}'/>` : ''}<Cell N='VerticalAlign' V='1'/>`
    + `${sections}${text ? `<Text>${escapeXml(text)}</Text>` : ''}</Shape>`
}
