# Mines the Simnovus cfg corpus to surface parameter axes.
# Output: simqa/output/corpus-catalog.json with per-role parameter value sets.

param(
    [string]$EnbDir = "C:\Users\nikku\Documents\projects\simqa\callbox_configs\extracted",
    [string]$MmeDir = "C:\Users\nikku\Documents\projects\simqa\mme_ims_configs\extracted",
    [string]$OutFile = "C:\Users\nikku\Documents\projects\simqa\output\corpus-catalog.json"
)

$ErrorActionPreference = "Stop"

function Get-CfgRole {
    param([string]$Path)
    $name = [IO.Path]::GetFileName($Path).ToLower()
    if ($name -match 'gnb')   { return 'gnb' }
    if ($name -match 'enb')   { return 'enb' }
    if ($name -match 'mme')   { return 'mme' }
    if ($name -match 'ims')   { return 'ims' }
    if ($name -match '_db|ue_db') { return 'ue_db' }
    return 'unknown'
}

# Skip noise: backups, tmps, non-config artifacts.
function Test-NoiseFile {
    param([string]$Path)
    $name = [IO.Path]::GetFileName($Path)
    if ($name -match '\.(bak|asn|tle|sh|pem|pcap|sdp|xml|db|json|txt|zip|sh.bak)$') { return $true }
    if ($name -match '^tmp') { return $true }
    if ($name -match '~$') { return $true }
    if ($name -match '_nik$|_Nik$') { return $true }
    return $false
}

function Get-CfgFiles {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return @() }
    return Get-ChildItem -Path $Dir -Recurse -File |
        Where-Object { -not (Test-NoiseFile $_.FullName) } |
        Where-Object { $_.Extension -eq '.cfg' }
}

# Strip C-style comments to avoid false matches in commented-out lines.
function Get-StrippedText {
    param([string]$Text)
    # Remove /* ... */ block comments (multiline, non-greedy).
    $t = [regex]::Replace($Text, '/\*[\s\S]*?\*/', '')
    # Remove // line comments.
    $t = [regex]::Replace($t, '//[^\n]*', '')
    return $t
}

function Add-Value {
    param([hashtable]$Bag, [string]$Key, $Val)
    if ([string]::IsNullOrWhiteSpace($Val)) { return }
    if (-not $Bag.ContainsKey($Key)) { $Bag[$Key] = New-Object 'System.Collections.Generic.HashSet[string]' }
    [void]$Bag[$Key].Add($Val.ToString().Trim())
}

function Mine-Cfg {
    param([string]$Path, [hashtable]$Bag)
    $raw = Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $raw) { return }
    $text = Get-StrippedText $raw

    # Top-of-file #define toggles (the primary knobs).
    foreach ($m in [regex]::Matches($text, '(?m)^\s*#define\s+(\w+)\s+([^\s/]+)')) {
        Add-Value $Bag "define:$($m.Groups[1].Value)" $m.Groups[2].Value
    }

    # libconfig key:value lines (only simple scalars; arrays/objects skipped).
    $patterns = @(
        'plmn',                  'mcc',                  'mnc',
        'dl_earfcn',             'ul_earfcn',
        'dl_nr_arfcn',           'ssb_nr_arfcn',
        'band',                  'nr_band',
        'n_rb_dl',               'n_rb_ul',
        'n_antenna_dl',          'n_antenna_ul',
        'tac',                   'cell_id',              'n_id_cell',
        'mme_group_id',          'mme_code',
        'uldl_config',           'sp_config',
        'cyclic_prefix',         'duplex_mode',
        'subcarrier_spacing',    'scs',
        'enb_id',                'gnb_id',
        'mcc_length',            'mnc_length',
        'access_point_name',     'apn',
        'pdn_type',
        'root_sequence_index'
    )
    foreach ($key in $patterns) {
        $rx = "(?m)^\s*$key\s*:\s*""?([^,;""\r\n]+)""?"
        foreach ($m in [regex]::Matches($text, $rx)) {
            Add-Value $Bag "field:$key" $m.Groups[1].Value
        }
    }

    # Counts: how many cells in cell_list, mme_list, plmn_list, pdn_list (best-effort, brace count).
    foreach ($listName in @('cell_list','mme_list','amf_list','plmn_list','plmn_list_5gc','pdn_list','nssai')) {
        $rx = "$listName\s*:\s*\["
        $idx = [regex]::Match($text, $rx)
        if ($idx.Success) {
            # naive: count top-level commas at depth 0 inside the matching [...]
            $start = $idx.Index + $idx.Length
            $depth = 1; $i = $start; $items = 1
            while ($i -lt $text.Length -and $depth -gt 0) {
                $c = $text[$i]
                if ($c -eq '[' -or $c -eq '{') { $depth++ }
                elseif ($c -eq ']' -or $c -eq '}') { $depth-- ; if ($depth -eq 0) { break } }
                elseif ($c -eq ',' -and $depth -eq 1) { $items++ }
                $i++
            }
            # Heuristic: if list looked empty (no '{' before first ']'), zero it.
            $slice = $text.Substring($start, [Math]::Min(200, $text.Length - $start))
            if ($slice -notmatch '\{') { $items = 0 }
            Add-Value $Bag "count:$listName" $items
        }
    }
}

# ---------- main ----------
$catalog = @{
    enb   = @{}
    gnb   = @{}
    mme   = @{}
    ims   = @{}
    files = @{}
}

$enbFiles = Get-CfgFiles $EnbDir
$mmeFiles = Get-CfgFiles $MmeDir

Write-Host "enb/gnb dir: $($enbFiles.Count) files"
Write-Host "mme/ims dir: $($mmeFiles.Count) files"

foreach ($f in $enbFiles) {
    $role = Get-CfgRole $f.FullName
    if ($role -eq 'unknown') {
        # Peek inside: does it have amf_list (gNB / NG-eNB) or just mme_list?
        $head = Get-Content -LiteralPath $f.FullName -TotalCount 200 -ErrorAction SilentlyContinue
        $joined = ($head -join "`n").ToLower()
        if ($joined -match 'amf_list|nr_band|ssb_nr_arfcn|nr_cell_list')   { $role = 'gnb' }
        elseif ($joined -match 'mme_list|dl_earfcn|enb_id')                { $role = 'enb' }
        else { $role = 'enb' } # fallback: most are eNB-shaped
    }
    if (-not $catalog.ContainsKey($role)) { $catalog[$role] = @{} }
    Mine-Cfg $f.FullName $catalog[$role]
    $catalog.files["$role"] = ($catalog.files["$role"] + 1)
}

foreach ($f in $mmeFiles) {
    $role = Get-CfgRole $f.FullName
    if ($role -eq 'unknown' -or $role -eq 'ue_db') { $role = 'mme' }
    if (-not $catalog.ContainsKey($role)) { $catalog[$role] = @{} }
    Mine-Cfg $f.FullName $catalog[$role]
    $catalog.files["$role"] = ($catalog.files["$role"] + 1)
}

# Convert HashSets to sorted arrays (cap at 25 distinct values per key for readability).
$out = [ordered]@{}
$out.fileCounts = $catalog.files
foreach ($role in @('enb','gnb','mme','ims')) {
    if (-not $catalog.ContainsKey($role)) { continue }
    $roleOut = [ordered]@{}
    foreach ($key in ($catalog[$role].Keys | Sort-Object)) {
        $vals = @($catalog[$role][$key]) | Sort-Object
        if ($vals.Count -gt 25) {
            $roleOut[$key] = @{ count = $vals.Count; sample = $vals[0..24] }
        } else {
            $roleOut[$key] = @{ count = $vals.Count; values = $vals }
        }
    }
    $out[$role] = $roleOut
}

$json = $out | ConvertTo-Json -Depth 6
Set-Content -Path $OutFile -Value $json -Encoding utf8
Write-Host "wrote $OutFile"
