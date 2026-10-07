# Map each embedded image in a .docx to the text that surrounds it, and optionally
# dump the images out.
#
# Why: the character sheet is 29 MB of which ~28 MB is pictures. Knowing WHICH
# picture belongs to WHICH character is what makes them usable as ball stickers,
# and that mapping only exists in the document's own ordering.
#
# Usage: & tools/docx-media-map.ps1 -In <docx> -OutDir <dir> [-Map <tsv>]

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Map = ''
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead($In)
try {
  function Read-Entry($name) {
    $e = $script:zip.Entries | Where-Object { $_.FullName -eq $name }
    if (-not $e) { return $null }
    $sr = New-Object System.IO.StreamReader($e.Open(), [System.Text.Encoding]::UTF8)
    try { return $sr.ReadToEnd() } finally { $sr.Dispose() }
  }

  # rId -> media file name
  $relsXml = Read-Entry 'word/_rels/document.xml.rels'
  $relMap = @{}
  foreach ($m in [regex]::Matches($relsXml, '<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"')) {
    $relMap[$m.Groups[1].Value] = $m.Groups[2].Value
  }
  Write-Host ("relationships: {0}" -f $relMap.Count)

  $doc = Read-Entry 'word/document.xml'

  # Walk the document in order, collecting text runs and image references.
  $items = New-Object System.Collections.Generic.List[object]
  $rx = [regex]'<w:t[^>]*>(.*?)</w:t>|<a:blip[^>]*r:embed="([^"]+)"|<w:p[ >]|</w:p>'
  foreach ($m in $rx.Matches($doc)) {
    if ($m.Groups[1].Success) {
      $items.Add([pscustomobject]@{ kind = 'text'; v = $m.Groups[1].Value })
    } elseif ($m.Groups[2].Success) {
      $items.Add([pscustomobject]@{ kind = 'img'; v = $m.Groups[2].Value })
    } elseif ($m.Value -eq '</w:p>') {
      $items.Add([pscustomobject]@{ kind = 'para'; v = '' })
    }
  }
  Write-Host ("ordered items: {0}" -f $items.Count)

  # Build paragraphs, then attach each image to the text of its own paragraph
  # plus the nearest heading before it.
  $paras = New-Object System.Collections.Generic.List[object]
  $cur = New-Object System.Collections.Generic.List[object]
  foreach ($it in $items) {
    if ($it.kind -eq 'para') { $paras.Add($cur); $cur = New-Object System.Collections.Generic.List[object] }
    else { $cur.Add($it) }
  }
  if ($cur.Count) { $paras.Add($cur) }

  if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

  $rows = New-Object System.Collections.Generic.List[string]
  $rows.Add("idx`tmedia`tparagraph_text`tnearest_heading")
  $lastHeading = ''
  $n = 0
  foreach ($p in $paras) {
    $txt = (($p | Where-Object { $_.kind -eq 'text' } | ForEach-Object { $_.v }) -join '')
    # Heading heuristic: a short line with no sentence punctuation.
    # NOTE: Windows PowerShell 5.1 reads .ps1 files as ANSI, so ANY non-ASCII
    # literal here would arrive mangled (this bit us once already). The CJK
    # punctuation is therefore written as \uXXXX escapes:
    #   U+3002 。  U+FF1A ：  U+FF0C ，
    if ($txt.Length -gt 0 -and $txt.Length -lt 40 -and $txt -notmatch '[\u3002\uff1a\uff0c]') { $lastHeading = $txt }
    foreach ($it in $p) {
      if ($it.kind -ne 'img') { continue }
      $n++
      $media = $relMap[$it.v]
      if (-not $media) { continue }
      $leaf = Split-Path -Leaf $media
      $dest = Join-Path $OutDir $leaf
      if (-not (Test-Path -LiteralPath $dest)) {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq ("word/" + $media) }
        if ($entry) {
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
        }
      }
      $rows.Add(("{0}`t{1}`t{2}`t{3}" -f $n, $leaf, ($txt -replace "`t", ' '), ($lastHeading -replace "`t", ' ')))
    }
  }
  if ($Map) { [System.IO.File]::WriteAllLines($Map, $rows, (New-Object System.Text.UTF8Encoding($false))) }
  Write-Host ("images extracted: {0} -> {1}" -f $n, $OutDir)
  if ($Map) { Write-Host ("map written: {0}" -f $Map) }
} finally { $zip.Dispose() }
