// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseErd } from './parse'
import { buildErd } from './fixture'
import { validate } from './validate'

describe('LLD validation report', () => {
  it('reports prefixes, typos, unresolved FKs, loose connectors and sibling R/O mismatches', async () => {
    const erd = await parseErd(await buildErd([{ name: 'P', entities: [
      { id: 10, name: 'bil.Bills', styles: { 0: 1 }, body: "<cp IX='0'/>PK\tId\tbigint\n\n \tConcurrency_Stamp\tnvarchar(40)\n \tLast_Modification_Time\tdatetime\n \tMaximum_Amount\tdecimal(18,2)\n" },
      { id: 20, name: 'bill.Bill_Requests_Revenue_Entries', styles: { 0: 0, 1: 1 }, body: "<cp IX='0'/> \tAmount\tdecimal(20,2)\n \tConcurrency_Stamp\tnvarchar(40)\nFK1\tUnknown_Parent_Id\tbigint\n" },
      { id: 30, name: 'bil.Refund_Request_Revenue_Entries', styles: { 0: 1 }, body: "<cp IX='0'/> \tAmount\tdecimal(20,2)\n \tConcurency_Stamp\tnvarchar(40)\n \tLast_Modification_Time\tdatetime\n \tMinimum_Amount\tdecimal(18,2)\n \tMinimum_Fee\tdecimal(18,2)\n" },
      { id: 40, name: 'bil.Audit_View', styles: { 0: 0 }, body: "<cp IX='0'/>Last_Modifcation_Time\tdatetime\n" },
    ], connectors: [{ id: 50, end: 20 }] }]), 'Billing_ERD.vsdx')
    const warnings = validate(erd, [{ table: 'bil.Bills', column: 'Notes' }], [{ table: 'bil.Bills', column: 'Cycle' }])
    expect(warnings.map((warning) => [warning.kind, warning.message])).toEqual([
      ['missing-description', 'No description for bil.Bills.Notes.'],
      ['uncertain-description', 'Check the description of bil.Bills.Cycle; its purpose is not clear from the ERD.'],
      ['unresolved-fk', 'The parent table of FK bill.Bill_Requests_Revenue_Entries.Unknown_Parent_Id could not be resolved from the relationships.'],
      ['loose-connector', 'Connector 50 on page P is not glued to two tables (nothing → bill.Bill_Requests_Revenue_Entries).'],
      ['schema-prefix', 'Inconsistent schema prefixes: bil. (3 tables) and bill. (1 tables) look like the same schema.'],
      ['typo', 'Possible typo: Concurency_Stamp (did you mean Concurrency_Stamp?) in bil.Refund_Request_Revenue_Entries.Concurency_Stamp.'],
      ['typo', 'Possible typo: Last_Modifcation_Time (did you mean Last_Modification_Time?) in bil.Audit_View.Last_Modifcation_Time.'],
      ['required-mismatch', 'Amount (decimal(20,2)) is Required in bil.Refund_Request_Revenue_Entries but Optional in bill.Bill_Requests_Revenue_Entries.'],
    ])
  })
})
