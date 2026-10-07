# Extract plain text from a .docx into a UTF-8 .txt, preserving table structure.
#
# Tables matter here: the character sheets are Word tables, so </w:tc> becomes a
# TAB and </w:tr> becomes a newline -> the result reads as TSV.
#
# Usage: pwsh -File tools/extract-docx.ps1 -In <docx> -Out <txt>

param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path -LiteralPath $In)) { throw "not found: $In" }

$zip = [System.IO.Compression.ZipFile]::OpenRead($In)
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
  if (-not $entry) { throw "word/document.xml not found in $In" }

  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  try { $xml = $sr.ReadToEnd() } finally { $sr.Dispose() }
} finally {
  $zip.Dispose()
}

Write-Host ("document.xml chars: {0}" -f $xml.Length)

# Block level first, then inline. Order matters.
$t = $xml
$t = $t -replace '<w:tab\s*/>', "`t"
$t = $t -replace '<w:br\s*/>', "`n"
$t = $t -replace '<w:cr\s*/>', "`n"
$t = $t -replace '</w:tc>', "`t"
$t = $t -replace '</w:tr>', "`n"
$t = $t -replace '</w:p>', "`n"

# Drop everything that is still a tag.
$t = $t -replace '<[^>]+>', ''

# XML entities.
$t = $t -replace '&lt;', '<'
$t = $t -replace '&gt;', '>'
$t = $t -replace '&quot;', '"'
$t = $t -replace '&apos;', "'"
$t = $t -replace '&amp;', '&'

# Trim trailing whitespace per line, drop runs of blank lines.
$lines = $t -split "`n" | ForEach-Object { ($_ -replace "[ `t]+$", '') }
$outLines = New-Object System.Collections.Generic.List[string]
$blank = 0
foreach ($l in $lines) {
  if ($l -eq '') { $blank++; if ($blank -gt 1) { continue } } else { $blank = 0 }
  $outLines.Add($l)
}

$text = ($outLines -join "`n")
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("wrote {0} chars, {1} lines -> {2}" -f $text.Length, $outLines.Count, $Out)
