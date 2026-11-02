// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseErd } from './parse'
import { buildErd, sampleErd } from './fixture'
import { emptyDescriptions, generateDescriptions, moduleName } from './generate'
import { buildDocument, readDescriptions } from './descriptions'

describe('rule-based descriptions', () => {
  it('names the module after the ERD file', () => {
    expect(moduleName('Billing_ERD.vsdx')).toBe('Billing')
    expect(moduleName('C:\\Designs\\Intermediate Banking ERD.vsdx')).toBe('Intermediate Banking')
    expect(moduleName('erd.vsdx')).toBe('Database')
  })

  it('writes possessive phrases, FK and lookup wording, and flags unclear columns', async () => {
    const schema = await parseErd(await buildErd([{ name: 'P', entities: [
      { id: 10, name: 'bil.Bills', styles: { 0: 1 }, body: "<cp IX='0'/>PK\tId\tbigint\n\n \tBill_Number\tnvarchar(30)\n \tDue_Date\tdatetime\n \tName_Ar\tnvarchar(100)\n \tIs_Active\tbit\n \tPaid_At\tdatetime\n \tStatus_Lookup_Id\tbigint\n \tAmount\tdecimal(18,2)\n \tSystem_Id\tbigint\n \tCycle\tint\n \tCreation_Time\tdatetime\n" },
      { id: 20, name: 'bil.Bills_Timeline', styles: { 0: 1 }, body: "<cp IX='0'/>PK\tId\tbigint\n\nFK1\tBill_Id\tbigint\nFK2\tOrphan_Id\tbigint\n" },
    ], connectors: [{ id: 30, begin: 10, end: 20 }] }]), 'Billing_ERD.vsdx')
    const descriptions = generateDescriptions(schema)
    expect(descriptions.module).toBe('Billing')
    expect(descriptions.tables['bil.Bills']).toEqual({ _entity: 'Bill', Bill_Number: "Bill's number", Due_Date: "Bill's due date", Name_Ar: "Bill's name in Arabic",
      Is_Active: 'Whether the bill is active', Paid_At: 'Date and time the bill was paid', Status_Lookup_Id: "Bill's status (lookup value)", Amount: "Bill's amount",
      System_Id: 'Identifier of the related system', Cycle: "Bill's cycle", _uncertain: ['System_Id', 'Cycle'] })
    expect(descriptions.tables['bil.Bills_Timeline']).toEqual({ _entity: 'Bill timeline', Bill_Id: 'Bill that the bill timeline belongs to (ref. Bills)',
      Orphan_Id: 'Reference to the related orphan', _uncertain: ['Orphan_Id'] })
    // Id and audit columns come from the shared dictionary, filled per table.
    const { document, missing } = buildDocument(schema, descriptions, { includeViews: true, friendlyTypes: false })
    expect(missing).toEqual([])
    expect(document.sections[0].tables[0].rows.find((row) => row.field === 'Id')!.description).toBe("Bill's unique identifier")
    expect(document.sections[0].tables[0].rows.find((row) => row.field === 'Creation_Time')!.description).toBe('Date and time the record was created')
    expect(readDescriptions(JSON.stringify(descriptions))).toEqual(descriptions)
  })

  it('groups tables by name family with parents first and leaves loners ungrouped', async () => {
    const schema = await parseErd(await sampleErd(), 'Billing_ERD.vsdx')
    expect(generateDescriptions(schema).groups).toEqual([{ title: 'Bills', tables: ['bil.Bills', 'bil.Bills_Timeline'] },
      { title: 'Payments', tables: ['bill.Payment_Notifications', 'bill.Payment_Matching'] }])
    // Fallback-only mode: no table entries, so the document relies on the dictionary, FK and lookup fallbacks.
    const fallback = emptyDescriptions(schema)
    expect(fallback.tables).toEqual({})
    const { missing } = buildDocument(schema, fallback, { includeViews: true, friendlyTypes: false })
    expect(missing.map((entry) => entry.column)).toEqual(['Bill_Number', 'Due_Date', 'Notes', 'Reference', 'Provider_Status_Code', 'Name_En'])
  })
})
