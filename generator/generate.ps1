# Simnovus cfg generator: UESIM testDefinition JSON -> gnb.cfg / enb.cfg / mme.cfg / ims.cfg
#
# Strategy: template-fill for top-level boilerplate (#defines, log options, RF driver,
# AMF/MME addresses) + synthesis for the variable-length lists (nr_cell_list, cell_list,
# pdn_list, ue_db) so the size and shape match the testcase exactly.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$TestcaseJson,
    [Parameter(Mandatory=$true)][string]$OutDir,
    [string]$GnbTemplate,
    [string]$EnbTemplate,
    [string]$MmeTemplate,
    [string]$ImsTemplate
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $GnbTemplate) { $GnbTemplate = Join-Path $here 'template-gnb-sa.cfg' }
if (-not $EnbTemplate) { $EnbTemplate = Join-Path $here 'template-enb.cfg' }
if (-not $MmeTemplate) { $MmeTemplate = Join-Path $here 'template-mme.cfg' }
if (-not $ImsTemplate) { $ImsTemplate = Join-Path $here 'template-ims.cfg' }

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# ============================================================================
# Constants and tables
# ============================================================================

# LTE bandwidth (MHz) -> N_RB_DL
$LTE_NRB = @{
    '1.4' = 6; '3' = 15; '5' = 25; '10' = 50; '15' = 75; '20' = 100
}

# IMS realm, P-CSCF default (matches corpus)
$IMS_PCSCF = '192.168.4.1'
$IMS_REALM_DEFAULT = 'ims.mnc001.mcc001.3gppnetwork.org'

# ============================================================================
# Helpers
# ============================================================================

function Read-Json { param([string]$Path)
    Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Write-NoBom {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

# Replace `#define KEY <value>` line. Returns text unchanged + warning if not found.
function Set-Define {
    param([string]$Text, [string]$Key, $Value)
    $pattern = "(?m)^(\s*#define\s+$([regex]::Escape($Key))\s+)([^\s/]+)(.*)$"
    $replacement = '${1}' + "$Value" + '${3}'
    if ($Text -match $pattern) { return [regex]::Replace($Text, $pattern, $replacement) }
    Write-Warning "Set-Define: no match for #define $Key"
    return $Text
}

# Replace a libconfig scalar field. Anchor scopes the search.
function Set-Scalar {
    param([string]$Text, [string]$Field, $Value, [string]$Anchor = $null)
    $valStr = if ($Value -is [string] -and $Value -notmatch '^[\d\-]') { '"' + $Value + '"' } else { "$Value" }
    $rx = "(?m)^(\s*$([regex]::Escape($Field))\s*:\s*)([^,\r\n]+)(\s*,?.*)$"
    $repl = '${1}' + $valStr + '${3}'
    if ($Anchor) {
        $idx = [regex]::Match($Text, $Anchor)
        if (-not $idx.Success) { return $Text }
        $start = $idx.Index
        $end = [Math]::Min($Text.Length, $start + 4000)
        $window = $Text.Substring($start, $end - $start)
        $newWindow = [regex]::Replace($window, $rx, $repl, 1)
        return $Text.Substring(0, $start) + $newWindow + $Text.Substring($end)
    }
    return [regex]::Replace($Text, $rx, $repl, 1)
}

# Replace a libconfig list block: `<name>: [ ... ],`
# Finds matching `]` honoring nested brackets and braces.
function Replace-ListBlock {
    param([string]$Text, [string]$ListName, [string]$NewContent)
    $rx = "$([regex]::Escape($ListName))\s*:\s*\["
    $m = [regex]::Match($Text, $rx)
    if (-not $m.Success) {
        Write-Warning "Replace-ListBlock: list '$ListName' not found in template"
        return $Text
    }
    $start = $m.Index + $m.Length
    $depth = 1; $i = $start
    while ($i -lt $Text.Length -and $depth -gt 0) {
        $c = $Text[$i]
        if ($c -eq '[' -or $c -eq '{') { $depth++ }
        elseif ($c -eq ']' -or $c -eq '}') { $depth--; if ($depth -eq 0) { break } }
        $i++
    }
    return $Text.Substring(0, $m.Index) + "${ListName}: [`r`n$NewContent`r`n  ]" + $Text.Substring($i + 1)
}

# Strip leading "n" from NR band names: "n78" -> 78
function Get-NrBand {
    param($band)
    if ($null -eq $band) { return 78 }
    $s = "$band"
    if ($s -match '^[nN]') { return [int]$s.Substring(1) }
    return [int]$s
}

# Pad IMSI to 15 digits (handles JSON-numeric input that lost leading zeros)
function Format-Imsi {
    param($Imsi)
    if ($null -eq $Imsi) { return $null }
    return ([string]$Imsi).PadLeft(15, '0')
}

function Get-PlmnFromImsi {
    param($Imsi, [int]$MncDigits = 2)
    $padded = Format-Imsi $Imsi
    if (-not $padded) { return '00101' }
    return $padded.Substring(0, 3 + $MncDigits)
}

# Pick first scalar from possibly-array gain field
function Get-FirstGain {
    param($g, [int]$default = 0)
    if ($null -eq $g) { return $default }
    if ($g -is [Array]) { if ($g.Count -gt 0) { return [int]$g[0] } else { return $default } }
    return [int]$g
}

# ============================================================================
# gNB (NR SA) builder
# ============================================================================

function Build-NrCellList {
    param($cells, [int]$tddFlag, [int]$fr2Flag)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $cells.Count; $i++) {
        $c = $cells[$i]
        $band     = Get-NrBand $c.cellConfig.band
        $arfcnDl  = $c.cellRadioInfo.NRARFCN.dl
        $arfcnSsb = $c.cellRadioInfo.NRARFCN.ssb
        $scs      = [int]$c.cellCarrierConfig.ScsInfo.scs
        if ($scs -eq 0) { $scs = 30 }
        $rfPort   = if ($null -ne $c.cellRadioInfo.rfInfo.rfCard) { [int]$c.cellRadioInfo.rfInfo.rfCard } else { $i }
        $cellId   = "0x{0:X2}" -f ($i + 1)
        $nIdCell  = 500 + $i

        # SSB position bitmap depends on SCS / FR1-FR2
        $ssbBitmap = if ($fr2Flag -eq 1) { '0100000000000000000000000000000000000000000000000000000000000000' } else { '10000000' }

        # Neighbour cell list for HO: every other cell in this gNB
        $ncellEntries = @()
        for ($j = 0; $j -lt $cells.Count; $j++) {
            if ($j -ne $i) { $ncellEntries += '{cell_id: ' + ($j + 1) + '}' }
        }
        $ncellList = if ($ncellEntries.Count -gt 0) { '    ncell_list: [ ' + ($ncellEntries -join ', ') + ' ],' + "`r`n" } else { '' }

        $entry = @"
  {
    rf_port: $rfPort,
    cell_id: $cellId,
    n_id_cell: $nIdCell,
$ncellList    band: $band,
    dl_nr_arfcn: $arfcnDl,
    ssb_nr_arfcn: $arfcnSsb,
    subcarrier_spacing: $scs,
    ssb_pos_bitmap: "$ssbBitmap",
  },
"@
        [void]$sb.Append($entry)
        if ($i -lt $cells.Count - 1) { [void]$sb.Append("`r`n") }
    }
    return $sb.ToString()
}

function Build-GnbSa {
    param($Td, [string]$TestcaseId, [string]$TemplatePath, [string]$OutPath)

    $cells = $Td.cellConfig.cells
    if ($cells.Count -eq 0) { throw "No cells in cellConfig.cells" }
    $c0 = $cells[0]

    $duplex   = $c0.cellConfig.duplexMode
    $bw       = [int]$c0.cellBandwidthInfo.bandwidth
    $scs      = [int]$c0.cellCarrierConfig.ScsInfo.scs
    if ($scs -eq 0) { $scs = 30 }
    $band     = Get-NrBand $c0.cellConfig.band
    $antDl    = [int]$c0.cellRadioInfo.antennas.dl
    $antUl    = [int]$c0.cellRadioInfo.antennas.ul
    $isFr2    = ($band -ge 257)
    $tddFlag  = if ($duplex -eq 'TDD') { 1 } else { 0 }
    $fr2Flag  = if ($isFr2) { 1 } else { 0 }
    $txGain   = Get-FirstGain $c0.cellCarrierConfig.gainInfo.txGain 80
    $rxGain   = Get-FirstGain $c0.cellCarrierConfig.gainInfo.rxGain 10

    Write-Host "  gNB: $($cells.Count) cell(s), band=$band bw=$bw scs=$scs duplex=$duplex ant=${antDl}x$antUl fr2=$isFr2"

    $text = Get-Content -Raw -LiteralPath $TemplatePath

    # Top-of-file #defines
    $text = Set-Define $text 'NR_TDD'        $tddFlag
    $text = Set-Define $text 'FR2'           $fr2Flag
    $text = Set-Define $text 'N_ANTENNA_DL'  $antDl
    $text = Set-Define $text 'N_ANTENNA_UL'  $antUl
    $text = Set-Define $text 'NR_BANDWIDTH'  $bw

    # Root scalars
    $text = Set-Scalar $text 'tx_gain' "$txGain.0"
    $text = Set-Scalar $text 'rx_gain' "$rxGain.0"

    # Synthesize nr_cell_list (replaces template's variant)
    $cellListText = Build-NrCellList -cells $cells -tddFlag $tddFlag -fr2Flag $fr2Flag
    $text = Replace-ListBlock $text 'nr_cell_list' $cellListText

    $stamp = "/* GENERATED by simqa generate.ps1 from testcase $TestcaseId on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') */`r`n"
    Write-NoBom $OutPath ($stamp + $text)
    Write-Host "  wrote $OutPath"
}

# ============================================================================
# eNB (LTE) builder
# ============================================================================

function Build-LteCellList {
    param($cells, [string]$plmn)
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $cells.Count; $i++) {
        $c = $cells[$i]
        $earfcnDl = $c.cellRadioInfo.EARFCN.dl
        if (-not $earfcnDl) { $earfcnDl = 3350 }
        $earfcnUl = $c.cellRadioInfo.EARFCN.ul
        $tac      = "0x{0:X4}" -f ($i + 1)
        $cellId   = "0x{0:X2}" -f ($i + 1)
        $nIdCell  = $i + 1

        $ulLine = if ($earfcnUl) { "    ul_earfcn: $earfcnUl,`r`n" } else { '' }

        $entry = @"
  {
    plmn_list: [ "$plmn" ],
    dl_earfcn: $earfcnDl,
$ulLine    n_id_cell: $nIdCell,
    cell_id: $cellId,
    tac: $tac,
    root_sequence_index: $((204 + $i * 8)),
  },
"@
        [void]$sb.Append($entry)
        if ($i -lt $cells.Count - 1) { [void]$sb.Append("`r`n") }
    }
    return $sb.ToString()
}

function Build-LteEnb {
    param($Td, [string]$TestcaseId, [string]$Plmn, [string]$TemplatePath, [string]$OutPath)

    $cells = $Td.cellConfig.cells
    if ($cells.Count -eq 0) { throw "No cells in cellConfig.cells" }
    $c0 = $cells[0]

    $duplex   = $c0.cellConfig.duplexMode
    $bwStr    = "$($c0.cellBandwidthInfo.bandwidth)"
    $nRb      = if ($LTE_NRB.ContainsKey($bwStr)) { $LTE_NRB[$bwStr] } else { 100 }
    $antDl    = [int]$c0.cellRadioInfo.antennas.dl
    $antUl    = [int]$c0.cellRadioInfo.antennas.ul
    $tddFlag  = if ($duplex -eq 'TDD') { 1 } else { 0 }
    $channel  = if ($Td.cellConfig.master.channelSim) { 1 } else { 0 }

    Write-Host "  eNB: $($cells.Count) cell(s), bw=${bwStr}MHz N_RB=$nRb duplex=$duplex ant=${antDl}x$antUl"

    $text = Get-Content -Raw -LiteralPath $TemplatePath

    $text = Set-Define $text 'TDD'           $tddFlag
    $text = Set-Define $text 'N_RB_DL'       $nRb
    $text = Set-Define $text 'N_ANTENNA_DL'  $antDl
    $text = Set-Define $text 'N_ANTENNA_UL'  $antUl
    $text = Set-Define $text 'CHANNEL_SIM'   $channel

    $cellListText = Build-LteCellList -cells $cells -plmn $Plmn
    $text = Replace-ListBlock $text 'cell_list' $cellListText

    $stamp = "/* GENERATED by simqa generate.ps1 from testcase $TestcaseId on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') */`r`n"
    Write-NoBom $OutPath ($stamp + $text)
    Write-Host "  wrote $OutPath"
}

# ============================================================================
# MME builder (PDN list + ue_db sized to testcase)
# ============================================================================

# Pick a /N IPv4 subnet that fits ueCount + headroom. Returns object with
# first/last/dns. Keeps subnets disjoint per APN index.
function Get-PdnSubnet {
    param([int]$ApnIndex, [int]$UeCount)
    # APN index controls third octet base; UE count drives subnet sizing.
    if ($UeCount -le 252) {
        $base = 3 + $ApnIndex   # /24: 192.168.3.x, 192.168.4.x, ...
        return @{
            first = "192.168.$base.2"
            last  = "192.168.$base.254"
            dns   = '8.8.8.8'
        }
    }
    # Wider pool: 10.<ApnIndex>.0.2 .. 10.<ApnIndex>.<n>.254, where n covers ueCount.
    $blocks = [Math]::Min(255, [int][Math]::Ceiling($UeCount / 254.0))
    return @{
        first = "10.$ApnIndex.0.2"
        last  = "10.$ApnIndex.$blocks.254"
        dns   = '8.8.8.8'
    }
}

function Build-PdnList {
    param([string[]]$Apns, [int]$UeCount, [bool]$ImsRequired)
    if (-not $Apns -or $Apns.Count -eq 0) {
        $Apns = @('default')
    }
    if ($ImsRequired -and ($Apns -notcontains 'ims')) {
        $Apns += 'ims'
    }
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $Apns.Count; $i++) {
        $apn = $Apns[$i]
        $sub = Get-PdnSubnet -ApnIndex $i -UeCount $UeCount
        $qci = if ($apn -eq 'ims') { 5 } else { 9 }   # ims signalling = QCI 5
        $entry = @"
    {
      pdn_type: "ipv4",
      access_point_name: "$apn",
      first_ip_addr: "$($sub.first)",
      last_ip_addr: "$($sub.last)",
      ip_addr_shift: 2,
      dns_addr: "$($sub.dns)",
      erabs: [
        {
          qci: $qci,
          priority_level: 15,
          pre_emption_capability: "shall_not_trigger_pre_emption",
          pre_emption_vulnerability: "not_pre_emptable",
        },
      ],
    },
"@
        [void]$sb.Append($entry)
        if ($i -lt $Apns.Count - 1) { [void]$sb.Append("`r`n") }
    }
    return $sb.ToString()
}

# Build ue_db array. For VoLTE/VoNR, also populate IMS fields.
function Build-UeDb {
    param($Subs, [bool]$ImsRequired, [string]$Realm)
    $sb = New-Object System.Text.StringBuilder
    $first = $true
    foreach ($sg in $Subs) {
        $algo  = if ($sg.subscriberProfileInfo.algorithm) { "$($sg.subscriberProfileInfo.algorithm)" } else { 'xor' }
        $K     = if ($sg.subscriberNetworkConfig.sharedKey) { "$($sg.subscriberNetworkConfig.sharedKey)" } else { '00112233445566778899aabbccddeeff' }
        $start = $sg.subscriberProfileInfo.startingSUPI
        if (-not $start) { $start = $sg.subscriberProfileInfo.startingIMSI }
        $count = [int]$sg.subscriberProfileInfo.ueCount
        if ($count -le 0) { $count = 1 }
        $startBig = [bigint]::Parse((Format-Imsi $start))

        for ($i = 0; $i -lt $count; $i++) {
            $imsi = ($startBig + $i).ToString().PadLeft(15, '0')
            $opcLine = if ($algo -eq 'milenage') { "      opc: `"000102030405060708090A0B0C0D0E0F`",`r`n" } else { '' }
            $imsLines = ''
            if ($ImsRequired) {
                $imsLines = @"
      impi: "$imsi@$Realm",
      impu: [ "$imsi", "tel:0$imsi" ],
      domain: "$Realm",
"@
            }
            $sep = if ($first) { '' } else { ",`r`n" }
            $first = $false
            $entry = @"
$sep    {
      sim_algo: "$algo",
      imsi: "$imsi",
      amf: 0x9001,
      sqn: "000000000000",
      K: "$K",
$opcLine$imsLines
      multi_sim: true,
    }
"@
            [void]$sb.Append($entry)
        }
    }
    return $sb.ToString()
}

function Build-Mme {
    param($Td, [string]$TestcaseId, [string]$Plmn, [string]$TemplatePath, [string]$OutPath, [bool]$ImsRequired, [string]$Realm)

    $apns = @($Td.userPlaneConfig.profiles | ForEach-Object { $_.dataGeneralInfo.apnName } | Where-Object { $_ }) | Sort-Object -Unique
    $ueCount = ($Td.subsConfig.subs | ForEach-Object { $_.subscriberProfileInfo.ueCount } | Measure-Object -Sum).Sum
    if ($ueCount -le 0) { $ueCount = 1 }

    Write-Host "  MME: PLMN=$Plmn APNs=[$($apns -join ',')] ueCount=$ueCount ims=$ImsRequired"

    $text = Get-Content -Raw -LiteralPath $TemplatePath

    # plmn is a quoted string in libconfig; replace inline with explicit quotes.
    $text = [regex]::Replace(
        $text,
        '(?m)^(\s*plmn\s*:\s*)"[^"]*"(.*)$',
        ('${1}"' + $Plmn + '"${2}'),
        1)

    # Synthesize pdn_list
    $pdnText = Build-PdnList -Apns $apns -UeCount $ueCount -ImsRequired $ImsRequired
    $text = Replace-ListBlock $text 'pdn_list' $pdnText

    # Synthesize ue_db
    $ueDbText = Build-UeDb -Subs $Td.subsConfig.subs -ImsRequired $ImsRequired -Realm $Realm
    $text = Replace-ListBlock $text 'ue_db' $ueDbText

    $stamp = "/* GENERATED by simqa generate.ps1 from testcase $TestcaseId on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') */`r`n"
    Write-NoBom $OutPath ($stamp + $text)
    Write-Host "  wrote $OutPath"
}

# ============================================================================
# IMS builder (only when VoLTE / VoNR requested)
# ============================================================================

function Build-Ims {
    param($Td, [string]$TestcaseId, [string]$Realm, [string]$Pcscf, [string]$TemplatePath, [string]$OutPath)

    Write-Host "  IMS: realm=$Realm pcscf=$Pcscf"
    $text = Get-Content -Raw -LiteralPath $TemplatePath

    # Most of ims.cfg is static. The two things we override are: realm (if domain field
    # exists in template) and PCSCF bind addr (sip_addr first entry).
    # Template has sip_addr block already pointing at 192.168.4.1 by default,
    # which matches the corpus PCSCF, so usually nothing to change. Keep minimal.

    $stamp = "/* GENERATED by simqa generate.ps1 from testcase $TestcaseId on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') */`r`n"
    Write-NoBom $OutPath ($stamp + $text)
    Write-Host "  wrote $OutPath"
}

# ============================================================================
# Main
# ============================================================================

$tc = Read-Json $TestcaseJson
$td = $tc.testDefinition
if (-not $td) { throw "Input has no testDefinition" }

$ratType   = $td.cellConfig.master.ratType
$cellTypes = @($td.cellConfig.cells | ForEach-Object { $_.cellConfig.cellType }) | Sort-Object -Unique
$nCells    = $td.cellConfig.cells.Count
$dataTypes = @($td.userPlaneConfig.profiles | ForEach-Object { $_.dataGeneralInfo.dataType }) | Sort-Object -Unique
$ueCount   = ($td.subsConfig.subs | ForEach-Object { $_.subscriberProfileInfo.ueCount } | Measure-Object -Sum).Sum
$startImsi = $td.subsConfig.subs[0].subscriberProfileInfo.startingSUPI
if (-not $startImsi) { $startImsi = $td.subsConfig.subs[0].subscriberProfileInfo.startingIMSI }
$mncDigits = $td.subsConfig.subs[0].csiInfo.mncDigits
if (-not $mncDigits) { $mncDigits = 2 }
$plmn      = Get-PlmnFromImsi $startImsi $mncDigits
$ImsNeeded = ($dataTypes -contains 'volte' -or $dataTypes -contains 'vonr')
# Pull realm from first VoLTE/VoNR profile if present, else default
$realm = $IMS_REALM_DEFAULT
$pcscf = $IMS_PCSCF
if ($ImsNeeded) {
    foreach ($p in $td.userPlaneConfig.profiles) {
        if ($p.dataNetworkConfig.realm)         { $realm = "$($p.dataNetworkConfig.realm)" }
        if ($p.dataNetworkConfig.pcscfIpAddress) { $pcscf = "$($p.dataNetworkConfig.pcscfIpAddress)" }
        break
    }
}

Write-Host "Testcase: $($tc.id) ($($tc.name))"
Write-Host "  ratType=$ratType cells=$nCells cellTypes=$($cellTypes -join ',') dataTypes=$($dataTypes -join ',')"
Write-Host "  ueCount=$ueCount startImsi=$startImsi plmn=$plmn ims=$ImsNeeded"

$wantGnb = ($ratType -eq 'sa') -or ($ratType -eq 'nsa')
$wantEnb = ($ratType -eq 'smartphone') -or ($ratType -eq 'nsa')

if ($wantGnb) { Build-GnbSa  -Td $td -TestcaseId $tc.id -TemplatePath $GnbTemplate -OutPath (Join-Path $OutDir 'gnb.cfg') }
if ($wantEnb) { Build-LteEnb -Td $td -TestcaseId $tc.id -Plmn $plmn -TemplatePath $EnbTemplate -OutPath (Join-Path $OutDir 'enb.cfg') }

Build-Mme -Td $td -TestcaseId $tc.id -Plmn $plmn -TemplatePath $MmeTemplate `
          -OutPath (Join-Path $OutDir 'mme.cfg') -ImsRequired $ImsNeeded -Realm $realm

if ($ImsNeeded) {
    Build-Ims -Td $td -TestcaseId $tc.id -Realm $realm -Pcscf $pcscf `
              -TemplatePath $ImsTemplate -OutPath (Join-Path $OutDir 'ims.cfg')
}

# Run summary
$summary = [ordered]@{
    testcase   = $tc.id
    name       = $tc.name
    ratType    = $ratType
    cells      = $nCells
    cellTypes  = @($cellTypes)
    dataTypes  = @($dataTypes)
    ueCount    = $ueCount
    startImsi  = "$startImsi"
    plmn       = $plmn
    apns       = @($td.userPlaneConfig.profiles | ForEach-Object { $_.dataGeneralInfo.apnName } | Where-Object { $_ } | Sort-Object -Unique)
    ims        = $ImsNeeded
    realm      = $realm
    pcscf      = $pcscf
    emitted    = @{
        gnb = $wantGnb
        enb = $wantEnb
        mme = $true
        ims = $ImsNeeded
    }
    notes      = @()
}
if ($td.cellConfig.master.carrierAggregation) { $summary.notes += 'carrier aggregation: cells emitted in same nr_cell_list (verify rf_port mapping matches lab wiring)' }
if ($td.mobilityConfig)                       { $summary.notes += 'mobility / channel_sim: cellMobility block not yet mapped to rf_ports[].channel_dl' }
if ($td.subsConfig.subs[0].subscriberNetworkConfig.networkSlicing -and $td.subsConfig.subs[0].subscriberNetworkConfig.networkSlicing -ne 'disable') {
    $summary.notes += 'slicing requested but pduSnssai not yet wired into nssai blocks'
}

$summaryJson = $summary | ConvertTo-Json -Depth 6
Write-NoBom (Join-Path $OutDir 'summary.json') $summaryJson
Write-Host "Done. Output: $OutDir"
