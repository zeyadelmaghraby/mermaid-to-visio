import { test as base, expect, type Page, type TestInfo } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ER_SAMPLE_CODE, SAMPLE_CODE } from '../src/sample'
import { referenceTheme } from '../src/converter/theme'

const sourceName = 'Mermaid diagram source'
const imageName = 'Prepared Mermaid diagram'
const sampleCounts = '7 participants / 21 messages / 2 frames'

type VisioCell = { '@_N': string; '@_V': string | number }
type VisioShape = {
  '@_ID': string
  '@_NameU': string
  Cell: VisioCell[]
  Section: unknown
  Text?: unknown
}

function assertFill(shape: VisioShape, color: string) {
  const fill = String(shape.Cell.find((cell) => cell['@_N'] === 'FillForegnd')?.['@_V'])
  expect(fill.toUpperCase(), `${shape['@_NameU']} uses the reference theme fill`).toBe(color.toUpperCase())
}

async function assertFixedPage(zip: JSZip) {
  const pagesXML = await zip.file('visio/pages/pages.xml')!.async('string')
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(pagesXML)
  const cells = parsed.Pages.Page.PageSheet.Cell as VisioCell[]
  expect(Number(cells.find((cell) => cell['@_N'] === 'PageWidth')?.['@_V'])).toBeCloseTo(21.5, 6)
  expect(Number(cells.find((cell) => cell['@_N'] === 'PageHeight')?.['@_V'])).toBeCloseTo(24.5, 6)
}

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`)
    })
    await use(errors)
    await testInfo.attach('browser-errors', {
      body: JSON.stringify(errors, null, 2), contentType: 'application/json',
    })
    expect(errors, 'No browser exceptions or console errors, including invalid-input cases').toEqual([])
  }, { auto: true }],
})

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Preview ready')
  await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeEnabled()
}

async function assertRenderedImage(page: Page) {
  const image = page.getByRole('img', { name: imageName })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
    element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)).toBe(true)
  const pixels = await image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = element.naturalWidth
    canvas.height = element.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    let darkPixels = 0
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] > 0 && Math.min(data[offset], data[offset + 1], data[offset + 2]) < 160) darkPixels += 1
    }
    const bounds = element.getBoundingClientRect()
    return { width: element.naturalWidth, height: element.naturalHeight,
      renderedWidth: bounds.width, renderedHeight: bounds.height, darkPixels }
  })
  expect(pixels.width).toBeGreaterThan(100)
  expect(pixels.height).toBeGreaterThan(100)
  expect(pixels.renderedWidth).toBeGreaterThan(0)
  expect(pixels.renderedHeight).toBeGreaterThan(0)
  expect(pixels.darkPixels, 'Diagram image contains actual rendered ink, not an empty canvas').toBeGreaterThan(100)
  return pixels
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path, fullPage: true, animations: 'disabled' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
  const imagePath = testInfo.outputPath(name.replace('.png', '-diagram.png'))
  await page.getByRole('img', { name: imageName }).screenshot({ path: imagePath })
  await testInfo.attach('diagram-image', { path: imagePath, contentType: 'image/png' })
}

async function assertLayout(page: Page) {
  const measurements = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const failures: string[] = []
    for (const button of document.querySelectorAll('button')) {
      const bounds = button.getBoundingClientRect()
      if (!bounds.width || !bounds.height) continue
      if (bounds.left < -1 || bounds.right > viewportWidth + 1) failures.push(`Offscreen button: ${button.ariaLabel || button.textContent}`)
      if (button.scrollWidth > button.clientWidth || button.scrollHeight > button.clientHeight) {
        failures.push(`Clipped button: ${button.ariaLabel || button.textContent}`)
      }
      for (const node of button.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const textBounds of range.getClientRects()) {
          if (textBounds.left < bounds.left || textBounds.right > bounds.right
            || textBounds.top < bounds.top || textBounds.bottom > bounds.bottom) {
            failures.push(`Text outside button: ${node.textContent}`)
          }
        }
      }
    }
    return { viewportWidth, pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), failures }
  })
  expect(measurements.pageWidth, 'No horizontal page overflow').toBeLessThanOrEqual(measurements.viewportWidth)
  expect(measurements.failures, 'Visible controls and their text fit their boxes').toEqual([])
}

type GateWindow = Window & {
  e2eGate?: { phase: 'prepare' | 'export'; entered: boolean; released: boolean; release?: () => void }
}

async function installCompletionGate(page: Page) {
  await page.route('**/src/converter/index.ts*', async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: `
      import { prepareDiagram as realPrepare, generateVsdx as realGenerate } from '/src/converter/diagram.ts';
      export { detectKind } from '/src/converter/diagram.ts';
      export { parseSequence } from '/src/converter/sequence.ts';
      export { parseEr } from '/src/converter/er.ts';
      export { generateErx } from '/src/converter/erx.ts';
      async function hold(phase, result) {
        const gate = window.e2eGate;
        if (gate?.phase === phase) {
          gate.entered = true;
          await new Promise(resolve => { gate.release = resolve; });
          gate.released = true;
        }
        return result;
      }
      export async function prepareDiagram(...args) { return hold('prepare', await realPrepare(...args)); }
      export async function generateVsdx(...args) { return hold('export', await realGenerate(...args)); }
    ` })
  })
}

async function armGate(page: Page, phase: 'prepare' | 'export') {
  await page.evaluate((value) => {
    (window as GateWindow).e2eGate = { phase: value, entered: false, released: false }
  }, phase)
}

async function releaseGate(page: Page) {
  await page.evaluate(() => (window as GateWindow).e2eGate!.release!())
  await page.waitForFunction(() => (window as GateWindow).e2eGate?.released === true)
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
}

test('ER sample renders and downloads native Database Model Diagram entities glued by relationships', async ({ page }, testInfo) => {
  await ready(page)
  await page.getByRole('button', { name: 'Load ER sample', exact: true }).click()
  await expect(page.getByRole('textbox', { name: sourceName })).toHaveValue(ER_SAMPLE_CODE)
  await expect(page.getByText('Mermaid / ER', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Preview ready')
  await expect(page.getByText('8 tables / 1 views / 8 relationships', { exact: true })).toBeVisible()
  await expect(page.getByText('ER diagram', { exact: true })).toBeVisible()
  await assertRenderedImage(page)
  await assertLayout(page)
  await screenshot(page, testInfo, 'er-desktop-1440.png')

  const visioEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download Visio', exact: true }).click()
  const visio = await visioEvent
  expect(visio.suggestedFilename()).toBe('SalesERD.vsdx')
  const artifact = resolve('test-results', 'SalesERD.vsdx')
  await mkdir(resolve('test-results'), { recursive: true })
  await visio.saveAs(artifact)
  await expect(page.getByRole('status')).toHaveText('Visio file downloaded')
  await testInfo.attach('native-erd-download', { path: artifact, contentType: 'application/vnd.ms-visio.drawing' })

  const zip = await JSZip.loadAsync(await readFile(artifact))
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  expect(files.every((name) => /\.(?:xml|rels)$/.test(name)), 'No embedded model, image or media parts').toBe(true)
  for (const name of files) expect(XMLValidator.validate(await zip.file(name)!.async('string')), name).toBe(true)
  const manifest = JSON.parse(await readFile(resolve('src/converter/native-erd/manifest.json'), 'utf8')) as { masters: { id: number; nameU: string; file: string }[] }
  for (const master of manifest.masters) {
    expect(await zip.file(`visio/masters/${master.file}`)?.async('string'), `${master.nameU} master part is the original asset`)
      .toBe(await readFile(resolve('src/converter/native-erd', master.file), 'utf8'))
  }
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(await zip.file('visio/pages/page1.xml')!.async('string'))
  const shapes = parsed.PageContents.Shapes.Shape as (VisioShape & { '@_Master': string })[]
  const id = (nameU: string) => String(manifest.masters.find((master) => master.nameU === nameU)!.id)
  expect(shapes.filter((shape) => shape['@_Master'] === id('Entity'))).toHaveLength(8)
  expect(shapes.filter((shape) => shape['@_Master'] === id('View'))).toHaveLength(1)
  const relationships = shapes.filter((shape) => shape['@_Master'] === id('Relationship'))
  expect(relationships).toHaveLength(8)
  const connects = parsed.PageContents.Connects.Connect as { '@_FromSheet': string; '@_ToSheet': string; '@_FromCell': string }[]
  expect(connects).toHaveLength(16)
  for (const relationship of relationships) {
    const ends = connects.filter((connect) => connect['@_FromSheet'] === relationship['@_ID'])
    expect(ends.map((connect) => connect['@_FromCell']).sort()).toEqual(['BeginX', 'EndX'])
    for (const end of ends) expect(['11', '12']).toContain(shapes.find((shape) => shape['@_ID'] === end['@_ToSheet'])?.['@_Master'])
  }

  const erxEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download ERX', exact: true }).click()
  const erx = await erxEvent
  expect(erx.suggestedFilename()).toBe('SalesERD.erx')
  const erxPath = resolve('test-results', 'SalesERD.erx')
  await erx.saveAs(erxPath)
  await expect(page.getByRole('status')).toHaveText('Database model downloaded: in Visio, Database > Import > ERwin ERX')
  await expect(page.getByRole('list', { name: 'Export notes' })).toContainText('sales.Customer_Order_Summary_View')
  const model = (await readFile(erxPath, 'latin1')).split('\r\n')
  expect(model[0]).toBe('/* PLATINUM ERwin/ERX 3.5 */')
  expect(model.filter((line) => /^\d+,"ET_(?:IE|DE)",0,/.test(line))).toHaveLength(8)
  await assertLayout(page)
})

test('billing actor and explicit activations render and download a themed native Visio package and original source', async ({ page }, testInfo) => {
  await ready(page)
  await expect(page.getByText(sampleCounts, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: sourceName })).toHaveValue(SAMPLE_CODE)
  const dimensions = await assertRenderedImage(page)
  await testInfo.attach('preview-dimensions', { body: JSON.stringify(dimensions), contentType: 'application/json' })
  const previewStyles = await page.getByRole('img', { name: imageName }).evaluate((element: HTMLImageElement) => {
    const svg = decodeURIComponent(element.src.substring(element.src.indexOf(',') + 1))
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    return parsed.querySelector('style')?.textContent ?? ''
  })
  expect(previewStyles).toContain('.messageLine0')
  expect(previewStyles).toContain('.loopLine')
  expect(previewStyles).not.toMatch(/@(?:import|font-face|keyframes)/)
  await assertLayout(page)
  await screenshot(page, testInfo, 'desktop-1440.png')

  const visioEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download Visio', exact: true }).click()
  const visio = await visioEvent
  expect(visio.suggestedFilename()).toBe('CreateBillRequest.vsdx')
  const artifact = resolve('test-results', 'CreateBillRequest.vsdx')
  await mkdir(resolve('test-results'), { recursive: true })
  await visio.saveAs(artifact)
  expect(await visio.failure()).toBeNull()
  await expect(page.getByRole('status')).toHaveText('Visio file downloaded')
  await testInfo.attach('native-visio-download', { path: artifact, contentType: 'application/vnd.ms-visio.drawing' })

  const zip = await JSZip.loadAsync(await readFile(artifact))
  await assertFixedPage(zip)
  const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  expect(files.length).toBeGreaterThan(0)
  expect(files.every((name) => /\.(?:xml|rels)$/.test(name)), 'No embedded SVG, image or media parts').toBe(true)
  expect(files.filter((name) => /(?:^|\/)media\/|\.(?:svg|png|jpe?g|gif|emf|wmf)$/i.test(name))).toEqual([])
  for (const name of files) expect(XMLValidator.validate(await zip.file(name)!.async('string')), name).toBe(true)
  const pageXML = await zip.file('visio/pages/page1.xml')!.async('string')
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(pageXML)
  const shapes = parsed.PageContents.Shapes.Shape as VisioShape[]
  const connects = parsed.PageContents.Connects.Connect as { '@_FromSheet': string; '@_ToSheet': string; '@_FromCell': string }[]
  const manifest = JSON.parse(await readFile(resolve('src/converter/native/manifest.json'), 'utf8')) as { masters: { id: number; nameU: string; file: string }[] }
  expect(manifest.masters).toHaveLength(12)
  for (const master of manifest.masters) {
    expect(await zip.file(`visio/masters/${master.file}`)?.async('string'), `${master.nameU} master part is the original asset`)
      .toBe(await readFile(resolve('src/converter/native', master.file), 'utf8'))
  }
  const mastersXML = await zip.file('visio/masters/masters.xml')!.async('string')
  for (const uid of ['{13080A10-0005-0000-8E40-00608CF305B2}', '{12FCED47-0004-0000-8E40-00608CF305B2}', '{43BFE53B-000B-0000-8E40-00608CF305B2}',
    '{0ABB4EBA-000D-0000-8E40-00608CF305B2}', '{1F71E100-0006-0000-8E40-00608CF305B2}', '{08E63976-0008-0000-8E40-00608CF305B2}',
    '{08E3E0B1-0009-0000-8E40-00608CF305B2}', '{04892A1E-000E-0000-8E40-00608CF305B2}', '{43C124C0-000C-0000-8E40-00608CF305B2}',
    '{1F71E313-000A-0000-8E40-00608CF305B2}', '{1F71E19C-0007-0000-8E40-00608CF305B2}', '{022179E8-0002-0000-8E40-00608CF305B2}']) expect(mastersXML).toContain(`UniqueID='${uid}'`)
  const masterId = (nameU: string) => String(manifest.masters.find((master) => master.nameU === nameU)!.id)
  const byMaster = (nameU: string) => shapes.filter((shape) => shape['@_Master'] === masterId(nameU))
  expect(shapes.every((shape) => shape['@_Master']), 'Every top-level shape is a native master instance').toBe(true)
  expect(byMaster('Actor lifeline').map((shape) => shape['@_NameU'])).toEqual(['Lifeline.Source'])
  expect(byMaster('Object lifeline')).toHaveLength(6)
  const activations = byMaster('Activation')
  expect(activations.map((shape) => shape['@_NameU'])).toEqual(Array.from({ length: 7 }, (_, index) => `Activation.${index + 1}`))
  const messages = [...byMaster('Message'), ...byMaster('Self Message'), ...byMaster('Return Message'), ...byMaster('Asynchronous Message')]
  expect(messages).toHaveLength(21)
  expect(byMaster('Alternative fragment')).toHaveLength(2)
  expect(byMaster('Interaction operand')).toHaveLength(4)
  expect(connects).toHaveLength(2 * (messages.length + activations.length))
  expect(pageXML).not.toMatch(/ForeignData|ForeignType|<svg\b/i)
  for (const activation of activations) {
    assertFill(activation, referenceTheme.activationFill)
    for (const endpoint of ['BeginX', 'BeginY', 'EndX', 'EndY']) {
      expect(activation.Cell.some((entry) => entry['@_N'] === endpoint), `Activation has editable ${endpoint}`).toBe(true)
    }
  }
  for (const sheet of [...messages, ...activations]) {
    const endpoints = connects.filter((connection) => connection['@_FromSheet'] === sheet['@_ID'])
    expect(endpoints.map((connection) => connection['@_FromCell']).sort(), sheet['@_NameU']).toEqual(['BeginX', 'EndX'])
    for (const endpoint of endpoints) {
      expect(shapes.find((shape) => shape['@_ID'] === endpoint['@_ToSheet'])?.['@_NameU']).toMatch(/^(?:Lifeline|Activation)\./)
    }
  }

  const originalSource = await page.getByRole('textbox', { name: sourceName }).inputValue()
  const sourceEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download source', exact: true }).click()
  const sourceDownload = await sourceEvent
  expect(sourceDownload.suggestedFilename()).toBe('CreateBillRequest.mmd')
  const sourcePath = testInfo.outputPath('CreateBillRequest.mmd')
  await sourceDownload.saveAs(sourcePath)
  expect(await sourceDownload.failure()).toBeNull()
  expect(await readFile(sourcePath, 'utf8')).toBe(originalSource)
  await testInfo.attach('source-download', { path: sourcePath, contentType: 'text/plain' })
})

test('long IBAN verification activations download with instance-extended native points', async ({ page }) => {
  // Exact user fixture shared with the unit test (read as text, not imported).
  const source = /const IBAN_CODE = `([^`]*)`/.exec(await readFile(resolve('src/converter/vsdx.test.ts'), 'utf8'))![1]
  await ready(page)
  await page.getByRole('textbox', { name: sourceName }).fill(source)
  await page.getByLabel('Diagram name').fill('IBANVerification')
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Preview ready')
  await expect(page.getByText('7 participants / 22 messages / 2 frames', { exact: true })).toBeVisible()
  await assertRenderedImage(page)
  const visioEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download Visio', exact: true }).click()
  const visio = await visioEvent
  expect(visio.suggestedFilename()).toBe('IBANVerification.vsdx')
  const artifact = resolve('test-results', 'IBANVerification.vsdx')
  await mkdir(resolve('test-results'), { recursive: true })
  await visio.saveAs(artifact)
  expect(await visio.failure()).toBeNull()
  await expect(page.getByRole('status')).toHaveText('Visio file downloaded')
  const zip = await JSZip.loadAsync(await readFile(artifact))
  await assertFixedPage(zip)
  const manifest = JSON.parse(await readFile(resolve('src/converter/native/manifest.json'), 'utf8')) as { masters: { id: number; file: string }[] }
  for (const master of manifest.masters) {
    expect(await zip.file(`visio/masters/${master.file}`)?.async('string')).toBe(await readFile(resolve('src/converter/native', master.file), 'utf8'))
  }
  const parsed = new XMLParser({ ignoreAttributes: false, isArray: (name) => ['Shape', 'Section', 'Row', 'Connect'].includes(name) })
    .parse(await zip.file('visio/pages/page1.xml')!.async('string'))
  const shapes = parsed.PageContents.Shapes.Shape as (VisioShape & { '@_Master': string; Section?: { '@_N': string; Row?: { '@_IX': string }[] }[] })[]
  const connects = parsed.PageContents.Connects.Connect as { '@_ToSheet': string; '@_ToPart': string }[]
  const bars = shapes.filter((shape) => shape['@_NameU'].startsWith('Activation.'))
  expect(bars).toHaveLength(7)
  expect(connects).toHaveLength(2 * (22 + 7))
  const width = (shape: VisioShape) => Number(shape.Cell.find((cell) => cell['@_N'] === 'Width')!['@_V'])
  expect(width(bars[0])).toBeGreaterThan(12.25)
  const extended = connects.filter((connect) => Number(connect['@_ToPart']) >= 200)
  expect(extended.length).toBeGreaterThan(0)
  for (const connect of extended) {
    const bar = bars.find((shape) => shape['@_ID'] === connect['@_ToSheet'])!
    const rows = bar.Section!.find((section) => section['@_N'] === 'Connection')!.Row!
    expect(rows.some((row) => Number(row['@_IX']) === Number(connect['@_ToPart']) - 100)).toBe(true)
  }
})

for (const scenario of [
  { name: 'flowchart', source: 'flowchart TD\nA-->B', error: /Only sequenceDiagram and erDiagram are supported\./ },
  { name: 'invalid Mermaid', source: 'sequenceDiagram\nA->>B', error: /Parse error|Expecting|Lexical error/i },
  { name: 'unsupported box', source: 'sequenceDiagram\nbox Group\nparticipant A\nparticipant B\nend\nA->>B: hello', error: /Box.*unsupported\./i },
]) {
  test(`${scenario.name} reports an explicit error and disables export`, async ({ page }) => {
    await ready(page)
    await page.getByRole('textbox', { name: sourceName }).fill(scenario.source)
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(scenario.error)
    await expect(page.getByRole('status')).toHaveText('Action required')
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
    await expect(page.getByRole('img', { name: imageName })).toHaveCount(0)
    await page.getByRole('button', { name: 'Load billing sample', exact: true }).click()
    await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Preview ready')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeEnabled()
  })
}

test('imports .mmd sample and rejects invalid extensions and oversized files', async ({ page }) => {
  await ready(page)
  const input = page.getByLabel('Import source file', { exact: true })
  const source = page.getByRole('textbox', { name: sourceName })
  await source.fill('sequenceDiagram\nA->>B: replaced')
  await input.setInputFiles({ name: 'ImportedBilling.mmd', mimeType: 'text/plain', buffer: Buffer.from(SAMPLE_CODE) })
  await expect(source).toHaveValue(SAMPLE_CODE)
  await expect(page.getByRole('textbox', { name: 'Diagram name' })).toHaveValue('ImportedBilling')
  await expect(page.getByRole('status')).toHaveText('Source imported')
  await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Preview ready')
  await expect(page.getByText(sampleCounts, { exact: true })).toBeVisible()
  await assertRenderedImage(page)

  for (const invalid of [
    { name: 'rejected.svg', buffer: Buffer.from(SAMPLE_CODE), error: 'Choose a .mmd or .txt file.' },
    { name: 'oversized.mmd', buffer: Buffer.alloc(100_001, 'a'), error: 'The file exceeds the 100 KB import limit.' },
  ]) {
    await input.setInputFiles({ name: invalid.name, mimeType: 'text/plain', buffer: invalid.buffer })
    await expect(page.getByRole('alert')).toHaveText(invalid.error)
    await expect(source).toHaveValue(SAMPLE_CODE)
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
  }
})

for (const phase of ['prepare', 'export'] as const) {
  test(`editing source during ${phase} prevents stale output`, async ({ page }, testInfo) => {
    await installCompletionGate(page)
    await ready(page)
    const downloads: string[] = []
    page.on('download', (download) => downloads.push(download.suggestedFilename()))
    await armGate(page, phase)
    await page.getByRole('button', { name: phase === 'prepare' ? 'Prepare preview' : 'Download Visio', exact: true }).click()
    await page.waitForFunction(() => (window as GateWindow).e2eGate?.entered === true)
    await expect(page.getByRole('status')).toHaveText(phase === 'prepare' ? 'Preparing preview' : 'Generating Visio file')
    await page.getByRole('textbox', { name: sourceName }).fill('sequenceDiagram\nA->>B: newer source')
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
    await releaseGate(page)
    await expect(page.getByRole('status')).toHaveText('Changes not prepared')
    await expect(page.getByRole('img', { name: imageName })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Download Visio', exact: true })).toBeDisabled()
    expect(downloads, 'The canceled operation must not trigger a browser download').toEqual([])
    await page.evaluate(() => { delete (window as GateWindow).e2eGate })
    await page.getByRole('button', { name: 'Prepare preview', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Preview ready')
    await expect(page.getByText('2 participants / 1 messages / 0 frames', { exact: true })).toBeVisible()
    const currentDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download Visio', exact: true }).click()
    const download = await currentDownload
    expect(await download.failure()).toBeNull()
    const path = testInfo.outputPath(`unmarked-${phase}.vsdx`)
    await download.saveAs(path)
    const zip = await JSZip.loadAsync(await readFile(path))
    await assertFixedPage(zip)
    const pageXML = await zip.file('visio/pages/page1.xml')!.async('string')
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(pageXML)
    const shapes = parsed.PageContents.Shapes.Shape as VisioShape[]
    expect(shapes.filter((shape) => /^Activation\./.test(shape['@_NameU'])), 'Unmarked messages must not infer activation lifetimes').toHaveLength(0)
    expect(downloads).toEqual(['CreateBillRequest.vsdx'])
  })
}

for (const width of [320, 390]) {
  test(`mobile ${width}px tabs, image and controls fit without page overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 })
    await ready(page)
    const editorTab = page.getByRole('tab', { name: 'Editor', exact: true })
    const previewTab = page.getByRole('tab', { name: 'Preview', exact: true })
    await expect(editorTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'Source editor', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Diagram preview', exact: true })).toBeHidden()
    await assertLayout(page)
    await previewTab.click()
    await expect(previewTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: 'Source editor', exact: true })).toBeHidden()
    await expect(page.getByText(sampleCounts, { exact: true })).toBeVisible()
    await assertRenderedImage(page)
    await assertLayout(page)
    await screenshot(page, testInfo, `mobile-${width}.png`)
    await previewTab.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(editorTab).toBeFocused()
    await expect(editorTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: sourceName })).toHaveValue(SAMPLE_CODE)
    await page.keyboard.press('End')
    await expect(previewTab).toBeFocused()
    await expect(previewTab).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await assertLayout(page)
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Fit diagram', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await assertLayout(page)
  })
}