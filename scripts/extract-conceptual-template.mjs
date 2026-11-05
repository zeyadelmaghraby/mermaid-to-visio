// Derives the conceptual-diagram template assets (UML Class connector masters, Rectangle masters, styles,
// themes and page settings) from the read-only reference conceptual diagram. Its pages, docProps and any
// model text are never read out.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const EXPECTED_SHA256 = 'DFED5D95041F71B5D93050E437E22EF085A17166F9D431214EE7736CEE11E869'
// The masters the reference conceptual page uses: entities, the module boundary, the three UML Class connectors
// and the Composite line-end pattern that the Composition's diamond (USE("Composite")) refers to.
const MASTERS = new Map([[5, 'Composite'], [21, 'Rectangle'], [23, 'Rectangle.41'], [22, 'Composition.34'], [14, 'Association'], [3004, 'Directed Association']])
const source = process.argv[2]
if (!source) {
  console.error('Usage: node scripts/extract-conceptual-template.mjs <path/to/conceptual-diagram.vsdx>')
  process.exit(2)
}
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/converter/native-conceptual')

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
const masters = elements.filter((match) => MASTERS.get(Number(match[1])) === match[2])
  .map((match) => ({ id: Number(match[1]), nameU: match[2], rel: match[3], file: relTargets.get(match[3]), element: match[0] }))
if (masters.length !== MASTERS.size || masters.some((master) => !master.file)) throw new Error('Unexpected master inventory.')
for (const master of masters) if (zip.file(`visio/masters/_rels/${master.file}.rels`)) throw new Error(`Master ${master.nameU} must not carry relationships.`)
const header = mastersXml.slice(0, mastersXml.indexOf('<Master '))
const filteredMasters = `${header}${masters.map((master) => master.element).join('')}</Masters>`

// Keeps the UML Class solution's document events (QueueMarkerEvent), as the template's own drawings do.
let documentXml = await read('visio/document.xml')
documentXml = documentXml.replace(/TopPage='\d+'/, "TopPage='0'")
if (/<DocumentProperties|<SolutionXML/.test(documentXml)) throw new Error('Document properties and solution data must be stripped.')

// Theme parts with their document relationship ids.
const documentRels = await read('visio/_rels/document.xml.rels')
const themes = [...documentRels.matchAll(/Id="(rId\d+)"[^>]*relationships\/theme" Target="(theme\/theme\d+\.xml)"/g)].map((match) => ({ rel: match[1], file: match[2] }))
if (themes.length !== 2) throw new Error('Expected two theme parts.')

// Page settings of the conceptual page (theme indexes, layout and routing), without its size, view or GUID.
const pagesXml = await read('visio/pages/pages.xml')
const pageEntry = pagesXml.match(/<Page ID='\d+' NameU='Page-2'[\s\S]*?<\/Page>/)
if (!pageEntry) throw new Error('The conceptual page (Page-2) was not found.')
const pageSheet = pageEntry[0].match(/<PageSheet[^>]*>([\s\S]*?)<\/PageSheet>/)[1].replace(/<Trigger[\s\S]*?<\/Trigger>|<RefBy[^>]*\/>/g, '')
const cellsXml = pageSheet.replace(/<Section[\s\S]*?<\/Section>/g, '')
const page = {
  cells: Object.fromEntries([...cellsXml.matchAll(/<Cell N='(\w+)' V='([^']*)'(?: U='(\w+)')?(?: F='([^']*)')?\/>/g)]
    .filter((match) => !['PageWidth', 'PageHeight'].includes(match[1])).map((match) => [match[1], { V: match[2], ...(match[3] ? { U: match[3] } : {}), ...(match[4] ? { F: match[4] } : {}) }])),
  sections: [...pageSheet.matchAll(/<Section N='(User|Layer)'>[\s\S]*?<\/Section>/g)].map((match) => match[0]),
}

await mkdir(target, { recursive: true })
const manifest = { reference: EXPECTED_SHA256, masters: [], themes: [], files: {} }
async function emit(name, content) {
  await writeFile(resolve(target, name), content, 'utf8')
  manifest.files[name] = createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase()
}
await emit('masters.xml', filteredMasters)
for (const master of masters) {
  await emit(master.file, await read(`visio/masters/${master.file}`))
  manifest.masters.push({ id: master.id, nameU: master.nameU, rel: master.rel, file: master.file })
}
for (const theme of themes) {
  const name = theme.file.replace('theme/', '')
  await emit(name, await read(`visio/${theme.file}`))
  manifest.themes.push({ rel: theme.rel, file: name })
}
await emit('document.xml', documentXml)
await emit('page.json', JSON.stringify(page, null, 2) + '\n')
await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`Wrote ${masters.length} masters, ${themes.length} themes, document and page settings to ${target}`)
