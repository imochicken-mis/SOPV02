# Renders the drawn diagrams in a Word file (shapes, flowcharts, org charts, SmartArt, charts)
# to PNG images using Microsoft Word, and saves a COPY of the document where each diagram is
# replaced by a marker paragraph [[DIAGRAM-n]]. The original file is never modified.
#
#   powershell -STA -File word-diagrams.ps1 -Src <file.docx> -OutDir <folder>
# Output: <OutDir>\prepared.docx, <OutDir>\diagram-<n>.png
param([Parameter(Mandatory)][string]$Src, [Parameter(Mandatory)][string]$OutDir)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$prepared = Join-Path $OutDir "prepared.docx"

function Save-ClipboardPng([string]$path) {
  Start-Sleep -Milliseconds 150
  $data = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($data -and $data.GetDataPresent("PNG")) {
    $ms = $data.GetData("PNG"); $bytes = $ms.ToArray(); [IO.File]::WriteAllBytes($path, $bytes); return $true
  }
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); return $true }
  return $false
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false; $word.DisplayAlerts = 0
try {
  $orig = $word.Documents.Open($Src, $false, $true)
  $orig.SaveAs2($prepared, 16); $orig.Close($false)       # work on a copy only
  $doc = $word.Documents.Open($prepared)

  # ---- 1. Floating shapes, clustered into diagrams (same page + touching/overlapping boxes) ----
  $items = @()
  for ($i = 1; $i -le $doc.Shapes.Count; $i++) {
    $s = $doc.Shapes.Item($i)
    $items += [pscustomobject]@{
      Name = $s.Name; Page = [int]$s.Anchor.Information(3); RelV = $s.RelativeVerticalPosition
      L = [double]$s.Left; T = [double]$s.Top; R = [double]($s.Left + $s.Width); B = [double]($s.Top + $s.Height)
      Special = ($s.Type -in 3, 6, 20, 24) -or $s.HasSmartArt -or $s.HasChart   # chart, group, canvas, SmartArt
      Start = [int]$s.Anchor.Start; Cluster = -1
    }
  }
  $gap = 36
  $clusters = @()
  foreach ($it in $items) {
    $hit = $null
    foreach ($c in $clusters) {
      if ($c.Page -ne $it.Page) { continue }
      foreach ($m in $c.Members) {
        $sameFrame = $m.RelV -eq $it.RelV
        $touch = $sameFrame -and ($it.L -lt $m.R + $gap) -and ($it.R -gt $m.L - $gap) -and ($it.T -lt $m.B + $gap) -and ($it.B -gt $m.T - $gap)
        if ($touch -or -not $sameFrame) { $hit = $c; break }
      }
      if ($hit) { break }
    }
    if ($hit) { $hit.Members += $it } else { $clusters += [pscustomobject]@{ Page = $it.Page; Members = @($it) } }
  }
  # Only real diagrams: 2+ shapes, or a group/canvas/SmartArt/chart. A lone text box stays as text.
  $diagrams = @($clusters | Where-Object { $_.Members.Count -ge 2 -or ($_.Members | Where-Object Special) } |
    Sort-Object { ($_.Members | Measure-Object Start -Minimum).Minimum } -Descending)

  $n = $diagrams.Count
  $made = 0
  foreach ($c in $diagrams) {
    $id = $n - $made; $made++
    $names = [string[]]($c.Members | ForEach-Object Name)
    $first = $c.Members | Sort-Object Start | Select-Object -First 1
    $range = $doc.Shapes.Range($names)
    $target = $range
    if ($names.Count -gt 1) { try { $target = $range.Group() } catch { $target = $range } }
    $anchorPara = $doc.Shapes.Item($names[0]).Anchor.Paragraphs.Item(1).Range
    $ok = $false
    try {
      [System.Windows.Forms.Clipboard]::Clear()
      $target.Select(); $word.Selection.CopyAsPicture()
      $ok = Save-ClipboardPng (Join-Path $OutDir "diagram-$id.png")
      if (-not $ok) { $word.Selection.Copy(); $ok = Save-ClipboardPng (Join-Path $OutDir "diagram-$id.png") }
    } catch { $ok = $false }
    if ($ok) {
      $target.Delete()
      $anchorPara.InsertParagraphBefore()
      $doc.Range($anchorPara.Start - 1, $anchorPara.Start - 1).InsertAfter("[[DIAGRAM-$id]]")
      Write-Output "diagram-$id page $($c.Page) shapes $($names.Count)"
    } else { Write-Output "skip diagram on page $($c.Page) (could not copy)" }
  }

  # ---- 2. Inline SmartArt / charts ----
  for ($i = $doc.InlineShapes.Count; $i -ge 1; $i--) {
    $s = $doc.InlineShapes.Item($i)
    if (-not ($s.HasSmartArt -or $s.HasChart)) { continue }
    $made++; $id = "i$made"
    [System.Windows.Forms.Clipboard]::Clear()
    $s.Range.Select(); $word.Selection.CopyAsPicture()
    if (Save-ClipboardPng (Join-Path $OutDir "diagram-$id.png")) {
      $r = $s.Range; $s.Delete(); $r.InsertAfter("[[DIAGRAM-$id]]")
      Write-Output "diagram-$id inline"
    }
  }
  $doc.Save(); $doc.Close($false)
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
