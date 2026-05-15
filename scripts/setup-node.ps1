$ErrorActionPreference = "Stop"

$NodeVersion = "v22.11.0"
$Arch = "win-x64"
$BaseName = "node-$NodeVersion-$Arch"
$ZipName = "$BaseName.zip"
$Url = "https://nodejs.org/dist/$NodeVersion/$ZipName"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$NodeDir = Join-Path $Root ".node"

if (Test-Path (Join-Path $NodeDir "node.exe")) {
    Write-Host "Node already installed at $NodeDir"
    exit 0
}

New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
$ZipPath = Join-Path $env:TEMP $ZipName

Write-Host "Downloading $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

Write-Host "Extracting ..."
$Staging = Join-Path $env:TEMP "takeshicc-node-extract"
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $Staging -Force

$Extracted = Join-Path $Staging $BaseName
Get-ChildItem -Force $Extracted | Move-Item -Destination $NodeDir

Remove-Item $Staging -Recurse -Force
Remove-Item $ZipPath -Force

Write-Host "Node $NodeVersion installed to $NodeDir"
Write-Host "Use: .\.node\node.exe and .\.node\npm.cmd"
