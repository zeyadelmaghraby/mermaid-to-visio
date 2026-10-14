import { prepareEr, type ErModel } from './er'
import { generateErVsdx } from './erd-vsdx'
import { prepareDiagram as prepareSequence, type SequenceModel } from './sequence'
import { generateVsdx as generateSequenceVsdx } from './vsdx'

export type DiagramKind = 'sequence' | 'er'
export type DiagramModel = (SequenceModel & { kind: 'sequence' }) | ErModel

// The first statement selects the Mermaid family; anything else is rejected before Mermaid parses it.
export function detectKind(source: string): DiagramKind | null {
  const first = source.replace(/%%[^\n]*/g, '').split(/[\n;]/).map((line) => line.trim()).find((line) => line)?.toLowerCase()
  return first === 'sequencediagram' ? 'sequence' : first === 'erdiagram' ? 'er' : null
}

export async function prepareDiagram(source: string, renderId: string): Promise<{ svg: string; model: DiagramModel }> {
  const kind = detectKind(source)
  if (/^\s*---/.test(source)) throw new Error('Directives, frontmatter and metadata are unsupported.')
  if (kind === 'er') return prepareEr(source, renderId)
  if (kind !== 'sequence') throw new Error('Only sequenceDiagram and erDiagram are supported.')
  const { svg, model } = await prepareSequence(source, renderId)
  return { svg, model: { ...model, kind: 'sequence' } }
}

export function generateVsdx(model: DiagramModel, title?: string): Promise<Uint8Array> {
  return model.kind === 'er' ? generateErVsdx(model, title) : generateSequenceVsdx(model, title)
}
