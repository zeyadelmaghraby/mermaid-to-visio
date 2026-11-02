// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseErd, resolveReference } from './parse'
import { editDistance, similarity } from './similarity'
import { buildErd, sampleErd } from './fixture'
import type { LldTable } from './model'

describe('Visio ERD parser', () => {
  it('reads entities, views, styled columns and glued relationships', async () => {
    const schema = await parseErd(await sampleErd(), 'Sample.vsdx')
    expect(schema.source).toBe('Sample.vsdx')
    expect(schema.tables.map((table) => [table.full_name, table.schema, table.name, table.kind, table.page, table.id])).toEqual([
      ['bil.Bills', 'bil', 'Bills', 'table', 'Billing', '100'], ['bil.Bills_Timeline', 'bil', 'Bills_Timeline', 'table', 'Billing', '110'],
      ['bill.Payment_Notifications', 'bill', 'Payment_Notifications', 'table', 'Billing', '120'], ['bill.Payment_Matching', 'bill', 'Payment_Matching', 'table', 'Billing', '130'],
      ['cfg.Courts_View', 'cfg', 'Courts_View', 'view', 'Billing', '140'], ['cfg.Banks_view', 'cfg', 'Banks_view', 'view', 'Billing', '150']])
    // Connectors glued to nested sub-shapes belong to their entity; one connector is glued at one end only.
    expect(schema.relationships).toEqual([{ parent: 'bil.Bills', child: 'bil.Bills_Timeline' }, { parent: 'bil.Bills', child: 'bill.Payment_Notifications' },
      { parent: 'bill.Payment_Notifications', child: 'bill.Payment_Matching' }])
    expect(schema.looseConnectors).toEqual([{ id: '203', page: 'Billing', parent: 'bil.Bills', child: undefined }])
  })

  it('keeps per-character styles across runs that split keys, names and types', async () => {
    const schema = await parseErd(await sampleErd(), 'Sample.vsdx')
    const table = (name: string) => schema.tables.find((entry) => entry.full_name === name)!
    expect(table('bil.Bills').columns.map((column) => [column.name, column.type, column.keys, column.required])).toEqual([
      ['Id', 'bigint', ['PK'], true], ['Bill_Number', 'nvarchar(30)', [], true], ['Due_Date', 'datetime2(7)', [], true], ['Notes', 'nvarchar(max)', [], false]])
    // PK, Id and bigint are three runs; the key run is not bold, the name run is.
    expect(table('bil.Bills_Timeline').columns[0]).toEqual({ name: 'Id', type: 'bigint', keys: ['PK'], pk: true, fk: false, unique: false, required: true })
    expect(table('bil.Bills_Timeline').columns[1]).toMatchObject({ name: 'Bill_Id', fk: true, required: true, ref: 'bil.Bills' })
    expect(table('bil.Bills_Timeline').columns[2]).toMatchObject({ name: 'Status_Lookup_Id', required: false })
    const notifications = table('bill.Payment_Notifications').columns
    expect(notifications.find((column) => column.name === 'Reference')).toMatchObject({ keys: ['U1'], unique: true, required: false })
    // Two-part line: no key column.
    expect(notifications.find((column) => column.name === 'Provider_Status_Code')).toEqual({ name: 'Provider_Status_Code', type: 'nvarchar(50)', keys: [], pk: false, fk: false, unique: false, required: false })
    // Typo'd FK resolves to its parent; combined PK,FK keys.
    expect(table('bill.Payment_Matching').columns[0]).toMatchObject({ keys: ['PK', 'FK1'], pk: true, fk: true, required: true, ref: 'bill.Payment_Notifications' })
    for (const view of schema.tables.filter((entry) => entry.kind === 'view')) for (const column of view.columns) expect(column.required).toBeNull()
  })

  it('resolves FK targets by singular, typo-tolerant name similarity', () => {
    const parent = (full_name: string): LldTable => ({ id: '1', page: 'p', full_name, schema: full_name.split('.')[0], name: full_name.split('.')[1], kind: 'table', columns: [] })
    const parents = [parent('bil.Bill_Payment_Notifications'), parent('bil.Bills'), parent('bil.Agencies')]
    expect(resolveReference('Payment_Notifcation_Id', parents)).toBe('bil.Bill_Payment_Notifications')
    expect(resolveReference('Bill_Id', parents)).toBe('bil.Bills')
    expect(resolveReference('AgencyId', parents)).toBe('bil.Agencies')
    expect(resolveReference('Tariff_Id', parents)).toBeUndefined()
  })

  it('reads every page and rejects files that are not Visio drawings', async () => {
    const twoPages = await buildErd([
      { name: 'A', entities: [{ id: 10, name: 'x.T1', styles: { 0: 1 }, body: "<cp IX='0'/>PK\tId\tint\n" }] },
      { name: 'B', entities: [{ id: 10, name: 'x.T2', styles: { 0: 0 }, body: "<cp IX='0'/> \tCode\tnvarchar(5)\n" }] }])
    const schema = await parseErd(twoPages, 'Two.vsdx')
    expect(schema.tables.map((table) => [table.full_name, table.page, table.columns[0].required])).toEqual([['x.T1', 'A', true], ['x.T2', 'B', false]])
    await expect(parseErd(new Uint8Array([1, 2, 3]), 'bad.vsdx')).rejects.toThrow('not a Visio .vsdx')
  })

  it('ports difflib ratios and Levenshtein distances', () => {
    // Values from Python: difflib.SequenceMatcher(None, a, b).ratio()
    expect(similarity('paymentnotifiation', 'billpaymentnotification')).toBeCloseTo(0.8780487804878049, 12)
    expect(similarity('abcd', 'bcde')).toBeCloseTo(0.75, 12)
    expect(similarity('', '')).toBe(1)
    expect(editDistance('Notifcation', 'Notification')).toBe(1)
    expect(editDistance('Last_Modifcation_Time', 'Last_Modification_Time')).toBe(1)
  })
})
