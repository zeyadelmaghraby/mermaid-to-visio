import JSZip from 'jszip'

// LLD "Detailed Field Description" section as WordprocessingML, laid out like the client's template:
// A4, 1-inch margins, Calibri 11, a bulleted heading per table and a fixed 4-column table.
export interface DocRow { field: string; dataType: string; ro: 'R' | 'O' | '-'; description: string }
export interface DocTable { displayName: string; fullName: string; rows: DocRow[] }
export interface DocSection { title: string; note?: string; tables: DocTable[] }
export interface LldDocument { module: string; source: string; sections: DocSection[] }

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NAVY = '002060', GRAY = '595959', BORDER = '8EAADB'
export const COLUMN_WIDTHS = [2900, 1800, 1250, 3076] as const
const HEADERS = ['Field', 'Data Type', 'Required/ Optional', 'Description']

function text(value: string) {
  return value.replace(/[^\t\n\r -퟿-�]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
const run = (value: string, properties = '') => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${text(value)}</w:t></w:r>`
const color = (hex: string) => `<w:color w:val="${hex}"/>`
const size = (points: number) => `<w:sz w:val="${points * 2}"/><w:szCs w:val="${points * 2}"/>`

function cell(width: number, content: string, options: { fill?: string; center?: boolean } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${options.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>` : ''}<w:vAlign w:val="center"/></w:tcPr>`
    + `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${options.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${content}</w:p></w:tc>`
}

function table(entry: DocTable) {
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${BORDER}"/>`).join('')
  const header = `<w:tr><w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>${HEADERS.map((title, index) => cell(COLUMN_WIDTHS[index],
    run(title, `<w:b/><w:bCs/>${color('FFFFFF')}${size(10)}`), { fill: NAVY, center: true })).join('')}</w:tr>`
  const body = entry.rows.map((row) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>`
    + [row.field, row.dataType, row.ro, row.description].map((value, index) => cell(COLUMN_WIDTHS[index], run(value, `${color('000000')}${size(10)}`), { center: index === 2 })).join('')
    + '</w:tr>').join('')
  // CT_TblPr element order: tblW, tblBorders, tblLayout, tblCellMar, tblLook (out-of-order elements trigger Word's repair).
  return `<w:tbl><w:tblPr><w:tblW w:w="${COLUMN_WIDTHS.reduce((total, width) => total + width, 0)}" w:type="dxa"/>`
    + `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="50" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="50" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>`
    + `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
    + `<w:tblGrid>${COLUMN_WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`
}

function documentXml(document: LldDocument) {
  const paragraphs: string[] = [
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(`Detailed Field Description – ${document.module} Module`)}</w:p>`,
    `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>${run('Generated from ', `${color(GRAY)}${size(10)}`)}${run(document.source, `<w:i/><w:iCs/>${color(GRAY)}${size(10)}`)}`
      + `${run('. R = Required (NOT NULL), O = Optional. PK = Primary Key, FK = Foreign Key, UK = Unique Key.', `${color(GRAY)}${size(10)}`)}</w:p>`,
  ]
  for (const section of document.sections.filter((entry) => entry.tables.length)) {
    paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run(section.title)}</w:p>`)
    if (section.note) paragraphs.push(`<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${run(section.note, `${color(GRAY)}${size(10)}`)}</w:p>`)
    for (const entry of section.tables) {
      paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:keepNext/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:before="240" w:after="120"/></w:pPr>`
        + `${run(entry.displayName, `<w:b/><w:bCs/>${size(12)}`)}${run(`  (${entry.fullName})`, `${color(GRAY)}${size(10)}`)}</w:p>`)
      paragraphs.push(table(entry))
      paragraphs.push('<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:p>')
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${REL}"><w:body>${paragraphs.join('')}`
    + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>${size(11)}<w:lang w:val="en-US"/></w:rPr></w:rPrDefault>`
  + `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/>${color(NAVY)}${size(16)}</w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/>${color(NAVY)}${size(13)}</w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`
  + `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`

// A real Word bullet list: "▪" at 1080 left / 360 hanging, not a typed character.
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>`
  + `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="▪"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1080" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:hint="default"/></w:rPr></w:lvl>`
  + `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`

export async function renderDocx(document: LldDocument): Promise<Uint8Array> {
  const zip = new JSZip()
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  zip.file('[Content_Types].xml', `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>')
  zip.file('_rels/.rels', `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>`
    + `<Relationship Id="rId3" Type="${REL}/settings" Target="settings.xml"/></Relationships>`)
  zip.file('word/document.xml', documentXml(document))
  zip.file('word/styles.xml', STYLES)
  zip.file('word/numbering.xml', NUMBERING)
  zip.file('word/settings.xml', SETTINGS)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
