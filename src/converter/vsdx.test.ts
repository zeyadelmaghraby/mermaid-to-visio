// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { parseSequence } from './sequence'
import { generateVsdx, PITCH } from './vsdx'
import { MASTER, nativeTemplate } from './native'
import manifest from './native/manifest.json'
import activationMasterXml from './native/master12.xml?raw'
import { SAMPLE_CODE } from '../sample'
import { pageSettings, referenceTheme, semanticColor, connectorLayer } from './theme'

const ORIGINAL_UNIQUE_IDS: Record<number, string> = {
  2: '{13080A10-0005-0000-8E40-00608CF305B2}', 4: '{12FCED47-0004-0000-8E40-00608CF305B2}', 5: '{43BFE53B-000B-0000-8E40-00608CF305B2}',
  6: '{0ABB4EBA-000D-0000-8E40-00608CF305B2}', 7: '{1F71E100-0006-0000-8E40-00608CF305B2}', 8: '{08E63976-0008-0000-8E40-00608CF305B2}',
  9: '{08E3E0B1-0009-0000-8E40-00608CF305B2}', 10: '{04892A1E-000E-0000-8E40-00608CF305B2}', 11: '{43C124C0-000C-0000-8E40-00608CF305B2}',
  14: '{1F71E313-000A-0000-8E40-00608CF305B2}', 15: '{1F71E19C-0007-0000-8E40-00608CF305B2}', 16: '{022179E8-0002-0000-8E40-00608CF305B2}',
}

async function documentIn(zip: JSZip, name: string): Promise<Document> {
  const source = await zip.file(name)!.async('string')
  expect(XMLValidator.validate(source), name).toBe(true)
  const doc = new DOMParser().parseFromString(source, 'application/xml')
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}

// Raw Connection X formulas of the original Activation master (rows 91-99 do not follow the pair pattern).
const activationXFormulas = Array.from(new DOMParser().parseFromString(activationMasterXml, 'application/xml')
  .querySelectorAll('Section[N="Connection"] > Row'))
  .map((row) => row.querySelector('Cell[N="X"]')!.getAttribute('F')!)
function activationX(row: number, width: number): number {
  const formula = activationXFormulas[row]
  if (formula === 'Width*1') return width
  const lift = /^IF\(Width>=([\d.]+)IN,Width-\1IN,Width\)$/.exec(formula)
  if (lift) return width >= Number(lift[1]) - 1e-12 ? width - Number(lift[1]) : width
  const ref = /^Connections\.X(\d+)$/.exec(formula)
  if (ref) return activationX(Number(ref[1]) - 1, width)
  throw new Error(`unexpected Activation formula row ${row}: ${formula}`)
}

const directCells = (element: Element, name: string) => Array.from(element.children).find((entry) => entry.localName === 'Cell' && entry.getAttribute('N') === name)

// Resolves instance values the way Visio does at initial open: local/Inh-cached value, otherwise the master cache.
async function loadPage(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const page = await documentIn(zip, 'visio/pages/page1.xml')
  const masters = new Map<string, Element>()
  for (const master of nativeTemplate.masters) masters.set(String(master.id), (await documentIn(zip, `visio/masters/${master.file}`)).querySelector('Shapes > Shape')!)
  const masterOf = (shape: Element): Element | undefined => {
    if (shape.hasAttribute('Master')) return masters.get(shape.getAttribute('Master')!)
    const parent = shape.parentElement?.closest('Shape[Master]')
    const group = parent ? masters.get(parent.getAttribute('Master')!) : undefined
    return group?.querySelector(`Shape[ID="${shape.getAttribute('MasterShape')}"]`) ?? undefined
  }
  const value = (shape: Element, name: string): number => {
    const own = directCells(shape, name) ?? (masterOf(shape) && directCells(masterOf(shape)!, name))
    expect(own, `${shape.getAttribute('NameU')}.${name}`).toBeDefined()
    return Number(own!.getAttribute('V'))
  }
  const rowValue = (shape: Element, section: string, row: string, cell: string, key = 'IX'): number => {
    const selector = `:scope > Section[N="${section}"] > Row[${key}="${row}"] > Cell[N="${cell}"]`
    const own = shape.querySelector(selector) ?? masterOf(shape)?.querySelector(selector)
    expect(own, `${shape.getAttribute('NameU')}.${section}.${row}.${cell}`).not.toBeNull()
    return Number(own!.getAttribute('V'))
  }
  const point = (shape: Element, row: number) => {
    const angle = value(shape, 'Angle')
    const localX = rowValue(shape, 'Connection', String(row), 'X') - value(shape, 'LocPinX')
    const localY = rowValue(shape, 'Connection', String(row), 'Y') - value(shape, 'LocPinY')
    return [value(shape, 'PinX') + localX * Math.cos(angle) - localY * Math.sin(angle), value(shape, 'PinY') + localX * Math.sin(angle) + localY * Math.cos(angle)]
  }
  const named = (name: string) => page.querySelector(`Shape[NameU="${name}"]`)!
  return { zip, page, value, rowValue, point, named, masterOf }
}

const headerBottom = pageSettings.PageHeight - 0.975 - referenceTheme.headerHeight
const onGrid = (y: number) => Math.abs((headerBottom - y) / PITCH - Math.round((headerBottom - y) / PITCH)) < 1e-9

// Exact user-reported input: the Source bar is longer than the master's predefined 12.25-inch point range.
const IBAN_CODE = `sequenceDiagram
    actor Source as Source System
    participant IAG as Internal API Gateway
    participant SR as Systems Requests Module
    participant Config as Configurations
    participant Banking as Intermediate Banking Module
    participant EAG as External API Gateway
    participant ARB as ARB / Al Rajhi Bank
    activate Source
    Source->>+IAG: 1. CreateIBANVerificationRequest(IBAN, RegisteredId)
    IAG->>IAG: 2. Authenticate and validate source system
    IAG->>+SR: 3. ForwardRequest(SystemId, IBANVerificationRequest)
    SR->>+Config: 4. Validate request using configured business rules
    Config-->>-SR: Validation result
    alt Validation failed
        SR-->>IAG: Return validation business error
        IAG-->>Source: Return validation business error
    else Validation succeeded
        SR->>SR: 5. Create system request header and generate RequestNumber<br/>Status = RECEIVED
        SR->>+Banking: 6. VerifyIBAN(SystemRequestId, IBAN, RegisteredId, CorrelationId)
        Banking->>Banking: 7. Create IBAN verification request record<br/>Link SystemRequestId<br/>Status = RECEIVED
        Banking->>Banking: 8. Generate unique MsgReference and record bank request
        Banking->>+EAG: 9. CreateIBANVerificationRequest(IBAN, RegisteredId, MsgReference)
        EAG->>+ARB: 10. Forward IBAN verification request
        ARB-->>-EAG: 11. Response(IBAN, Status, AccountDetails) or bank error
        EAG-->>-Banking: 12. Bank response or integration error/timeout
        Banking->>Banking: 13. Record bank response or integration error
        alt IBAN verification succeeded
            Banking->>Banking: 14. Store verification result and account details<br/>Update module request status = COMPLETED
        else IBAN verification failed
            Banking->>Banking: 14. Store verification failure or integration error<br/>Update module request status = FAILED
        end
        Banking-->>-SR: 15. Response(SystemRequestId, IBAN, Status, AccountDetails, Error)
        SR->>SR: 16. Update system request header status<br/>COMPLETED or FAILED according to module result
        SR-->>IAG: 17. Response(SystemRequestId, IBAN, Status, AccountDetails, Error)
        IAG-->>Source: 18. Response(SystemRequestId, IBAN, Status, AccountDetails, Error)
    end
    deactivate SR
    deactivate IAG
    deactivate Source`

const EXTENSION_X = /^IF\(Width>=([\d.]+)IN,Width-\1IN,Width\)$/
// Instance-only Connection rows (IX >= 100) appended past the master's 100 rows: explicit formulas, never Inh.
function extensionRows(bar: Element) {
  return Array.from(bar.querySelectorAll(':scope > Section[N="Connection"] > Row')).filter((row) => Number(row.getAttribute('IX')) >= 100).map((row) => {
    const cell = (name: string) => row.querySelector(`Cell[N="${name}"]`)!
    return { row, ix: Number(row.getAttribute('IX')), xF: cell('X').getAttribute('F')!, yF: cell('Y').getAttribute('F')!, x: Number(cell('X').getAttribute('V')), y: Number(cell('Y').getAttribute('V')) }
  })
}

describe('native Visio package', () => {
  it('packages the authentic UML Sequence masters, styles and document settings without customer content', async () => {
    const { zip } = await loadPage(await generateVsdx(await parseSequence(SAMPLE_CODE)))
    expect(await zip.file('visio/masters/masters.xml')!.async('string')).toBe(nativeTemplate.mastersXml)
    for (const master of nativeTemplate.masters) expect(await zip.file(`visio/masters/${master.file}`)!.async('string')).toBe(master.xml)
    expect(manifest.reference).toBe('FA5366E43261593B23651B47C7B3E138CA0425B79F2A77BD0CA09313B9CF4FD7')
    const masters = await documentIn(zip, 'visio/masters/masters.xml')
    const entries = Array.from(masters.querySelectorAll('Master'))
    expect(entries).toHaveLength(12)
    for (const entry of entries) {
      expect(entry.getAttribute('UniqueID')).toBe(ORIGINAL_UNIQUE_IDS[Number(entry.getAttribute('ID'))])
      for (const attribute of ['BaseID', 'MatchByName', 'Prompt', 'MasterType', 'IconUpdate']) expect(entry.hasAttribute(attribute), attribute).toBe(true)
      expect(entry.querySelector('PageSheet')).not.toBeNull()
      expect(entry.querySelector('Icon')).not.toBeNull()
    }
    const activation = (await documentIn(zip, 'visio/masters/master12.xml')).querySelector('Shape')!
    expect(activation.getAttribute('LineStyle')).toBe('3')
    expect(activation.querySelectorAll('Section[N="Connection"] Row')).toHaveLength(100)
    const document = await documentIn(zip, 'visio/document.xml')
    expect(Array.from(document.querySelectorAll('StyleSheet')).map((sheet) => sheet.getAttribute('NameU'))).toEqual(['No Style', 'Text Only', 'None', 'Normal', 'Guide', 'Theme', 'Connector'])
    expect(Array.from(document.querySelectorAll('FaceName')).map((face) => face.getAttribute('NameU'))).toEqual(['Calibri', 'Arial'])
    expect(document.querySelector('DocumentSettings > SnapSettings')!.textContent).toBe('65847')
    expect(document.querySelector('DocumentSettings')!.getAttribute('TopPage')).toBe('0')
    expect(document.querySelector('EventItem[TargetArgs*="UMLSequence"]')).not.toBeNull()
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
    expect(files.some((name) => /docProps|thumbnail|\.emf$/.test(name))).toBe(false)
    for (const name of files.filter((entry) => !entry.startsWith('visio/pages/page1') && entry !== 'visio/pages/pages.xml')) {
      expect(await zip.file(name)!.async('string'), name).not.toMatch(/CreateBill|Tahseel|SADAD|Bills_Manage|Create_Bill|Internal API/)
    }
    for (const name of files.filter((entry) => entry.endsWith('.rels'))) expect(await zip.file(name)!.async('string')).not.toMatch(/TargetMode|https?:\/\/(?!schemas\.)/)
  })

  it('uses native master instances for every supported UML action in the acceptance sample', async () => {
    const model = await parseSequence(SAMPLE_CODE)
    const { page, value, named } = await loadPage(await generateVsdx(model))
    const top = Array.from(page.querySelectorAll('PageContents > Shapes > Shape'))
    const count = (master: number) => top.filter((shape) => shape.getAttribute('Master') === String(master)).length
    expect(count(MASTER.ActorLifeline)).toBe(1)
    expect(count(MASTER.ObjectLifeline)).toBe(6)
    expect(count(MASTER.Activation)).toBe(model.activations.length)
    expect(count(MASTER.Alternative)).toBe(2)
    expect(count(MASTER.Operand)).toBe(4)
    expect(count(MASTER.SelfMessage)).toBe(model.messages.filter((message) => message.from === message.to).length)
    expect(count(MASTER.Return)).toBe(model.messages.filter((message) => message.dashed && message.from !== message.to).length)
    expect(count(MASTER.Message)).toBe(model.messages.filter((message) => !message.dashed && message.from !== message.to).length)
    expect(top.filter((shape) => !shape.hasAttribute('Master'))).toHaveLength(0)
    const actor = named('Lifeline.Source')
    expect(actor.querySelector('Text')!.textContent).toBe('Source System')
    expect(actor.querySelectorAll(':scope > Shapes > Shape[MasterShape]')).toHaveLength(4)
    expect(value(actor, 'Width')).toBeCloseTo(referenceTheme.headerWidth)
    expect(value(actor, 'Height')).toBeCloseTo(referenceTheme.headerHeight)
    expect(value(named('Lifeline.IAG'), 'PinX') - value(actor, 'PinX')).toBeCloseTo(1.9375)
    expect(value(named('Lifeline.SR'), 'PinX') - value(named('Lifeline.IAG'), 'PinX')).toBeCloseTo(2.0625)
    expect(named('Fragment.1').querySelector('Cell[N="Relationships"]')!.getAttribute('F')).toMatch(/^SUM\(DEPENDSON\(1\),DEPENDSON\(2,Sheet\.\d+!SheetRef\(\),Sheet\.\d+!SheetRef\(\)\),DEPENDSON\(4\)\)$/)
    const operand = named('Operand.1.1')
    expect(operand.querySelector('Cell[N="Relationships"]')!.getAttribute('F')).toBe(`SUM(DEPENDSON(5,Sheet.${named('Fragment.1').getAttribute('ID')}!SheetRef()))`)
    expect(operand.querySelector('Text')!.textContent).toBe('[Validation failed]')
    expect(operand.querySelector('Section[N="Character"] Cell[N="Color"]')!.getAttribute('V')).toBe(semanticColor('Validation failed').toLowerCase())
    expect(value(named('Operand.1.1'), 'PinY')).toBeGreaterThan(value(named('Operand.1.2'), 'PinY'))
    expect(value(named('Operand.1.1'), 'PinY') - value(named('Operand.1.1'), 'Height') / 2).toBeCloseTo(value(named('Operand.1.2'), 'PinY') + value(named('Operand.1.2'), 'Height') / 2)
  })

  it('orients every Activation like the reference (Begin bottom, End top, +90 degrees) with cached top-down point pairs', async () => {
    const model = await parseSequence(SAMPLE_CODE)
    const { page, value, rowValue, point, named } = await loadPage(await generateVsdx(model))
    const expected: Record<string, number> = { Billing: 18, EAG: 14, Tahseel: 13, Config: 5 }
    // Source, IAG and SR are deactivated after the outer alt's `end`: their bars run past the frame footer.
    const outer = named('Fragment.1')
    const footer = value(outer, 'PinY') - value(outer, 'Height') / 2
    expect(activationXFormulas).toHaveLength(100)
    expect([91, 93, 95, 97, 99].map((row) => activationXFormulas[row])).toEqual(['Connections.X90', 'Connections.X91', 'Connections.X92', 'Connections.X93', 'Connections.X95'])
    for (let row = 1; row < 91; row += 2) expect(activationXFormulas[row]).toBe(`Connections.X${row}`)
    for (let row = 2; row < 100; row += 2) expect(activationXFormulas[row]).toBe(`IF(Width>=${row / 2 * PITCH}IN,Width-${row / 2 * PITCH}IN,Width)`)
    for (const [index, activation] of model.activations.entries()) {
      const bar = named(`Activation.${index + 1}`)
      expect(bar.getAttribute('Master')).toBe(String(MASTER.Activation))
      const beginY = value(bar, 'BeginY'), endY = value(bar, 'EndY')
      expect(beginY).toBeLessThan(endY)
      expect(Math.atan2(endY - beginY, value(bar, 'EndX') - value(bar, 'BeginX'))).toBeCloseTo(Math.PI / 2, 12)
      expect(value(bar, 'Angle')).toBeCloseTo(Math.PI / 2, 12)
      expect(value(bar, 'Width')).toBeCloseTo(endY - beginY, 12)
      for (let row = 0; row < 100; row++) {
        expect(rowValue(bar, 'Connection', String(row), 'X'), `row ${row}`).toBeCloseTo(activationX(row, value(bar, 'Width')), 10)
      }
      expect(Array.from(bar.querySelectorAll(':scope > Section[N="Connection"] > Row > Cell[N="X"]')).every((cell) => cell.getAttribute('F') === 'Inh')).toBe(true)
      for (let level = 0; level <= Math.round((endY - beginY) / PITCH); level++) {
        const [rightX, rightY] = point(bar, 2 * level), [leftX, leftY] = point(bar, 2 * level + 1)
        expect(rightY).toBeCloseTo(beginY + activationX(2 * level, value(bar, 'Width')), 10)
        expect(leftY).toBeCloseTo(beginY + activationX(2 * level + 1, value(bar, 'Width')), 10)
        if (2 * level + 1 < 91) expect(leftY).toBeCloseTo(endY - level * PITCH, 10)
        expect(rightX - value(bar, 'PinX')).toBeCloseTo(referenceTheme.activationWidth / 2, 10)
        expect(leftX - value(bar, 'PinX')).toBeCloseTo(-referenceTheme.activationWidth / 2, 10)
      }
      expect(rowValue(bar, 'Connection', '0', 'X')).toBeCloseTo(value(bar, 'Width'), 12)
      if (expected[activation.participant]) {
        const reply = named(`Message.${expected[activation.participant]}`)
        expect(beginY, `Activation.${index + 1} ${activation.participant}`).toBeCloseTo(value(reply, 'BeginY'), 10)
      } else expect(beginY, `Activation.${index + 1} ${activation.participant}`).toBeCloseTo(footer - PITCH / 2, 10)
      const glued = Array.from(page.querySelectorAll(`Connect[FromSheet="${bar.getAttribute('ID')}"]`))
      expect(glued.map((connect) => connect.getAttribute('FromCell')).sort()).toEqual(['BeginX', 'EndX'])
      for (const connect of glued) {
        const target = page.querySelector(`Shape[ID="${connect.getAttribute('ToSheet')}"]`)!
        expect(target.getAttribute('NameU')).toBe(`Lifeline.${activation.participant}`)
        const row = Number(connect.getAttribute('ToPart')) - 100
        expect(connect.getAttribute('ToCell')).toBe(`Connections.X${row + 1}`)
        const [pointX, pointY] = point(target, row)
        const endpoint = connect.getAttribute('FromCell') === 'BeginX' ? 'Begin' : 'End'
        expect(value(bar, `${endpoint}X`)).toBeCloseTo(pointX, 10)
        expect(value(bar, `${endpoint}Y`)).toBeCloseTo(pointY, 10)
        expect(directCells(bar, `${endpoint}Y`)!.getAttribute('F')).toBe(`PAR(PNT(Sheet.${target.getAttribute('ID')}!Connections.X${row + 1},Sheet.${target.getAttribute('ID')}!Connections.Y${row + 1}))`)
      }
    }
  })

  it('glues every message endpoint to a real native point on the quarter-inch pitch', async () => {
    const model = await parseSequence(SAMPLE_CODE)
    const { page, value, point } = await loadPage(await generateVsdx(model))
    const connects = Array.from(page.querySelectorAll('Connect'))
    expect(connects).toHaveLength(model.messages.length * 2 + model.activations.length * 2)
    for (const connect of connects) {
      const from = page.querySelector(`Shape[ID="${connect.getAttribute('FromSheet')}"]`)!
      const to = page.querySelector(`Shape[ID="${connect.getAttribute('ToSheet')}"]`)!
      const row = Number(connect.getAttribute('ToPart')) - 100
      expect(row).toBeGreaterThanOrEqual(0)
      expect(row).toBeLessThan(100)
      const endpoint = connect.getAttribute('FromCell') === 'BeginX' ? 'Begin' : 'End'
      expect(connect.getAttribute('FromPart')).toBe(endpoint === 'Begin' ? '9' : '12')
      const [pointX, pointY] = point(to, row)
      expect(value(from, `${endpoint}X`)).toBeCloseTo(pointX, 10)
      expect(value(from, `${endpoint}Y`)).toBeCloseTo(pointY, 10)
      expect(onGrid(pointY)).toBe(true)
      if (from.getAttribute('NameU')!.startsWith('Message.')) {
        expect(directCells(from, endpoint === 'Begin' ? 'BegTrigger' : 'EndTrigger')!.getAttribute('F')).toBe(`_XFTRIGGER(Sheet.${to.getAttribute('ID')}!EventXFMod)`)
        if (to.getAttribute('Master') === String(MASTER.Activation)) {
          const other = endpoint === 'Begin' ? value(from, 'EndX') : value(from, 'BeginX')
          const self = value(from, 'BeginX') === value(from, 'EndX')
          const right = self || other > value(to, 'PinX')
          expect(pointX > value(to, 'PinX')).toBe(right)
        }
      }
    }
  })

  it('keeps explicit lifetimes: later work after an early return extends the bar instead of truncating it', async () => {
    const model = await parseSequence(`sequenceDiagram
participant A
participant B
participant C
A->>+B: call
B-->>A: accepted
B->>C: later work
C-->>B: done
deactivate B`)
    const { value, named } = await loadPage(await generateVsdx(model))
    const bar = named('Activation.1')
    expect(value(bar, 'EndY')).toBeCloseTo(value(named('Message.1'), 'EndY'), 10)
    expect(value(bar, 'BeginY')).toBeCloseTo(value(named('Message.4'), 'EndY'), 10)
    expect(value(bar, 'BeginY')).toBeLessThan(value(named('Message.2'), 'BeginY'))
  })

  it('honors an explicit deactivation after idle time while other participants work', async () => {
    const model = await parseSequence(`sequenceDiagram
A->>+B: call
B-->>A: accepted
A->>C: later work
C-->>A: done
deactivate B`)
    const { value, named } = await loadPage(await generateVsdx(model))
    const bar = named('Activation.1')
    expect(value(bar, 'EndY')).toBeCloseTo(value(named('Message.1'), 'EndY'), 10)
    expect(value(bar, 'BeginY')).toBeCloseTo(value(named('Message.4'), 'EndY'), 10)
    expect(value(bar, 'BeginY')).toBeLessThan(value(named('Message.2'), 'BeginY'))
  })

  it('closes a direct -->>- at its return and a deactivation after `end` below the frame footer', async () => {
    const model = await parseSequence(`sequenceDiagram
A->>+B: call
B->>+C: check
C-->>-B: checked
alt ok
B-->>A: done
else failed
B-->>A: error
end
deactivate B`)
    const { value, named, page } = await loadPage(await generateVsdx(model))
    const outer = named('Activation.1'), inner = named('Activation.2')
    expect(value(inner, 'BeginY')).toBeCloseTo(value(named('Message.3'), 'EndY'), 10)
    const frame = named('Fragment.1')
    const footer = value(frame, 'PinY') - value(frame, 'Height') / 2
    expect(value(outer, 'BeginY')).toBeCloseTo(footer - PITCH / 2, 10)
    expect(value(outer, 'BeginY')).toBeLessThan(value(named('Message.5'), 'BeginY'))
    const glued = Array.from(page.querySelectorAll(`Connect[FromSheet="${outer.getAttribute('ID')}"]`))
    expect(glued.map((connect) => connect.getAttribute('ToSheet'))).toEqual([named('Lifeline.B').getAttribute('ID'), named('Lifeline.B').getAttribute('ID')])
  })

  it('reuses the master\'s 100 points (47 levels left, 49 right) and appends an instance point only where one is missing', async () => {
    const bar = (body: string) => parseSequence(`sequenceDiagram
participant A
participant B
participant C
activate B
A->>B: x
${body}deactivate B`)
    const left47 = await loadPage(await generateVsdx(await bar('A->>B: x\n'.repeat(47))))
    const span = (page: typeof left47) => (page.value(page.named('Activation.1'), 'EndY') - page.value(page.named('Activation.1'), 'BeginY')) / PITCH
    expect(span(left47)).toBeCloseTo(47, 10)
    expect(extensionRows(left47.named('Activation.1'))).toHaveLength(0)
    const left48 = await loadPage(await generateVsdx(await bar('A->>B: x\n'.repeat(48))))
    const added = extensionRows(left48.named('Activation.1'))
    expect(added.map(({ ix, xF, yF }) => ({ ix, xF, yF }))).toEqual([{ ix: 100, xF: 'IF(Width>=12IN,Width-12IN,Width)', yF: 'Height*1' }])
    expect(added[0].row.querySelector('Cell[F="Inh"]')).toBeNull()
    const last = left48.page.querySelector(`Connect[FromSheet="${left48.named('Message.49').getAttribute('ID')}"][FromCell="EndX"]`)!
    expect(last.getAttribute('ToSheet')).toBe(left48.named('Activation.1').getAttribute('ID'))
    expect(last.getAttribute('ToPart')).toBe('200')
    expect(last.getAttribute('ToCell')).toBe('Connections.X101')
    const [pointX, pointY] = left48.point(left48.named('Activation.1'), 100)
    expect(pointX).toBeLessThan(left48.value(left48.named('Activation.1'), 'PinX'))
    expect(left48.value(left48.named('Message.49'), 'EndY')).toBeCloseTo(pointY, 10)
    const right49 = await loadPage(await generateVsdx(await bar('B->>C: x\n'.repeat(49))))
    expect(span(right49)).toBeCloseTo(49, 10)
    expect(extensionRows(right49.named('Activation.1'))).toHaveLength(0)
  })

  it('exports the exact long IBAN verification input by extending only the Activation instance Connection section', async () => {
    const model = await parseSequence(IBAN_CODE)
    expect(model.participants).toHaveLength(7)
    expect(model.messages).toHaveLength(22)
    expect(model.frames).toHaveLength(2)
    expect(model.activations).toHaveLength(7)
    const bytes = await generateVsdx(model, 'IBANVerification')
    const { zip, page, value, rowValue, point, named } = await loadPage(bytes)
    expect(await zip.file('visio/masters/masters.xml')!.async('string')).toBe(nativeTemplate.mastersXml)
    for (const master of nativeTemplate.masters) expect(await zip.file(`visio/masters/${master.file}`)!.async('string')).toBe(master.xml)
    expect(await zip.file('visio/masters/master12.xml')!.async('string')).toBe(activationMasterXml)
    const source = named('Activation.1')
    expect(model.activations[0].participant).toBe('Source')
    expect(value(source, 'Width')).toBeGreaterThan(49 * PITCH)
    let extended = 0
    for (const [index] of model.activations.entries()) {
      const bar = named(`Activation.${index + 1}`)
      const width = value(bar, 'Width'), beginY = value(bar, 'BeginY'), endY = value(bar, 'EndY')
      expect(value(bar, 'Angle')).toBeCloseTo(Math.PI / 2, 12)
      expect(beginY).toBeLessThan(endY)
      for (let row = 0; row < 100; row++) expect(rowValue(bar, 'Connection', String(row), 'X'), `row ${row}`).toBeCloseTo(activationX(row, width), 10)
      const rows = Array.from(bar.querySelectorAll(':scope > Section[N="Connection"] > Row'))
      for (const row of rows.filter((entry) => Number(entry.getAttribute('IX')) < 100)) {
        for (const cell of Array.from(row.querySelectorAll('Cell'))) expect(cell.getAttribute('F')).toBe('Inh')
      }
      const extras = extensionRows(bar)
      extended += extras.length
      extras.forEach((extra, offset) => {
        expect(extra.ix).toBe(100 + offset)
        const distance = Number(EXTENSION_X.exec(extra.xF)![1])
        expect(Math.round(distance / PITCH) * PITCH).toBeCloseTo(distance, 12)
        expect(extra.x).toBeCloseTo(width - distance, 10)
        expect(['Height*0', 'Height*1']).toContain(extra.yF)
        expect(extra.y).toBeCloseTo(extra.yF === 'Height*0' ? 0 : value(bar, 'Height'), 12)
        const [pointX, pointY] = point(bar, extra.ix)
        expect(pointY).toBeCloseTo(endY - distance, 10)
        expect(pointX > value(bar, 'PinX')).toBe(extra.yF === 'Height*0')
        // Only added where none of the master's 100 rows already sits at this side and level.
        for (let row = 0; row < 100; row++) {
          const [originalX, originalY] = point(bar, row)
          expect(Math.abs(originalY - pointY) < 1e-9 && (originalX > value(bar, 'PinX')) === (pointX > value(bar, 'PinX'))).toBe(false)
        }
      })
    }
    expect(extensionRows(source).length).toBeGreaterThan(0)
    expect(extended).toBeLessThanOrEqual(model.messages.length * 2 + model.activations.length * 2)
    const connects = Array.from(page.querySelectorAll('Connect'))
    expect(connects).toHaveLength(model.messages.length * 2 + model.activations.length * 2)
    let extendedGlue = 0
    for (const connect of connects) {
      const from = page.querySelector(`Shape[ID="${connect.getAttribute('FromSheet')}"]`)!
      const to = page.querySelector(`Shape[ID="${connect.getAttribute('ToSheet')}"]`)!
      const row = Number(connect.getAttribute('ToPart')) - 100
      expect(connect.getAttribute('ToCell')).toBe(`Connections.X${row + 1}`)
      if (row >= 100) { extendedGlue++; expect(to.querySelector(`:scope > Section[N="Connection"] > Row[IX="${row}"]`)).not.toBeNull() }
      const endpoint = connect.getAttribute('FromCell') === 'BeginX' ? 'Begin' : 'End'
      const [pointX, pointY] = point(to, row)
      expect(value(from, `${endpoint}X`)).toBeCloseTo(pointX, 10)
      expect(value(from, `${endpoint}Y`)).toBeCloseTo(pointY, 10)
      expect(onGrid(pointY)).toBe(true)
      expect(directCells(from, `${endpoint}Y`)!.getAttribute('F')).toBe(`PAR(PNT(Sheet.${to.getAttribute('ID')}!Connections.X${row + 1},Sheet.${to.getAttribute('ID')}!Connections.Y${row + 1}))`)
      if (from.getAttribute('NameU')!.startsWith('Message.') && to.getAttribute('Master') === String(MASTER.Activation)) {
        const other = endpoint === 'Begin' ? value(from, 'EndX') : value(from, 'BeginX')
        const self = value(from, 'BeginX') === value(from, 'EndX')
        expect(pointX > value(to, 'PinX')).toBe(self || other > value(to, 'PinX'))
      }
    }
    expect(extendedGlue).toBeGreaterThan(0)
    // Guard labels paint above the bars (Source/Banking cover them otherwise); containers stay behind, messages stay on top.
    const roots = Array.from(page.querySelectorAll('PageContents > Shapes > Shape'))
    const order = (prefix: string) => roots.flatMap((shape, index) => (shape.getAttribute('NameU')!.startsWith(prefix) ? [index] : []))
    const [fragments, lifelineOrder, barOrder, operandOrder, messageOrder] = ['Fragment.', 'Lifeline.', 'Activation.', 'Operand.', 'Message.'].map(order)
    expect([fragments.length, barOrder.length, operandOrder.length, messageOrder.length]).toEqual([2, 7, 4, 22])
    expect(Math.max(...fragments)).toBeLessThan(Math.min(...lifelineOrder))
    expect(Math.max(...barOrder)).toBeLessThan(Math.min(...operandOrder))
    expect(Math.max(...operandOrder)).toBeLessThan(Math.min(...messageOrder))
    for (const name of ['Operand.1.1', 'Operand.1.2', 'Operand.2.1', 'Operand.2.2']) {
      const operand = named(name)
      expect(directCells(operand, 'TextBkgnd')!.getAttribute('V'), name).toBe('#ffffff')
      expect(directCells(operand, 'TextBkgnd')!.getAttribute('F'), name).toBe('THEMEGUARD(RGB(255,255,255))')
      expect(directCells(operand, 'TextBkgndTrans')!.getAttribute('V'), name).toBe('0')
      expect(value(operand, 'FillPattern'), name).toBe(0)
      expect(directCells(operand, 'FillPattern'), name).toBeUndefined()
      const fragment = named(`Fragment.${name.split('.')[1]}`)
      expect(operand.querySelector('Cell[N="Relationships"]')!.getAttribute('F')).toBe(`SUM(DEPENDSON(5,Sheet.${fragment.getAttribute('ID')}!SheetRef()))`)
      expect(fragment.querySelector('Cell[N="Relationships"]')!.getAttribute('F')).toContain(`Sheet.${operand.getAttribute('ID')}!SheetRef()`)
    }
    expect(Array.from(page.querySelectorAll('Shape[NameU^="Operand."] > Text')).map((text) => text.textContent))
      .toEqual(['[Validation failed]', '[Validation succeeded]', '[IBAN verification succeeded]', '[IBAN verification failed]'])
    expect(named('Message.22').querySelector('Text')!.textContent).toBe('18. Response(SystemRequestId, IBAN, Status, AccountDetails, Error)')
    for (const shape of Array.from(page.querySelectorAll('PageContents > Shapes > Shape'))) {
      expect(value(shape, 'PinY') - value(shape, 'Height') / 2).toBeGreaterThan(0)
      expect(value(shape, 'PinY')).toBeLessThan(pageSettings.PageHeight)
    }
    const environment = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }
    if (environment.process?.env.WRITE_SAMPLE_IBAN === '1') {
      const fsModule = 'node:fs/promises'
      const pathModule = 'node:path'
      const { writeFile } = await import(fsModule) as { writeFile: (path: string, bytes: Uint8Array) => Promise<void> }
      const { resolve } = await import(pathModule) as { resolve: (...paths: string[]) => string }
      await writeFile(resolve((import.meta as ImportMeta & { dirname: string }).dirname, '../../samples/IBANVerification.vsdx'), bytes)
    }
  })

  it('drives self-message heads through the native User.IsAsync rule so the Asynchronous action still toggles them', async () => {
    const model = await parseSequence(`sequenceDiagram
A->>A: filled
A-)A: open
A-->>A: dashed
A--)A: dashed open
A-xA: cross`)
    const { named, value, rowValue } = await loadPage(await generateVsdx(model))
    const isAsync = (name: string) => rowValue(named(name), 'User', 'IsAsync', 'Value', 'N')
    for (const [name, async, head, dashed] of [['Message.1', 0, 4, 1], ['Message.2', 1, 3, 1], ['Message.3', 1, 3, 2], ['Message.4', 1, 3, 2]] as const) {
      const shape = named(name)
      expect(isAsync(name), name).toBe(async)
      expect(value(shape, 'EndArrow'), name).toBe(head)
      expect(directCells(shape, 'EndArrow')?.getAttribute('F') ?? 'Inh', name).toBe('Inh')
      expect(value(shape, 'LinePattern'), name).toBe(dashed)
      expect(rowValue(shape, 'Actions', 'Async', 'Checked', 'N'), name).toBe(async)
      expect(rowValue(shape, 'User', 'IsSelfMessage', 'Value', 'N'), name).toBe(1)
      expect(shape.querySelector('Section[N="User"] Row[N="IsReturn"]'), name).toBeNull()
    }
    expect(directCells(named('Message.5'), 'EndArrow')!.getAttribute('F')).toBe('GUARD(0)')
  })

  it('caches the first operand\'s hidden divider from its native LISTORDER rule', async () => {
    const { named } = await loadPage(await generateVsdx(await parseSequence(SAMPLE_CODE)))
    const noShow = (name: string) => named(name).querySelector('Section[N="Geometry"] > Cell[N="NoShow"]')
    expect(noShow('Operand.1.1')!.getAttribute('V')).toBe('1')
    expect(noShow('Operand.1.1')!.getAttribute('F')).toBe('Inh')
    expect(noShow('Operand.1.2')).toBeNull()
  })

  it('stacks nested self activations on the parent bar edge and keeps self labels beside the loop', async () => {
    const model = await parseSequence(`sequenceDiagram
activate A
A->>A: ${'wrapped self message '.repeat(15)}
alt next stage
A->>+A: nested self call
A-->>-A: nested self return
end
deactivate A`)
    const { page, value, named } = await loadPage(await generateVsdx(model))
    const nested = named(`Activation.${model.activations.findIndex((activation) => activation.depth === 1) + 1}`)
    const parent = named('Activation.1')
    expect(value(nested, 'EndY')).toBeCloseTo(value(named('Message.2'), 'EndY'), 10)
    expect(value(nested, 'BeginY')).toBeCloseTo(value(named('Message.3'), 'EndY'), 10)
    expect(value(nested, 'PinX') - value(parent, 'PinX')).toBeCloseTo(referenceTheme.activationWidth / 2, 10)
    for (const connect of Array.from(page.querySelectorAll(`Connect[FromSheet="${nested.getAttribute('ID')}"]`))) expect(connect.getAttribute('ToSheet')).toBe(parent.getAttribute('ID'))
    for (const name of ['Message.1', 'Message.2', 'Message.3']) {
      const loop = named(name)
      expect(loop.getAttribute('Master')).toBe(String(MASTER.SelfMessage))
      const textLeft = value(loop, 'BeginX') - value(loop, 'LocPinX') + value(loop, 'TxtPinX') - value(loop, 'TxtLocPinX')
      expect(textLeft).toBeCloseTo(value(loop, 'BeginX') + referenceTheme.selfLoopWidth, 10)
      expect(value(loop, 'PinY') - value(loop, 'LocPinY') + value(loop, 'TxtPinY')).toBeCloseTo((value(loop, 'BeginY') + value(loop, 'EndY')) / 2, 10)
      expect(value(loop, 'BeginY') - value(loop, 'EndY')).toBeCloseTo(2 * PITCH, 10)
    }
    const frame = named('Fragment.1')
    const loop = named('Message.1')
    expect(value(frame, 'PinY') + value(frame, 'Height') / 2).toBeLessThan((value(loop, 'BeginY') + value(loop, 'EndY')) / 2 - value(loop, 'TxtHeight') / 2)
  })

  it('maps loop, opt and par to native fragments with guards and operands', async () => {
    const model = await parseSequence(`sequenceDiagram
A->>B: start
loop every minute
A->>B: poll
end
opt has data
B-->>A: data
end
par first
A->>B: one
and second
A->>C: two
end`)
    const { named, value } = await loadPage(await generateVsdx(model))
    expect(named('Fragment.1').getAttribute('Master')).toBe(String(MASTER.Loop))
    expect(named('Fragment.2').getAttribute('Master')).toBe(String(MASTER.Optional))
    expect(named('Fragment.1').querySelector('Shapes > Shape[MasterShape="7"] Text')!.textContent).toBe('[every minute]')
    const par = named('Fragment.3')
    expect(par.getAttribute('Master')).toBe(String(MASTER.Alternative))
    expect(par.querySelector('Shapes > Shape[MasterShape="6"] Text')!.textContent).toBe('par')
    expect(named('Operand.3.2').querySelector('Text')!.textContent).toBe('[second]')
    expect(value(named('Fragment.1'), 'PinY')).toBeGreaterThan(value(named('Fragment.2'), 'PinY'))
  })

  it('uses the real Parallel theme and the selected fixed page settings', async () => {
    const { zip } = await loadPage(await generateVsdx(await parseSequence(SAMPLE_CODE)))
    const theme = await zip.file('visio/theme/theme1.xml')!.async('string')
    expect(theme).toContain('name="Parallel"')
    expect(theme).toContain('schemeEnum="40"')
    const pages = await documentIn(zip, 'visio/pages/pages.xml')
    const sheet = pages.querySelector('PageSheet')!
    for (const [name, expected] of Object.entries(pageSettings)) expect(Number(directCells(sheet, name)!.getAttribute('V')), name).toBeCloseTo(expected, 10)
    expect(sheet.querySelector('Section[N="User"] Row[N="msvThemeOrder"] Cell[N="Value"]')!.getAttribute('V')).toBe('0')
    const layer = sheet.querySelector('Section[N="Layer"] Row[IX="0"]')!
    for (const [name, expected] of Object.entries(connectorLayer)) expect(layer.querySelector(`Cell[N="${name}"]`)!.getAttribute('V')).toBe(String(expected))
    expect(referenceTheme.font).toBe('Calibri')
  })

  it('does not infer activations and rejects layouts beyond the native page', async () => {
    const { page } = await loadPage(await generateVsdx(await parseSequence('sequenceDiagram\nA->>B: request\nB-->>A: reply')))
    expect(page.querySelector('Shape[Master="16"]')).toBeNull()
    await expect(generateVsdx(await parseSequence('sequenceDiagram\n' + 'A->>B: another request\n'.repeat(150)))).rejects.toThrow(/too tall.*Split/)
    await expect(generateVsdx(await parseSequence('sequenceDiagram\nactivate A\n' + 'A->>B: request\n'.repeat(97) + 'deactivate A'))).rejects.toThrow(/too tall.*Split/)
    const many = await parseSequence('sequenceDiagram\n' + Array.from({ length: 20 }, (_, index) => `participant P${index}`).join('\n') + '\nP0->>P19: wide')
    await expect(generateVsdx(many)).rejects.toThrow(/Too many participants/)
  })

  it.each([
    ['Validation failed', '#EE0000'], ['Validation succeeded', '#00B050'], ['not exists', '#EE0000'],
    ['exists', '#00B050'], ['On Success', '#00B050'], ['failure then succeeded', '#000000'],
    ['GetErrorCode', '#000000'], ['unsuccessful', '#000000'], ['Other branch', '#000000'],
  ])('colors only explicit whole-word outcomes: %s', (label, color) => {
    expect(semanticColor(label)).toBe(color)
  })

  it('writes valid OPC parts whose relationships, content types and sheet references resolve', async () => {
    const model = await parseSequence(SAMPLE_CODE)
    const bytes = await generateVsdx(model, 'CreateBillRequest & <test>')
    const { zip, page, value } = await loadPage(bytes)
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
    expect(files.every((name) => /\.(?:xml|rels)$/.test(name))).toBe(true)
    const docs = new Map<string, Document>()
    for (const name of files) docs.set(name, await documentIn(zip, name))
    const types = docs.get('[Content_Types].xml')!
    for (const name of files.filter((entry) => !entry.endsWith('.rels') && entry !== '[Content_Types].xml')) {
      expect(Array.from(types.getElementsByTagName('Override')).some((element) => element.getAttribute('PartName') === `/${name}`), name).toBe(true)
    }
    for (const [name, doc] of docs) {
      if (!name.endsWith('.rels')) continue
      const base = name === '_rels/.rels' ? '' : name.substring(0, name.indexOf('_rels/'))
      for (const relationship of Array.from(doc.getElementsByTagName('Relationship'))) {
        const target = new URL(relationship.getAttribute('Target')!, `https://package/${base}`).pathname.slice(1)
        expect(zip.file(target), `${name} -> ${target}`).not.toBeNull()
      }
    }
    const pageMasters = Array.from(docs.get('visio/pages/_rels/page1.xml.rels')!.getElementsByTagName('Relationship')).map((relationship) => relationship.getAttribute('Target'))
    const used = new Set(Array.from(page.querySelectorAll('Shape[Master]')).map((shape) => nativeTemplate.masters.find((master) => String(master.id) === shape.getAttribute('Master'))!.file))
    expect(new Set(pageMasters)).toEqual(new Set([...used].map((file) => `../masters/${file}`)))
    expect(docs.get('visio/pages/pages.xml')!.querySelector('Page')!.getAttribute('NameU')).toBe('CreateBillRequest & <test>')
    const shapes = Array.from(page.getElementsByTagName('Shape'))
    const ids = new Set(shapes.map((shape) => shape.getAttribute('ID')))
    expect(ids.size).toBe(shapes.length)
    for (const shape of shapes) for (const entry of Array.from(shape.querySelectorAll(':scope > Cell[F]'))) {
      for (const match of entry.getAttribute('F')!.matchAll(/Sheet\.(\d+)!/g)) expect(ids.has(match[1])).toBe(true)
    }
    const messages = shapes.filter((shape) => shape.getAttribute('NameU')?.startsWith('Message.'))
    expect(messages).toHaveLength(21)
    expect(messages[7].querySelector('Text')!.textContent).toContain('\nStatus = Received')
    for (const shape of shapes.filter((entry) => entry.parentElement?.parentElement?.localName === 'PageContents')) {
      expect(value(shape, 'PinX')).toBeGreaterThan(0)
      expect(value(shape, 'PinX')).toBeLessThan(pageSettings.PageWidth)
      expect(value(shape, 'PinY')).toBeGreaterThan(0)
      expect(value(shape, 'PinY')).toBeLessThan(pageSettings.PageHeight)
    }
    const environment = globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }
    if (environment.process?.env.WRITE_SAMPLE === '1') {
      const fsModule = 'node:fs/promises'
      const pathModule = 'node:path'
      const { mkdir, writeFile } = await import(fsModule) as {
        mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>
        writeFile: (path: string, bytes: Uint8Array) => Promise<void>
      }
      const { resolve } = await import(pathModule) as { resolve: (...paths: string[]) => string }
      const directory = resolve((import.meta as ImportMeta & { dirname: string }).dirname, '../../samples')
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, 'CreateBillRequest.vsdx'), await generateVsdx(model, 'CreateBillRequest'))
    }
  })

  it('exports notes, open/cross arrows and escaped editable text', async () => {
    const model = await parseSequence(`sequenceDiagram
A-)B: A & B
activate B
Note over A,B: first<br/>second
B--xA: failed
deactivate B`)
    const { named, value } = await loadPage(await generateVsdx(model))
    expect(named('Note.1').querySelector('Text')!.textContent).toBe('first\nsecond')
    expect(named('Activation.1').getAttribute('Master')).toBe('16')
    expect(named('Message.1').getAttribute('Master')).toBe(String(MASTER.Async))
    expect(value(named('Message.1'), 'EndArrow')).toBe(3)
    expect(value(named('Message.2'), 'EndArrow')).toBe(0)
    expect(named('Cross.2')).not.toBeNull()
    expect(named('Message.1').querySelector('Text')!.textContent).toBe('A & B')
  })

  it('rejects invalid exported references and out-of-range event positions', async () => {
    const model = await parseSequence('sequenceDiagram\nA->>B: hi')
    model.messages[0].to = 'missing'
    await expect(generateVsdx(model)).rejects.toThrow(/reference/)
    model.messages[0].to = 'B'
    model.messages[0].step = -1
    await expect(generateVsdx(model)).rejects.toThrow(/position/)
  })
})
