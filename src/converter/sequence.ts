import mermaid from 'mermaid'
import { referenceTheme } from './theme'

export interface Participant { id: string; label: string; type?: 'participant' | 'actor' }
export interface Message { from: string; to: string; text: string; dashed: boolean; arrow: 'filled' | 'open' | 'cross' | 'none'; step: number }
export interface Frame { kind: 'alt' | 'opt' | 'loop' | 'par' | 'break'; text: string; start: number; end: number; depth: number; branches: { text: string; step: number }[] }
export interface Note { participants: string[]; placement: number; text: string; step: number }
export interface Activation { participant: string; start: number; end: number; depth: number }
export interface SequenceModel { participants: Participant[]; messages: Message[]; frames: Frame[]; notes: Note[]; activations: Activation[]; steps: number }
interface RawEvent { from?: string | string[]; to?: string; message: string; type: number; placement?: number; centralConnection?: number }
interface SequenceDB {
  getActors(): Map<string, { description: string; type: string; links: object; properties: object }>
  getMessages(): RawEvent[]
  getBoxes(): unknown[]
  getCreatedActors(): Map<string, unknown>
  getDestroyedActors(): Map<string, unknown>
}

// Mermaid's parser and renderer share global configuration: every diagram family runs through one queue.
let queue: Promise<void> = Promise.resolve()
export function serializedMermaid<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = queue.then(operation)
  queue = result.then(() => undefined, () => undefined)
  return result
}

function validateSource(source: string) {
  if (!source.trim() || source.length > 100_000) throw new Error('Enter a sequence diagram of at most 100,000 characters.')
  if (/%%\s*\{|^\s*---|@\{|\b(?:javascript|data)\s*:/im.test(source)) throw new Error('Directives, frontmatter, participant metadata and external content are unsupported.')
  if (/<(?!br\s*\/?\s*>)[^>]*>/i.test(source) || Array.from(source).some((character) => {
    const code = character.codePointAt(0)!
    return (code < 32 && ![9, 10, 13].includes(code)) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
  })) throw new Error('Only plain text and <br/> line breaks are supported; HTML is forbidden.')
  const statements = source.replace(/%%[^\n]*/g, '').split(/[\n;]/).map((line) => line.trim())
  if (statements.find((line) => line)?.toLowerCase() !== 'sequencediagram') throw new Error('Only sequenceDiagram is supported.')
  if (statements.some((line) => /^(?:box|create|destroy|autonumber|links?|properties|details|title|accTitle|accDescr)\b/i.test(line))) throw new Error('Box, create/destroy, autonumber and metadata are unsupported.')
}

function plain(value: string): string {
  return value.replace(/<br\s*\/?\s*>/gi, '\n')
}

async function parseUnlocked(source: string): Promise<SequenceModel> {
  validateSource(source)
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 100_000,
    suppressErrorRendering: true, secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'secure', 'suppressErrorRendering'],
    theme: 'base', fontFamily: referenceTheme.font,
    themeVariables: { fontFamily: referenceTheme.font, fontSize: '8pt', actorBkg: referenceTheme.headerFill,
      actorBorder: referenceTheme.headerFill, actorTextColor: referenceTheme.headerText,
      actorLineColor: referenceTheme.lifeline, signalColor: referenceTheme.messageLine,
      signalTextColor: referenceTheme.text, labelBoxBkgColor: '#FFFFFF', labelBoxBorderColor: referenceTheme.frameLine,
      labelTextColor: referenceTheme.text, loopTextColor: referenceTheme.text,
      activationBkgColor: referenceTheme.activationFill, activationBorderColor: referenceTheme.activationLine },
    sequence: { useMaxWidth: false, wrap: false, mirrorActors: false } })
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
  const db = diagram.db as unknown as SequenceDB
  if (db.getBoxes().length || db.getCreatedActors().size || db.getDestroyedActors().size) throw new Error('Box and create/destroy are unsupported.')
  const participants = [...db.getActors()].map(([id, actor]) => {
    if (actor.type !== 'participant' && actor.type !== 'actor') throw new Error(`Unsupported participant type: ${actor.type}.`)
    if (Object.keys(actor.links).length || Object.keys(actor.properties).length) throw new Error('Participant metadata is unsupported.')
    return { id, label: plain(actor.description), type: actor.type as Participant['type'] }
  })
  if (!participants.length || participants.length > 30) throw new Error('Use between 1 and 30 participants.')
  const model: SequenceModel = { participants, messages: [], frames: [], notes: [], activations: [], steps: 0 }
  const ids = new Set(participants.map((participant) => participant.id))
  const frames: Frame[] = []
  const active = new Map<string, Activation[]>()
  const events = db.getMessages()
  if (events.length > 1000) throw new Error('Use at most 1,000 sequence events.')
  const starts: Record<number, Frame['kind']> = { 10: 'loop', 12: 'alt', 15: 'opt', 19: 'par', 30: 'break' }
  const ends: Record<number, Frame['kind']> = { 11: 'loop', 14: 'alt', 16: 'opt', 21: 'par', 31: 'break' }
  for (const event of events) {
    const step = model.steps++
    if (event.centralConnection) throw new Error('Central connection arrows are unsupported.')
    if ([0, 1, 3, 4, 5, 6, 24, 25].includes(event.type)) {
      if (typeof event.from !== 'string' || !ids.has(event.from) || !event.to || !ids.has(event.to)) throw new Error('Message references an unknown participant.')
      model.messages.push({ from: event.from, to: event.to, text: plain(event.message), step,
        dashed: [1, 4, 6, 25].includes(event.type),
        arrow: [3, 4].includes(event.type) ? 'cross' : [24, 25].includes(event.type) ? 'open' : [5, 6].includes(event.type) ? 'none' : 'filled' })
    } else if (starts[event.type]) {
      if (frames.length >= 8) throw new Error('Use at most 8 nested frames.')
      const frame: Frame = { kind: starts[event.type], text: plain(event.message), start: step, end: step, depth: frames.length, branches: [] }
      frames.push(frame)
      model.frames.push(frame)
    } else if (ends[event.type]) {
      const frame = frames.pop()
      if (!frame || frame.kind !== ends[event.type]) throw new Error('Unbalanced sequence frame.')
      frame.end = step
    } else if (event.type === 13 || event.type === 20) {
      const frame = frames[frames.length - 1]
      if (!frame || frame.kind !== (event.type === 13 ? 'alt' : 'par')) throw new Error('Branch outside its matching frame.')
      frame.branches.push({ text: plain(event.message), step })
    } else if (event.type === 2) {
      const targets = Array.isArray(event.from) ? [...event.from] : [event.from, event.to].filter((id): id is string => !!id)
      if (!targets.length || targets.some((id) => !ids.has(id)) || ![0, 1, 2].includes(event.placement ?? -1)) throw new Error('Invalid note placement.')
      model.notes.push({ participants: targets, placement: event.placement!, text: plain(event.message), step })
    } else if (event.type === 17 || event.type === 18) {
      if (typeof event.from !== 'string' || !ids.has(event.from)) throw new Error('Invalid activation participant.')
      const stack = active.get(event.from) ?? []
      active.set(event.from, stack)
      if (event.type === 17) {
        const activation = { participant: event.from, start: step, end: step, depth: stack.length }
        stack.push(activation)
        model.activations.push(activation)
      } else {
        const activation = stack.pop()
        if (!activation) throw new Error('Activation ended before it began.')
        activation.end = step
      }
    } else throw new Error(`Unsupported sequence event type: ${event.type}.`)
  }
  if (frames.length || [...active.values()].some((stack) => stack.length)) throw new Error('Close all frames and activations before exporting.')
  if (model.messages.length > 500) throw new Error('Use at most 500 messages.')
  return model
}

export function parseSequence(source: string): Promise<SequenceModel> {
  return serializedMermaid(() => parseUnlocked(source))
}

export function prepareDiagram(source: string, renderId: string): Promise<{ svg: string; model: SequenceModel }> {
  return serializedMermaid(async () => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(renderId)) throw new Error('Invalid render ID.')
    const model = await parseUnlocked(source)
    const { svg } = await mermaid.mermaidAPI.render(renderId, source)
    return { svg, model }
  })
}