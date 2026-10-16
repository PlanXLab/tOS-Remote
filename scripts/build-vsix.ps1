<#
.SYNOPSIS
    Node.js/vsce 없이 tOS Remote Marketplace 패키지(.vsix)를 만든다.

.DESCRIPTION
    package.json과 확장 소스를 VSIX로 묶는다. Node.js나 빌드 도구가 필요하지 않으며,
    생성된 파일은 Visual Studio Marketplace의 게시자 페이지에서 업로드할 수 있다.

.EXAMPLE
    .\scripts\build-vsix.ps1
    code --install-extension .\dist\tos-remote-0.5.2.vsix
#>
param(
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$ExtDir = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $ExtDir 'dist' }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$package = [IO.File]::ReadAllText((Join-Path $ExtDir 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$nls = [IO.File]::ReadAllText((Join-Path $ExtDir 'package.nls.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($key in @('displayName', 'description')) {
    $value = [string]$package.$key
    if ($value -match '^%(.+)%$') { $package.$key = [string]$nls.($Matches[1]) }
}
$enc = New-Object System.Text.UTF8Encoding($false)
function Esc([string]$text) { [Security.SecurityElement]::Escape($text) }

# 패키지에 넣을 파일 (상대 경로)
$files = New-Object System.Collections.Generic.List[string]
foreach ($name in @('package.json', 'package.nls.json', 'README.md', 'README.ko.md', 'CHANGELOG.md', 'CHANGELOG.ko.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt')) {
    if (Test-Path (Join-Path $ExtDir $name)) { $files.Add($name) }
}
Get-ChildItem $ExtDir -File -Filter 'package.nls.*.json' | ForEach-Object { $files.Add($_.Name) }
foreach ($dir in @('src', 'media', 'l10n')) {
    Get-ChildItem (Join-Path $ExtDir $dir) -Recurse -File | ForEach-Object {
        $files.Add($_.FullName.Substring($ExtDir.Length + 1).Replace('\', '/'))
    }
}

$assets = @('<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />')
if ($files.Contains('README.md')) { $assets += '<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />' }
if ($files.Contains('CHANGELOG.md')) { $assets += '<Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />' }
# 패키지 안의 경로(확장자 없는 LICENSE는 vsce처럼 LICENSE.txt로 넣는다)
function EntryName([string]$file) { if ($file -eq 'LICENSE') { 'LICENSE.txt' } else { $file } }
$license = $files | Where-Object { $_ -like 'LICENSE*' } | Select-Object -First 1
if ($license) { $assets += "<Asset Type=`"Microsoft.VisualStudio.Services.Content.License`" Path=`"extension/$(EntryName $license)`" Addressable=`"true`" />" }

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Esc $package.name)" Version="$(Esc $package.version)" Publisher="$(Esc $package.publisher)" />
    <DisplayName>$(Esc $package.displayName)</DisplayName>
    <Description xml:space="preserve">$(Esc $package.description)</Description>
    <Tags>$(Esc (($package.keywords) -join ','))</Tags>
    <Categories>$(Esc (($package.categories) -join ','))</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Esc $package.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    $($assets -join "`n    ")
  </Assets>
</PackageManifest>
"@
if ($package.icon) {
    $manifest = $manifest.Replace('    </Properties>', "    </Properties>`n    <Icon>extension/$($package.icon)</Icon>")
    $manifest = $manifest.Replace('  </Assets>', "    <Asset Type=`"Microsoft.VisualStudio.Services.Icons.Default`" Path=`"extension/$($package.icon)`" Addressable=`"true`" />`n  </Assets>")
}
if ($license) {
    $manifest = $manifest.Replace('    </Properties>', "    </Properties>`n    <License>extension/$(EntryName $license)</License>")
}

$contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension=".json" ContentType="application/json"/>' +
    '<Default Extension=".js" ContentType="application/javascript"/>' +
    '<Default Extension=".css" ContentType="text/css"/>' +
    '<Default Extension=".md" ContentType="text/markdown"/>' +
    '<Default Extension=".svg" ContentType="image/svg+xml"/>' +
    '<Default Extension=".png" ContentType="image/png"/>' +
    '<Default Extension=".txt" ContentType="text/plain"/>' +
    '<Default Extension=".vsixmanifest" ContentType="text/xml"/>' +
    '</Types>'

New-Item -ItemType Directory -Force $OutDir | Out-Null
$vsix = Join-Path $OutDir "$($package.name)-$($package.version).vsix"
if (Test-Path $vsix) { Remove-Item $vsix -Force }

$zip = [IO.Compression.ZipFile]::Open($vsix, [IO.Compression.ZipArchiveMode]::Create)
try {
    $write = {
        param([string]$entryName, [byte[]]$bytes)
        $stream = $zip.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal).Open()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    & $write '[Content_Types].xml' $enc.GetBytes($contentTypes)
    & $write 'extension.vsixmanifest' $enc.GetBytes($manifest)
    foreach ($file in $files) {
        & $write "extension/$(EntryName $file)" ([IO.File]::ReadAllBytes((Join-Path $ExtDir $file)))
    }
} finally {
    $zip.Dispose()
}

Write-Host "Created: $vsix ($($files.Count) files, $([int]((Get-Item $vsix).Length / 1KB)) KB)" -ForegroundColor Green
Write-Host 'Upload this VSIX from the Visual Studio Marketplace publisher page.' -ForegroundColor Green
