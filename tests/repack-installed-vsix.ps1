# Rebuild a .vsix from an installed VS Code extension folder.
# Restores an artifact deleted from the repo root. The installed folder retains
# .vsixmanifest, so only [Content_Types].xml must be synthesized.
#
# Entries are written explicitly with forward slashes — .NET Framework's
# ZipFile.CreateFromDirectory emits backslash entry names on Windows, which
# produces a VSIX that VS Code cannot read.
param(
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$OutFile
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$SourceDir = (Resolve-Path $SourceDir).Path
$manifest = Join-Path $SourceDir ".vsixmanifest"
if (-not (Test-Path $manifest)) { throw "no .vsixmanifest in $SourceDir" }

$files = Get-ChildItem $SourceDir -Recurse -File
$exts = $files | ForEach-Object { $_.Extension.TrimStart(".").ToLower() } |
  Where-Object { $_ } | Sort-Object -Unique
$known = @{
  "json" = "application/json"; "js" = "application/javascript"; "map" = "application/json"
  "md" = "text/markdown"; "txt" = "text/plain"; "html" = "text/html"; "css" = "text/css"
  "svg" = "image/svg+xml"; "png" = "image/png"; "jpg" = "image/jpeg"; "jpeg" = "image/jpeg"
  "gif" = "image/gif"; "ico" = "image/vnd.microsoft.icon"; "vsixmanifest" = "text/xml"
  "xml" = "text/xml"; "ts" = "application/typescript"; "yml" = "text/plain"; "yaml" = "text/plain"
}
$allExts = @($exts) + @("vsixmanifest", "xml") | Sort-Object -Unique
$defaults = foreach ($e in $allExts) {
  $ct = if ($known.ContainsKey($e)) { $known[$e] } else { "application/octet-stream" }
  '  <Default Extension="{0}" ContentType="{1}" />' -f $e, $ct
}
$ctXml = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
$($defaults -join "`n")
</Types>
"@

if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
$fs = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)

function Add-Entry($Archive, $Name, $FilePath) {
  $entry = $Archive.CreateEntry($Name, [System.IO.Compression.CompressionLevel]::Optimal)
  $out = $entry.Open()
  $in = [System.IO.File]::OpenRead($FilePath)
  $in.CopyTo($out)
  $in.Dispose(); $out.Dispose()
}
function Add-Text($Archive, $Name, $Text) {
  $entry = $Archive.CreateEntry($Name, [System.IO.Compression.CompressionLevel]::Optimal)
  $sw = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
  $sw.Write($Text); $sw.Dispose()
}

Add-Text  $zip "[Content_Types].xml" $ctXml
Add-Entry $zip "extension.vsixmanifest" $manifest
$added = 0
foreach ($f in $files) {
  if ($f.FullName -eq $manifest) { continue }
  $rel = $f.FullName.Substring($SourceDir.Length).TrimStart("\", "/").Replace("\", "/")
  Add-Entry $zip "extension/$rel" $f.FullName
  $added++
}
$zip.Dispose(); $fs.Dispose()

$check = [System.IO.Compression.ZipFile]::OpenRead($OutFile)
$names = @($check.Entries | ForEach-Object { $_.FullName })
$check.Dispose()
"wrote   : $OutFile"
"entries : $($names.Count)  (payload files: $added)"
foreach ($req in @("[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/out/extension.js")) {
  "{0,-30} {1}" -f $req, ($names -contains $req)
}
"backslash entry names   : {0}" -f [bool]($names | Where-Object { $_ -like "*\*" })
