# Termora MSIX Packaging

This directory contains the CI-driven MSIX packaging path for the Tauri desktop client.

The package is built with the GA Windows SDK tool `MakeAppx.exe`, discovered at runtime on the `windows-latest` GitHub Actions runner. The preview `winapp` CLI is not used.

## Current Flow

- `.github/workflows/build.yml` builds the Windows desktop target, runs `pack-msix.ps1 -SkipBuild`, and uploads `desktop-msix-x86_64-pc-windows-msvc`.
- A manual `ci.yml` dispatch produces the unsigned `.msix` artifact through the reusable build workflow.
- `.github/workflows/release.yml` builds the same unsigned `.msix` during the Windows desktop release job and uploads it to the GitHub Release with the existing desktop installers.
- There is no signing step and no Store submission step in CI.

## Package Inputs

- `Package.appxmanifest` is the source full-trust packaged desktop manifest.
- The staging layout under `msix/out/stage` uses `AppxManifest.xml`, which is the manifest filename expected by `MakeAppx.exe`.
- The script resolves the desktop executable from `packages/clients/desktop/src-tauri/Cargo.toml` (`[package] name`) and stages it next to the sidecars.
- The Windows target is x64-only: `x86_64-pc-windows-msvc`.
- The staged package contains the desktop executable, `termora-hub.exe`, `termora-agent.exe`, required DLLs, and the Store logo assets from `src-tauri/icons`.
- Before packing, the script fails closed if any staged executable is not a 64-bit PE file.
- Before packing, the script also fails closed if `termora-hub.exe` or `termora-agent.exe` reports a strict `x.y.z` version that does not match the first three components of the MSIX package version.

The source sidecars must exist before packaging:

```text
packages\clients\desktop\src-tauri\termora-hub-x86_64-pc-windows-msvc.exe
packages\clients\desktop\src-tauri\termora-agent-x86_64-pc-windows-msvc.exe
```

The CI desktop job places those files from the Windows hub and agent artifacts before it invokes the MSIX script.

## Local Packaging

Local packaging is optional; CI is the primary path.

Run on Windows with Node, Rust, pnpm dependencies, and the Windows SDK installed. `MakeAppx.exe` may be on `PATH`, or under the Windows Kits `10\bin\<version>\x64` directory.

Build and place the Windows sidecars first:

```powershell
.\scripts\build-agent.ps1
.\scripts\build-hub.ps1

Copy-Item .\dist\sea\termora-agent.exe .\packages\clients\desktop\src-tauri\termora-agent-x86_64-pc-windows-msvc.exe -Force
Copy-Item .\dist\sea\termora-hub.exe .\packages\clients\desktop\src-tauri\termora-hub-x86_64-pc-windows-msvc.exe -Force
```

Then package:

```powershell
.\packages\clients\desktop\msix\pack-msix.ps1
```

The output is unsigned:

```text
packages\clients\desktop\msix\out\Termora_<version>_x64.msix
```

If a locally installable smoke-test package is needed, sign the generated MSIX outside this script with a certificate-store or other non-argv secret workflow.

## CI Validation Checklist

Validate these points on the next Windows CI dispatch or release run:

1. `pack-msix.ps1` discovers the preinstalled `MakeAppx.exe`.
2. `msix/out/stage/AppxManifest.xml` exists and names the resolved desktop executable.
3. The staged desktop executable, hub sidecar, and agent sidecar all pass the x64 PE check.
4. The sidecar version gate passes for `termora-hub.exe` and `termora-agent.exe`.
5. `MakeAppx.exe pack /d ... /p ... /o` writes `Termora_<version>.0_x64.msix`.
6. Manual `ci.yml` dispatch exposes the `desktop-msix-x86_64-pc-windows-msvc` artifact.
7. Release runs upload the `.msix` asset alongside the existing desktop installers.

## Later: Manual Partner Center Submission

Store submission is deferred and remains manual.

When ready:

1. Create or open the app in Partner Center and reserve the product name.
2. Copy the Package/Identity values from Partner Center into `pack-msix.ps1` parameters:

```powershell
.\packages\clients\desktop\msix\pack-msix.ps1 `
  -IdentityName "TODO-FROM-PARTNER-CENTER" `
  -Publisher "CN=TODO-FROM-PARTNER-CENTER" `
  -PublisherDisplayName "TODO Publisher Display Name"
```

3. Submit the unsigned `.msix` manually in Partner Center. Microsoft Store re-signs the package during ingestion.
4. In certification notes, explain `runFullTrust`: Termora is a developer terminal app that launches its packaged local hub and agent sidecars, listens only on localhost for its UI transport, and manages user-initiated terminal/SSH session subprocesses.
5. Attach Windows App Certification Kit results and document any accepted full-trust warnings.
