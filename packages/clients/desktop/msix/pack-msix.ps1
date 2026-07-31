param(
  [string]$Configuration = "release",
  [string]$IdentityName,
  [string]$Publisher,
  [string]$PublisherDisplayName,
  [string]$Version,
  [string]$Output,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-PathStrict([string]$Path) {
  return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Convert-ToAppxVersion([string]$RawVersion) {
  $parts = $RawVersion.Split(".")
  if ($parts.Length -gt 4) {
    throw "MSIX version must have at most four numeric components: $RawVersion"
  }

  $normalized = @()
  foreach ($part in $parts) {
    if ($part -notmatch "^\d+$") {
      throw "MSIX version components must be numeric: $RawVersion"
    }
    $normalized += [string][int]$part
  }

  while ($normalized.Length -lt 4) {
    $normalized += "0"
  }

  return ($normalized -join ".")
}

function Convert-ToSidecarVersion([string]$RawVersion) {
  $appxVersion = Convert-ToAppxVersion $RawVersion
  $parts = $appxVersion.Split(".")
  if ([int]$parts[3] -ne 0) {
    throw "Sidecar version gate requires an MSIX version with a zero revision component because sidecars report strict x.y.z versions: $appxVersion"
  }

  return ($parts[0..2] -join ".")
}

function Set-ManifestValues(
  [string]$ManifestPath,
  [string]$IdentityName,
  [string]$Publisher,
  [string]$PublisherDisplayName,
  [string]$Version,
  [string]$Executable
) {
  [xml]$manifest = Get-Content -LiteralPath $ManifestPath -Raw
  $ns = New-Object System.Xml.XmlNamespaceManager($manifest.NameTable)
  $ns.AddNamespace("m", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")

  $identity = $manifest.SelectSingleNode("/m:Package/m:Identity", $ns)
  $properties = $manifest.SelectSingleNode("/m:Package/m:Properties", $ns)
  $application = $manifest.SelectSingleNode("/m:Package/m:Applications/m:Application", $ns)
  if ($null -eq $identity -or $null -eq $properties -or $null -eq $application) {
    throw "AppxManifest.xml is missing Identity, Properties, or Applications/Application."
  }

  if ($IdentityName) {
    $identity.SetAttribute("Name", $IdentityName)
  }
  if ($Publisher) {
    $identity.SetAttribute("Publisher", $Publisher)
  }
  if ($Version) {
    $identity.SetAttribute("Version", (Convert-ToAppxVersion $Version))
  }
  $identity.SetAttribute("ProcessorArchitecture", "x64")
  if ($PublisherDisplayName) {
    $publisherNode = $properties.SelectSingleNode("m:PublisherDisplayName", $ns)
    if ($null -eq $publisherNode) {
      throw "AppxManifest.xml is missing Properties/PublisherDisplayName."
    }
    $publisherNode.InnerText = $PublisherDisplayName
  }
  if ($Executable) {
    $application.SetAttribute("Executable", $Executable)
  }

  $settings = New-Object System.Xml.XmlWriterSettings
  $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
  $settings.Indent = $true
  $settings.NewLineChars = "`r`n"
  $writer = [System.Xml.XmlWriter]::Create($ManifestPath, $settings)
  try {
    $manifest.Save($writer)
  } finally {
    $writer.Dispose()
  }
}

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required file not found: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Resolve-MakeAppx {
  $command = Get-Command MakeAppx.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($programFilesX86) {
    $kitsRoot = Join-Path $programFilesX86 "Windows Kits\10\bin"
  } else {
    $kitsRoot = $null
  }

  if ($kitsRoot -and (Test-Path -LiteralPath $kitsRoot -PathType Container)) {
    $candidates = Get-ChildItem -LiteralPath $kitsRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        Join-Path $_.FullName "x64\MakeAppx.exe"
      } |
      Where-Object {
        Test-Path -LiteralPath $_ -PathType Leaf
      }

    $candidate = @($candidates) | Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }

  throw "MakeAppx.exe was not found. Run this script on windows-latest or a Windows machine with the Windows SDK installed."
}

function Get-CargoPackageName([string]$CargoTomlPath) {
  if (-not (Test-Path -LiteralPath $CargoTomlPath -PathType Leaf)) {
    throw "Cargo manifest not found: $CargoTomlPath"
  }

  $inPackage = $false
  foreach ($line in Get-Content -LiteralPath $CargoTomlPath) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[(.+)\]$') {
      $inPackage = ($matches[1] -eq "package")
      continue
    }
    if ($inPackage -and $trimmed -match '^name\s*=\s*"([^"]+)"') {
      return $matches[1]
    }
  }

  throw "Could not resolve [package] name from $CargoTomlPath"
}

function Resolve-DesktopExecutablePath(
  [string]$SrcTauriDir,
  [string]$TargetTriple,
  [string]$Configuration,
  [string]$BinaryName
) {
  $candidates = @(
    (Join-Path $SrcTauriDir "target\$TargetTriple\$Configuration\$BinaryName"),
    (Join-Path $SrcTauriDir "target\$Configuration\$BinaryName")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-PathStrict $candidate)
    }
  }

  throw "Could not find x64 desktop executable '$BinaryName'. Checked: $($candidates -join ', '). Build the x86_64-pc-windows-msvc target first, or rerun without -SkipBuild."
}

function Assert-PeMachineX64([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "PE sanity check failed because the file is missing: $Path"
  }

  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
      if ($reader.ReadUInt16() -ne 0x5A4D) {
        throw "PE sanity check failed for ${Path}: missing MZ header."
      }

      $stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
      $peOffset = $reader.ReadInt32()
      if ($peOffset -lt 0 -or $peOffset -gt ($stream.Length - 6)) {
        throw "PE sanity check failed for ${Path}: invalid PE header offset $peOffset."
      }

      $stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
      if ($reader.ReadUInt32() -ne 0x00004550) {
        throw "PE sanity check failed for ${Path}: missing PE signature."
      }

      $machine = $reader.ReadUInt16()
      if ($machine -ne 0x8664) {
        throw ("PE sanity check failed for {0}: machine 0x{1:X4}, expected x64/AMD64 0x8664." -f $Path, $machine)
      }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Invoke-NativeCapture(
  [string]$FilePath,
  [string[]]$Arguments,
  [int]$TimeoutSeconds = 15
) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " ")
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  try {
    if (-not $process.Start()) {
      throw "Failed to start $FilePath"
    }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill()
      throw "Timed out running $FilePath $($Arguments -join ' ')"
    }

    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StdOut = $process.StandardOutput.ReadToEnd()
      StdErr = $process.StandardError.ReadToEnd()
    }
  } finally {
    $process.Dispose()
  }
}

function Read-VersionFromOutput([string]$Output, [string]$BinaryName) {
  $match = [regex]::Match($Output, "\b(\d+\.\d+\.\d+)\b")
  if (-not $match.Success) {
    throw "Could not read $BinaryName version from output: $Output"
  }
  return $match.Groups[1].Value
}

function Assert-StagedSidecarVersions(
  [string]$StageDir,
  [string]$ExpectedVersion
) {
  $hubPath = Join-Path $StageDir "termora-hub.exe"
  $agentPath = Join-Path $StageDir "termora-agent.exe"
  foreach ($path in @($hubPath, $agentPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Staged sidecar is missing: $path"
    }
  }

  $agentResult = Invoke-NativeCapture -FilePath $agentPath -Arguments @("--version")
  if ($agentResult.ExitCode -ne 0) {
    throw "Staged termora-agent.exe --version failed with exit code $($agentResult.ExitCode): $($agentResult.StdErr)$($agentResult.StdOut)"
  }
  $agentVersion = Read-VersionFromOutput -Output "$($agentResult.StdOut)`n$($agentResult.StdErr)" -BinaryName "termora-agent.exe"
  if ($agentVersion -ne $ExpectedVersion) {
    throw "Staged termora-agent.exe version $agentVersion does not match packaged version $ExpectedVersion. Rebuild and restage the Windows sidecars before packing MSIX."
  }

  $hubResult = Invoke-NativeCapture -FilePath $hubPath -Arguments @("agent", "status", "--json")
  if ($hubResult.ExitCode -ne 0) {
    throw "Staged termora-hub.exe agent status --json failed with exit code $($hubResult.ExitCode): $($hubResult.StdErr)$($hubResult.StdOut)"
  }

  try {
    $snapshot = $hubResult.StdOut | ConvertFrom-Json
  } catch {
    throw "Staged termora-hub.exe returned invalid agent status JSON: $($hubResult.StdOut)"
  }

  if ($snapshot.hub_version -ne $ExpectedVersion) {
    throw "Staged termora-hub.exe version $($snapshot.hub_version) does not match packaged version $ExpectedVersion. Rebuild and restage the Windows sidecars before packing MSIX."
  }

  $bundled = @($snapshot.targets | Where-Object { $_.os -eq "windows" -and $_.arch -eq "x64" }) | Select-Object -First 1
  if (-not $bundled) {
    throw "Staged termora-hub.exe did not report a bundled agent row for windows/x64."
  }
  if ($bundled.status -ne "bundled") {
    throw "Staged termora-hub.exe reported windows/x64 sidecar status '$($bundled.status)', expected 'bundled'. Rebuild and restage the Windows sidecars before packing MSIX."
  }
  if ($bundled.version -ne $ExpectedVersion) {
    throw "Staged termora-hub.exe reports bundled agent version $($bundled.version), expected packaged version $ExpectedVersion. Rebuild and restage the Windows sidecars before packing MSIX."
  }

  Write-Host "Sidecar version gate passed: termora-hub.exe=$ExpectedVersion termora-agent.exe=$ExpectedVersion"
}

$scriptDir = Split-Path -Parent $PSCommandPath
$desktopDir = Resolve-PathStrict (Join-Path $scriptDir "..")
$srcTauriDir = Resolve-PathStrict (Join-Path $desktopDir "src-tauri")
$manifestPath = Resolve-PathStrict (Join-Path $scriptDir "Package.appxmanifest")
$cargoTomlPath = Resolve-PathStrict (Join-Path $srcTauriDir "Cargo.toml")
$stageDir = Join-Path $scriptDir "out\stage"
$assetsDir = Join-Path $stageDir "Assets"
$packageOutDir = Join-Path $scriptDir "out"
$windowsX64RustTarget = "x86_64-pc-windows-msvc"
$msixArch = "x64"
$makeAppx = Resolve-MakeAppx
$desktopBinaryName = "$(Get-CargoPackageName $cargoTomlPath).exe"

if (-not $Version) {
  $tauriConfigPath = Join-Path $srcTauriDir "tauri.conf.json"
  $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
  $Version = $tauriConfig.version
}
$appxVersion = Convert-ToAppxVersion $Version
$sidecarVersion = Convert-ToSidecarVersion $Version

if (-not $Output) {
  $Output = Join-Path $packageOutDir "Termora_$($appxVersion)_$msixArch.msix"
}

if (-not $SkipBuild) {
  Push-Location $desktopDir
  try {
    & pnpm tauri build --no-bundle --target $windowsX64RustTarget
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

$mainExe = Resolve-DesktopExecutablePath `
  -SrcTauriDir $srcTauriDir `
  -TargetTriple $windowsX64RustTarget `
  -Configuration $Configuration `
  -BinaryName $desktopBinaryName

$hubSidecar = Join-Path $srcTauriDir "termora-hub-$windowsX64RustTarget.exe"
$agentSidecar = Join-Path $srcTauriDir "termora-agent-$windowsX64RustTarget.exe"

Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stageDir, $assetsDir -Force | Out-Null
New-Item -ItemType Directory -Path $packageOutDir -Force | Out-Null

Copy-RequiredFile $mainExe (Join-Path $stageDir $desktopBinaryName)
Copy-RequiredFile $hubSidecar (Join-Path $stageDir "termora-hub.exe")
Copy-RequiredFile $agentSidecar (Join-Path $stageDir "termora-agent.exe")
Copy-RequiredFile $manifestPath (Join-Path $stageDir "AppxManifest.xml")

foreach ($exe in @($desktopBinaryName, "termora-hub.exe", "termora-agent.exe")) {
  Assert-PeMachineX64 (Join-Path $stageDir $exe)
}

Assert-StagedSidecarVersions `
  -StageDir $stageDir `
  -ExpectedVersion $sidecarVersion

Get-ChildItem -Path (Join-Path (Split-Path -Parent $mainExe) "*") -File -Include "*.dll" |
  Copy-Item -Destination $stageDir -Force

$iconDir = Join-Path $srcTauriDir "icons"
foreach ($asset in @("StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Square310x310Logo.png")) {
  Copy-RequiredFile (Join-Path $iconDir $asset) (Join-Path $assetsDir $asset)
}

Set-ManifestValues `
  -ManifestPath (Join-Path $stageDir "AppxManifest.xml") `
  -IdentityName $IdentityName `
  -Publisher $Publisher `
  -PublisherDisplayName $PublisherDisplayName `
  -Version $appxVersion `
  -Executable $desktopBinaryName

$packArgs = @(
  "pack",
  "/d",
  $stageDir,
  "/p",
  $Output,
  "/o"
)

Write-Host "Using MakeAppx.exe: $makeAppx"
Write-Host "Desktop executable: $desktopBinaryName ($mainExe)"

& $makeAppx @packArgs
if ($LASTEXITCODE -ne 0) {
  throw "MakeAppx pack failed with exit code $LASTEXITCODE."
}

$resolvedOutput = Resolve-PathStrict $Output
Write-Host "MSIX written to $resolvedOutput"
