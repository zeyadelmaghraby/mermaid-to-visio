// Derives the generic UML Sequence template assets (masters, styles, document settings)
// from the read-only reference VSDX. Customer pages, labels, docProps and thumbnail are never read out.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const EXPECTED_SHA256 = 'FA5366E43261593B23651B47C7B3E138CA0425B79F2A77BD0CA09313B9CF4FD7'
const source = process.argv[2]
if (!source) {
  console.error('Usage: node scripts/extract-native-template.mjs <path/to/reference.vsdx>')
  process.exit(2)
}
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/converter/native')

const bytes = await readFile(source)
const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase()
if (digest !== EXPECTED_SHA256) throw new Error(`Reference hash mismatch: ${digest}`)
const zip = await JSZip.loadAsync(bytes)
const read = (name) => zip.file(name).async('string')

const mastersXml = await read('visio/masters/masters.xml')
const relsXml = await read('visio/masters/_rels/masters.xml.rels')
const relTargets = new Map([...relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="(master\d+\.xml)"|Target="(master\d+\.xml)"[^>]*Id="(rId\d+)"/g)]
  .map((match) => [match[1] ?? match[4], match[2] ?? match[3]]))
const masters = [...mastersXml.matchAll(/<Master ID='(\d+)' NameU='([^']+)'[\s\S]*?<Rel r:id='(rId\d+)'\/>/g)]
  .map((match) => ({ id: Number(match[1]), nameU: match[2], rel: match[3], file: relTargets.get(match[3]) }))
if (masters.length !== 12 || masters.some((master) => !master.file)) throw new Error('Unexpected master inventory.')
if (zip.file(/^visio\/masters\/_rels\/master\d+\.xml\.rels$/).length) throw new Error('Masters must not carry external relationships.')

let documentXml = await read('visio/document.xml')
documentXml = documentXml.replace(/TopPage='\d+'/, "TopPage='0'")
if (/<DocumentProperties/.test(documentXml)) throw new Error('Document properties must be stripped.')

await mkdir(target, { recursive: true })
const manifest = { reference: EXPECTED_SHA256, masters: [], files: {} }
async function emit(name, content) {
  await writeFile(resolve(target, name), content, 'utf8')
  manifest.files[name] = createHash('sha256').update(content, 'utf8').digest('hex').toUpperCase()
}
await emit('masters.xml', mastersXml)
for (const master of masters) {
  await emit(master.file, await read(`visio/masters/${master.file}`))
  manifest.masters.push(master)
}
await emit('document.xml', documentXml)
await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`Wrote ${masters.length} masters and document settings to ${target}`)
