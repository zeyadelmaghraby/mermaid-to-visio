// Derives the generic Database Model Diagram template assets (stencil masters, styles, page settings)
// from the read-only reference ERD. Customer pages, the add-on's embedded model (Database Model master
// and its OLE object), docProps and thumbnail are never read out.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const EXPECTED_SHA256 = 'A0FD84EBB3C1E3E3FD273D5E28BD1041E29B9CED297E97D3B186CBEDD87FAD6D'
// Stencil masters of the Entity Relationship stencil. Excluded: 8 Database Model (holds the add-on's model of
// the customer schema) and 1000+/1003+ (instance copies of View/Entity created on the reference page).
const STENCIL_MASTERS = new Map([[2, 'Tracking Text'], [4, 'Dynamic Connector'], [5, 'Optional'], [11, 'Entity'], [12, 'View'],
  [13, 'Relationship'], [14, 'Parent to category'], [15, 'Category to child']])
const source = process.argv[2]
if (!source) {
  console.error('Usage: node scripts/extract-erd-template.mjs <path/to/reference-erd.vsdx>')
  process.exit(2)
}
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/converter/native-erd')

const bytes = await readFile(source)
const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase()
if (digest !== EXPECTED_SHA256) throw new Error(`Reference hash mismatch: ${digest}`)
const zip = await JSZip.loadAsync(bytes)
const read = (name) => zip.file(name).async('string')

const mastersXml = await read('visio/masters/masters.xml')
const relsXml = await read('visio/masters/_rels/masters.xml.rels')
const relTargets = new Map([...relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="(master\d+\.xml)"|Target="(master\d+\.xml)"[^>]*Id="(rId\d+)"/g)]
  .map((match) => [match[1] ?? match[4], match[2] ?? match[3]]))
const elements = [...mastersXml.matchAll(/<Master ID='(\d+)' NameU='([^']+)'[\s\S]*?<Rel r:id='(rId\d+)'\/><\/Master>/g)]
const masters = elements.filter((match) => STENCIL_MASTERS.get(Number(match[1])) === match[2])
  .map((match) => ({ id: Number(match[1]), nameU: match[2], rel: match[3], file: relTargets.get(match[3]), element: match[0] }))
if (masters.length !== STENCIL_MASTERS.size || masters.some((master) => !master.file)) throw new Error('Unexpected master inventory.')
for (const master of masters) {
  if (zip.file(`visio/masters/_rels/${master.file}.rels`)) throw new Error(`Master ${master.nameU} must not carry relationships.`)
}
const header = mastersXml.slice(0, mastersXml.indexOf('<Master '))
const filteredMasters = `${header}${masters.map((master) => master.element).join('')}</Masters>`

let documentXml = await read('visio/document.xml')
documentXml = documentXml.replace(/TopPage='\d+'/, "TopPage='0'")
// The add-on's document-open hooks look for the excluded model; generated drawings stay free-form.
documentXml = documentXml.replace(/<EventList>[\s\S]*?<\/EventList>/, '')
if (/<DocumentProperties|<EventList|<SolutionXML/.test(documentXml)) throw new Error('Document properties, events and solution data must be stripped.')

// Page display settings of the database template (notation, layers), without the page's size, view or GUID.
const pagesXml = await read('visio/pages/pages.xml')
const pageSheet = pagesXml.match(/<PageSheet[^>]*>([\s\S]*?)<\/PageSheet>/)[1].replace(/<Trigger[\s\S]*?<\/Trigger>|<RefBy[^>]*\/>/g, '')
const cellsXml = pageSheet.replace(/<Section[\s\S]*?<\/Section>/g, '')
const page = {
  cells: Object.fromEntries([...cellsXml.matchAll(/<Cell N='(\w+)' V='([^']*)'(?: U='(\w+)')?\/>/g)]
    .filter((match) => !['PageWidth', 'PageHeight'].includes(match[1])).map((match) => [match[1], match[3] ? { V: match[2], U: match[3] } : { V: match[2] }])),
  user: pageSheet.match(/<Section N='User'>[\s\S]*?<\/Section>/)[0].replace(/<Cell N='Value' V='([^']*)'(?: U='(\w+)')?><\/Cell>/g, (_, value, unit) => `<Cell N='Value' V='${value}'${unit ? ` U='${unit}'` : ''}/>`),
  layers: pageSheet.match(/<Section N='Layer'>[\s\S]*?<\/Section>/)[0],
}

await mkdir(target, { recursive: true })
const manifest = { reference: EXPECTED_SHA256, masters: [], files: {} }
async function emit(name, content) {
  await writeFile(resolve(target, name), content, 'utf8')
  manifest.files[name] = createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase()
}
await emit('masters.xml', filteredMasters)
for (const master of masters) {
  await emit(master.file, await read(`visio/masters/${master.file}`))
  manifest.masters.push({ id: master.id, nameU: master.nameU, rel: master.rel, file: master.file })
}
await emit('document.xml', documentXml)
await emit('page.json', JSON.stringify(page, null, 2) + '\n')
await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`Wrote ${masters.length} masters, document and page settings to ${target}`)
