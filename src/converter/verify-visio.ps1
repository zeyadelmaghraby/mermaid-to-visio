param([string]$Path = (Join-Path $PSScriptRoot '../../samples/CreateBillRequest.vsdx'),
    [string]$OriginalPath = $env:M2V_REFERENCE_VSDX,
    [string]$ProofDirectory = (Join-Path $PSScriptRoot '../../samples'))
# Live Visio COM gate for the native engine. Only TEMP copies are edited; the original opens read-only with macros disabled.
$ErrorActionPreference = 'Stop'
$OriginalSha = 'FA5366E43261593B23651B47C7B3E138CA0425B79F2A77BD0CA09313B9CF4FD7'
if ([string]::IsNullOrWhiteSpace($OriginalPath)) { throw 'Missing reference: pass -OriginalPath <path/to/reference.vsdx> or set $env:M2V_REFERENCE_VSDX.' }
$Path = [IO.Path]::GetFullPath($Path); $OriginalPath = [IO.Path]::GetFullPath($OriginalPath)
if ($Path -eq $OriginalPath) { throw 'The original reference must never be used as the generated input.' }
if ((Get-FileHash $OriginalPath -Algorithm SHA256).Hash -ne $OriginalSha) { throw 'Unexpected original SHA256.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Part([string]$ArchivePath, [string]$Part) {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try { $reader = [IO.StreamReader]::new($archive.GetEntry($Part).Open()); try { $reader.ReadToEnd() } finally { $reader.Dispose() } } finally { $archive.Dispose() }
}
$failures = [Collections.Generic.List[string]]::new()
function Check([bool]$Ok, [string]$Message) { if (-not $Ok) { $failures.Add($Message) } }
function Near([double]$A, [double]$B) { [Math]::Abs($A - $B) -lt 1e-6 }
function World-Point($Shape, [double]$X, [double]$Y) { [double]$wx = 0; [double]$wy = 0; $Shape.XYToPage($X, $Y, [ref]$wx, [ref]$wy); @($wx, $wy) }
function Rows($Shape, [int]$Section) { if ($Shape.SectionExists($Section, 0)) { $Shape.RowCount($Section) } else { 0 } }
function Master-Inventory($Document) {
    foreach ($m in $Document.Masters) {
        $s = $m.Shapes.Item(1)
        [ordered]@{ NameU = $m.NameU; BaseID = $m.BaseID; UniqueID = $m.UniqueID; MatchByName = [bool]$m.MatchByName
            LineStyle = $s.LineStyle; FillStyle = $s.FillStyle; TextStyle = $s.TextStyle; SubShapes = $s.Shapes.Count
            Connections = Rows $s 7; Controls = Rows $s 9; Actions = Rows $s 240; User = Rows $s 242; Props = Rows $s 243 }
    }
}
function Assert-LiveGlue($Page, [string]$Stage) {
    $count = 0
    foreach ($c in $Page.Connects) {
        $from = $c.FromSheet; $to = $c.ToSheet; $fx = $c.FromCell.Name; $tx = $c.ToCell.Name
        if ($fx -notmatch '^(Begin|End)X$' -or $tx -notmatch '^Connections\.X\d+$') { Check $false "$Stage unexpected connect $($from.NameU).$fx -> $($to.NameU).$tx"; continue }
        $p = World-Point $to $to.CellsU($tx).ResultIU $to.CellsU($tx.Replace('.X', '.Y')).ResultIU
        Check ((Near $from.CellsU($fx).ResultIU $p[0]) -and (Near $from.CellsU($fx.Replace('X', 'Y')).ResultIU $p[1])) "$Stage world glue $($from.NameU).$fx -> $($to.NameU).$tx"
        $count++
    }
    $count
}
# Every cached V in page1.xml (top-level and group children, incl. 100-row Connection sections) must equal Visio's recalculated value.
function Compare-Cache($Page, $XmlShapes, [ref]$Compared) {
    foreach ($xs in $XmlShapes) {
        $live = $Page.Shapes.ItemFromID([int]$xs.ID)
        foreach ($cell in @($xs.Cell)) {
            if ($cell.N -notin 'PinX', 'PinY', 'Width', 'Height', 'Angle', 'BeginX', 'BeginY', 'EndX', 'EndY', 'LocPinX', 'LocPinY' -or -not $cell.V) { continue }
            $Compared.Value++; Check (Near $live.CellsU($cell.N).ResultIU ([double]$cell.V)) "stale cache $($xs.NameU).$($cell.N) xml=$($cell.V) visio=$($live.CellsU($cell.N).ResultIU)"
        }
        foreach ($section in @($xs.Section | Where-Object { $_.N -eq 'Connection' })) {
            foreach ($row in @($section.Row)) {
                foreach ($cell in @($row.Cell | Where-Object { $_.N -in 'X', 'Y' -and $_.V })) {
                    $Compared.Value++; $actual = $live.CellsSRC(7, [int]$row.IX, $(if ($cell.N -eq 'X') { 0 } else { 1 })).ResultIU
                    Check (Near $actual ([double]$cell.V)) "stale cache $($xs.NameU) Connection[$($row.IX)].$($cell.N) xml=$($cell.V) visio=$actual"
                }
            }
        }
        if ($xs.Shapes) { Compare-Cache $Page @($xs.Shapes.Shape) $Compared }
    }
}
$temp = Join-Path $env:TEMP "m2v-verify-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $temp | Out-Null
$copy = Join-Path $temp 'generated.vsdx'; Copy-Item $Path $copy
$pageXml = [xml](Read-Part $copy 'visio/pages/page1.xml')
$xmlConnects = @($pageXml.PageContents.Connects.Connect).Count
$visio = New-Object -ComObject Visio.InvisibleApp
$proof = [ordered]@{ generated = $Path; generatedSha256 = (Get-FileHash $Path -Algorithm SHA256).Hash; originalSha256 = $OriginalSha }
try {
    $visio.AlertResponse = 7
    $original = $visio.Documents.OpenEx($OriginalPath, 130)
    $originalMasters = @(Master-Inventory $original)
    $originalStyles = @($original.Styles | ForEach-Object { $_.NameU }) | Sort-Object
    $proof.originalSnap = $original.SnapSettings

    $doc = $visio.Documents.OpenEx($copy, 128)
    $page = $doc.Pages.Item(1)
    $masters = @(Master-Inventory $doc)
    Check ($masters.Count -eq 12) "generated masters=$($masters.Count), expected 12"
    foreach ($m in $masters) {
        $o = $originalMasters | Where-Object { $_.UniqueID -eq $m.UniqueID }
        if (-not $o) { Check $false "master $($m.NameU) UniqueID $($m.UniqueID) not in original"; continue }
        foreach ($key in $m.Keys) { Check ("$($m[$key])" -eq "$($o[$key])") "master $($m.NameU).$key generated=$($m[$key]) original=$($o[$key])" }
    }
    $styles = @($doc.Styles | ForEach-Object { $_.NameU }) | Sort-Object
    Check ((Compare-Object $styles $originalStyles).Count -eq 0) "style sheets differ: $((Compare-Object $styles $originalStyles | ForEach-Object { $_.InputObject }) -join ',')"
    $proof.snap = $doc.SnapSettings
    Check ($proof.snap -eq $proof.originalSnap) "SnapSettings generated=$($proof.snap) original=$($proof.originalSnap)"

    $top = @($page.Shapes | ForEach-Object { $_ })
    $instances = [ordered]@{}
    foreach ($shape in $top) {
        if (-not $shape.Master) { Check $false "top-level shape $($shape.NameU) has no master"; continue }
        $key = $shape.Master.NameU; $instances[$key] = 1 + [int]$instances[$key]
        Check (@($originalMasters | Where-Object { $_.UniqueID -eq $shape.Master.UniqueID }).Count -eq 1) "$($shape.NameU) master not original"
    }
    $proof.instances = $instances
    $messages = @($top | Where-Object { $_.Master.NameU -in 'Message', 'Self Message', 'Return Message', 'Asynchronous Message' }).Count
    $bars = @($top | Where-Object { $_.Master.NameU -eq 'Activation' })
    $proof.connects = $page.Connects.Count
    Check ($page.Connects.Count -eq $xmlConnects) "live Connects=$($page.Connects.Count) xml=$xmlConnects"
    Check ($page.Connects.Count -eq 2 * ($messages + $bars.Count)) "Connects=$($page.Connects.Count) expected 2x($messages messages + $($bars.Count) bars)"
    $compared = 0
    Compare-Cache $page @($pageXml.PageContents.Shapes.Shape) ([ref]$compared)
    $proof.cachedValuesCompared = $compared
    $proof.initialGlue = Assert-LiveGlue $page 'initial'
    foreach ($bar in $bars) {
        Check (Near $bar.CellsU('Angle').ResultIU ([Math]::PI / 2)) "$($bar.NameU) Angle=$($bar.CellsU('Angle').ResultIU)"
        Check ($bar.CellsU('BeginY').ResultIU -lt $bar.CellsU('EndY').ResultIU) "$($bar.NameU) Begin not at bottom"
        Check (Near $bar.CellsU('Width').ResultIU ($bar.CellsU('EndY').ResultIU - $bar.CellsU('BeginY').ResultIU)) "$($bar.NameU) Width != length"
        $glued = @($page.Connects | Where-Object { $_.FromSheet.ID -eq $bar.ID }).Count
        Check ($glued -eq 2) "$($bar.NameU) glued endpoints=$glued"
    }
    $containers = [ordered]@{}
    foreach ($shape in $top | Where-Object { $_.Master.NameU -like '*fragment*' }) {
        $ids = @(); try { $ids = @($shape.ContainerProperties.GetMemberShapes(0)) } catch { }
        $containers[$shape.NameU] = @($ids | ForEach-Object { $page.Shapes.ItemFromID($_).NameU })
        Check ($containers[$shape.NameU].Count -gt 0) "$($shape.NameU) has no native container members"
    }
    $proof.containerMembers = $containers
    $page.Export((Join-Path $temp 'CreateBillRequest.png'))
    $bars[0].Export((Join-Path $temp 'Activation-detail.png'))

    # API edit (not a mouse/UI proof): move a lifeline and require every glued endpoint to follow.
    $lifeline = $page.Shapes.ItemU('Lifeline.Billing')
    $lifeline.CellsU('PinX').ResultIU = $lifeline.CellsU('PinX').ResultIU + 0.5
    $proof.editedGlue = Assert-LiveGlue $page 'edited'
    $edited = Join-Path $temp 'edited.vsdx'; $doc.SaveAs($edited); $doc.Close()
    $doc = $visio.Documents.OpenEx($edited, 128); $page = $doc.Pages.Item(1)
    Check ($page.Connects.Count -eq $xmlConnects) "reopened Connects=$($page.Connects.Count)"
    $proof.reopenedGlue = Assert-LiveGlue $page 'reopened'

    # Dropping every original master into the generated document must reuse the embedded masters (no Activation.N duplicates).
    $before = $doc.Masters.Count
    foreach ($m in $original.Masters) { $page.Drop($m, 1, 1).Delete() }
    $proof.mastersAfterDrop = $doc.Masters.Count
    Check ($doc.Masters.Count -eq $before) "dropping original masters added $($doc.Masters.Count - $before) masters: $((@($doc.Masters | ForEach-Object { $_.NameU })) -join ',')"
    $doc.Close(); $original.Close()
} finally {
    $visio.Quit()
    if ((Get-FileHash $OriginalPath -Algorithm SHA256).Hash -ne $OriginalSha) { throw 'Original reference hash changed.' }
}
$proof.failures = @($failures)
$proof | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $temp 'CreateBillRequest.verification.json') -Encoding utf8
Write-Output "TEMP proof: $temp"
if ($failures.Count) { $failures | Select-Object -First 40 | ForEach-Object { Write-Output "FAIL: $_" }; throw "$($failures.Count) native verification failures." }
foreach ($name in 'CreateBillRequest.png', 'Activation-detail.png', 'CreateBillRequest.verification.json') { Copy-Item (Join-Path $temp $name) (Join-Path $ProofDirectory $name) -Force }
Write-Output "Verified: masters=12 identical, connects=$($proof.connects), cached=$($proof.cachedValuesCompared), glue initial/edited/reopened=$($proof.initialGlue)/$($proof.editedGlue)/$($proof.reopenedGlue), mastersAfterDrop=$($proof.mastersAfterDrop)"
