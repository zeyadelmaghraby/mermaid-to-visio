import JSZip from 'jszip'

// Builds small Visio ERD drawings for tests: Entity/View groups with styled column text and glued connectors.
export interface FixtureEntity { id: number; name: string; nameU?: string; body: string; styles: Record<number, number>; master?: string }
// ends: the Relationship's cached BeginArrow/EndArrow (crow's-foot line ends), when the test needs them.
export interface FixtureConnector { id: number; begin?: number; end?: number; ends?: [number, number] }

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function pageXml(entities: FixtureEntity[], connectors: FixtureConnector[]) {
  const shapes = entities.map((entity) => `<Shape ID='${entity.id}' NameU='${entity.nameU ?? `Entity.${entity.id}`}' Type='Group' Master='${entity.master ?? '11'}'><Shapes>`
    + `<Shape ID='${entity.id + 1}' Type='Shape' MasterShape='6'><Text><cp IX='0'/>${escape(entity.name)}\n</Text></Shape>`
    + `<Shape ID='${entity.id + 2}' Type='Shape' MasterShape='7'><Section N='Character'>${Object.entries(entity.styles).map(([ix, style]) => `<Row IX='${ix}'><Cell N='Style' V='${style}'/></Row>`).join('')}</Section>`
    + `<Text>${entity.body}</Text></Shape></Shapes></Shape>`).join('')
    + connectors.map((connector) => `<Shape ID='${connector.id}' NameU='Relationship.${connector.id}' Type='Shape' Master='13'>`
      + (connector.ends ? `<Cell N='BeginArrow' V='${connector.ends[0]}' F='Inh'/><Cell N='EndArrow' V='${connector.ends[1]}' F='Inh'/>` : '') + '</Shape>').join('')
  const connects = connectors.flatMap((connector) => [
    ...(connector.begin ? [`<Connect FromSheet='${connector.id}' FromCell='BeginX' FromPart='9' ToSheet='${connector.begin}' ToCell='PinX' ToPart='3'/>`] : []),
    ...(connector.end ? [`<Connect FromSheet='${connector.id}' FromCell='EndX' FromPart='12' ToSheet='${connector.end}' ToCell='PinX' ToPart='3'/>`] : [])]).join('')
  return `<?xml version='1.0' encoding='utf-8' ?><PageContents xmlns='http://schemas.microsoft.com/office/visio/2012/main' xml:space='preserve'><Shapes>${shapes}</Shapes><Connects>${connects}</Connects></PageContents>`
}

export async function buildErd(pages: { name: string; entities: FixtureEntity[]; connectors?: FixtureConnector[] }[]): Promise<Uint8Array> {
  const zip = new JSZip()
  const ns = "xmlns='http://schemas.microsoft.com/office/visio/2012/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'"
  zip.file('visio/pages/pages.xml', `<?xml version='1.0' encoding='utf-8' ?><Pages ${ns}>${pages.map((page, index) => `<Page ID='${index}' NameU='${page.name}' Name='${page.name}'><Rel r:id='rId${index + 1}'/></Page>`).join('')}</Pages>`)
  zip.file('visio/pages/_rels/pages.xml.rels', `<?xml version='1.0' encoding='utf-8' ?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>`
    + pages.map((_, index) => `<Relationship Id='rId${index + 1}' Type='http://schemas.microsoft.com/visio/2010/relationships/page' Target='page${index + 1}.xml'/>`).join('') + '</Relationships>')
  pages.forEach((page, index) => zip.file(`visio/pages/page${index + 1}.xml`, pageXml(page.entities, page.connectors ?? [])))
  return zip.generateAsync({ type: 'uint8array' })
}

// A small "billing" ERD with the cases the real files contain: runs split mid-line, a 2-part line without a key,
// a typo'd FK, mixed schema prefixes, unique keys, a view (by master name and by _View suffix) and a loose connector.
export function sampleErd(): Promise<Uint8Array> {
  return buildErd([
    { name: 'Billing', entities: [
      { id: 100, name: 'bil.Bills', styles: { 0: 1, 1: 5, 2: 1, 3: 0 },
        body: "<cp IX='0'/><tp IX='0'/>PK\t<cp IX='1'/>Id<cp IX='2'/>\tbigint\n\n \tBill_Number\tnvarchar(30)\n \tDue_Date\tdatetime2(7)\n<cp IX='3'/> \tNotes\tnvarchar(max)\n" },
      { id: 110, name: ' bil.Bills_Timeline ', styles: { 0: 0, 1: 1, 2: 5, 3: 0, 4: 1 },
        body: "<cp IX='0'/><tp IX='0'/>PK<cp IX='1'/>\t<cp IX='2'/>Id<cp IX='3'/>\t<cp IX='4'/>bigint\n\n<cp IX='4'/>FK1\tBill_Id\tbigint\n<cp IX='3'/> \tStatus_Lookup_Id\tbigint\n" },
      { id: 120, name: 'bill.Payment_Notifications', styles: { 0: 1, 1: 0 },
        body: "<cp IX='0'/>PK\tId\tbigint\n\n<cp IX='1'/>FK1\tBill_Id\tbigint\nU1\tReference\tnvarchar(13)\nProvider_Status_Code\tnvarchar(50)\n" },
      { id: 130, name: 'bill.Payment_Matching', styles: { 0: 1 },
        body: "<cp IX='0'/>PK,FK1\tPayment_Notifcation_Id\tbigint\n" },
      { id: 140, name: 'cfg.Courts_View', nameU: 'View.140', master: '12', styles: { 0: 1 }, body: "<cp IX='0'/>Id\tbigint\nName_En\tnvarchar(100)\n" },
      { id: 150, name: 'cfg.Banks_view', styles: { 0: 0 }, body: "<cp IX='0'/>Id\tbigint\n" },
      { id: 160, name: 'Not an entity', styles: {}, body: 'Free text' },
    ], connectors: [{ id: 200, begin: 100, end: 112 }, { id: 201, begin: 101, end: 120 }, { id: 202, begin: 122, end: 130 }, { id: 203, begin: 100 }] },
  ])
}
