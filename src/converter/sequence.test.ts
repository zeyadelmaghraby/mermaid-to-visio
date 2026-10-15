// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import { parseSequence, prepareDiagram } from './sequence'
import { SAMPLE_CODE } from '../sample'

vi.mock('mermaid', async (importOriginal) => {
  const original = await importOriginal<typeof import('mermaid')>()
  return { ...original, default: { ...original.default, mermaidAPI: { ...original.default.mermaidAPI } } }
})

describe('sequence database snapshot', () => {
  it('maps break blocks to frames', async () => {
    const model = await parseSequence('sequenceDiagram\nA->>B: call\nbreak Unauthorized\nB-->>A: rejected\nend\nA->>B: next')
    expect(model.frames).toEqual([{ kind: 'break', text: 'Unauthorized', start: 1, end: 3, depth: 0, branches: [] }])
    expect(model.messages.map((message) => message.step)).toEqual([0, 2, 4])
  })

  it('preserves actors and requires explicit balanced activations', async () => {
    const plain = await parseSequence('sequenceDiagram\nactor A\nA->>B: hi')
    expect(plain.participants[0].type).toBe('actor')
    expect(plain.activations).toHaveLength(0)
    const active = await parseSequence('sequenceDiagram\nactor A\nactivate A\nA->>+B: hi\nB-->>-A: bye\ndeactivate A')
    expect(active.activations).toHaveLength(2)
  })

  it('preserves the exact acceptance sample', async () => {
    const model = await parseSequence(SAMPLE_CODE)
    expect(model.participants).toHaveLength(7)
    expect(model.messages).toHaveLength(21)
    expect(model.frames.map((frame) => [frame.kind, frame.depth])).toEqual([['alt', 0], ['alt', 1]])
    expect(model.messages[7].text).toContain('\nStatus = Received')
  })

  it('preserves all supported arrows, notes, activations and frame kinds', async () => {
    const model = await parseSequence(`sequenceDiagram
participant A
participant B
loop Retry
opt Enabled
par First
A->>+B: filled
Note left of A: left<br/>two
Note right of B: right
Note over A,B: spanning
and Second
B-->>-A: dashed
end
end
end
A->A: no arrow
A-->B: dashed none
A-)B: open
B--)A: dashed open
A-xB: cross
B--xA: dashed cross`)
    expect(model.messages.map((message) => [message.arrow, message.dashed])).toEqual([
      ['filled', false], ['filled', true], ['none', false], ['none', true],
      ['open', false], ['open', true], ['cross', false], ['cross', true],
    ])
    expect(model.frames.map((frame) => frame.kind)).toEqual(['loop', 'opt', 'par'])
    expect(model.frames[2].branches).toHaveLength(1)
    expect(model.notes.map((note) => note.placement)).toEqual([0, 1, 2])
    expect(model.notes[2].participants).toEqual(['A', 'B'])
    expect(model.activations).toHaveLength(1)
    expect(model.activations[0].end).toBeGreaterThan(model.activations[0].start)
  })

  it.each([
    '%%{init: {"securityLevel":"loose"}}%%\nsequenceDiagram\nA->>B: hi',
    '---\nconfig:\n securityLevel: loose\n---\nsequenceDiagram\nA->>B: hi',
    'sequenceDiagram\nA->>B: <img src="https://example.com">',
    'sequenceDiagram\nA->>B: <script>alert(1)</script>',
    'sequenceDiagram\nparticipant A@{type: database}',
    'sequenceDiagram\nactor A\nproperties A: {"unsafe":true}\nA->>B: hi',
    'sequenceDiagram\nautonumber\nA->>B: hi',
    'sequenceDiagram\nbox Group\nparticipant A\nend',
    'sequenceDiagram\ncreate participant B\nA->>B: hi',
    'sequenceDiagram\nA->>B: hi\ndestroy B\nA->>B: bye',
    'sequenceDiagram\nrect rgb(0,0,0)\nA->>B: hi\nend',
    'sequenceDiagram\ncritical Critical\nA->>B: hi\nend',
    'sequenceDiagram\npar_over Parallel\nA->>B: hi\nend',
    'sequenceDiagram\nA<<->>B: bidirectional',
    'sequenceDiagram\nA->>B: hi\nactivate B',
    'flowchart TD\nA-->B',
    'sequenceDiagram\nthis is invalid',
  ])('rejects unsupported or unsafe input: %s', async (source) => {
    await expect(parseSequence(source)).rejects.toThrow()
  })

  it('bounds source, participant and message counts', async () => {
    await expect(parseSequence('x'.repeat(100_001))).rejects.toThrow(/100,000/)
    await expect(parseSequence('sequenceDiagram\n' + Array.from({ length: 31 }, (_, index) => `participant P${index}`).join('\n'))).rejects.toThrow(/30 participants/)
    await expect(parseSequence('sequenceDiagram\n' + 'A->>B: hi\n'.repeat(501))).rejects.toThrow(/500 messages/)
  })

  it('recovers after invalid parsing and returns detached concurrent snapshots', async () => {
    const results = await Promise.allSettled([
      parseSequence(SAMPLE_CODE), parseSequence('sequenceDiagram\ninvalid syntax'),
      parseSequence('sequenceDiagram\nX->>Y: other'), parseSequence(SAMPLE_CODE),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    if (results[0].status !== 'fulfilled' || results[2].status !== 'fulfilled' || results[3].status !== 'fulfilled') throw new Error('Unexpected parse failure')
    expect(results[0].value.participants).toHaveLength(7)
    expect(results[2].value.participants.map((participant) => participant.id)).toEqual(['X', 'Y'])
    results[3].value.messages[0].text = 'changed'
    expect(results[0].value.messages[0].text).toBe('1. CreateBillRequest')
  })

  it('serializes prepare and parse once, with no nested queue deadlock', async () => {
    let running = 0
    const render = vi.spyOn(mermaid.mermaidAPI, 'render').mockImplementation(async () => {
      expect(running++).toBe(0)
      await Promise.resolve()
      running--
      return { svg: '<svg/>', diagramType: 'sequence' }
    })
    try {
      const [first, second, third] = await Promise.all([
        prepareDiagram(SAMPLE_CODE, 'first'), parseSequence('sequenceDiagram\nX->>Y: hi'),
        prepareDiagram('sequenceDiagram\nC->>D: bye', 'third'),
      ])
      expect(first.model.messages).toHaveLength(21)
      expect(second.participants[0].id).toBe('X')
      expect(third.model.participants[0].id).toBe('C')
      expect(render).toHaveBeenCalledTimes(2)
      await expect(prepareDiagram(SAMPLE_CODE, '../bad')).rejects.toThrow(/render ID/)
    } finally { render.mockRestore() }
  })

  it('renders real Mermaid SVG while keeping concurrent snapshots isolated', async () => {
    const previous = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox')
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value(this: SVGElement) {
      return { x: 0, y: 0, width: Math.max(10, (this.textContent?.length ?? 0) * 8), height: 16 }
    } })
    try {
      const [first, second] = await Promise.all([
        prepareDiagram('sequenceDiagram\nA->>B: first<br/>line', 'real-first'),
        prepareDiagram('sequenceDiagram\nX-->>Y: second', 'real-second'),
      ])
      for (const result of [first, second]) {
        const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml')
        expect(svg.querySelector('parsererror')).toBeNull()
        expect(svg.documentElement.localName).toBe('svg')
        expect(svg.querySelector('script, image, iframe')).toBeNull()
      }
      expect(first.model.messages[0].text).toBe('first\nline')
      expect(second.model.participants[0].id).toBe('X')
      expect(first.svg).toContain('first')
      expect(second.svg).toContain('second')
    } finally {
      if (previous) Object.defineProperty(SVGElement.prototype, 'getBBox', previous)
      else Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
    }
  })
})