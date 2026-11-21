# Refuses unless each binary was built for the release channel (#1084): it must
# carry the marker lasterm-build-channel:release, which the build writes into
# the hub and the desktop, and not lasterm-build-channel:dev. A binary with no
# marker, older than the marker or built some other way, is refused too.
# Nothing is executed: the bytes are searched.
#
#   assert-release-binary.ps1 -Path <binary> [<binary>...]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$prefix = "lasterm-build-channel:"
foreach ($binary in $Path) {
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
    throw "Cannot check the build channel of a missing file: $binary"
  }
  # Latin-1 maps each byte to one character, so an ordinal search of the text
  # is a search of the bytes.
  $text = [System.Text.Encoding]::Latin1.GetString([System.IO.File]::ReadAllBytes($binary))
  $release = $text.Contains("${prefix}release", [System.StringComparison]::Ordinal)
  $dev = $text.Contains("${prefix}dev", [System.StringComparison]::Ordinal)
  if (-not $release -or $dev) {
    throw "$binary is not a release-channel build (marker ${prefix}release: $release, ${prefix}dev: $dev). Build it with LASTERM_CHANNEL=release."
  }
  Write-Host "Release channel marker found in $binary"
}
