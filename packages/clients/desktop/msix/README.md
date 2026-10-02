# Lasterm MSIX Packaging

This directory contains the CI-driven MSIX packaging path for the Tauri desktop client.

The package is built with the GA Windows SDK tool `MakeAppx.exe`, discovered at runtime on the `windows-latest` GitHub Actions runner. The preview `winapp` CLI is not used.

## Current Flow

- `.github/workflows/build.yml` builds the Windows desktop executable with `tauri build --no-bundle` and runs `pack-msix.ps1 -SkipBuild`. When MSIX packaging is enabled (the three `MSIX_*` repository variables are set), it uploads the package as the `msix-x86_64-pc-windows-msvc` artifact, a tar holding the `.msix`, kept 30 days on a release.
- A manual `ci.yml` dispatch produces that artifact through the same reusable build workflow.
- `.github/workflows/release.yml` calls the same build workflow. This unsigned `.msix` is never uploaded to the GitHub Release, and the release workflow publishes no desktop installer; only the package the Store signs may join a release after certification (STORE-ONLY-DESKTOP in `docs/decisions.md`).
- There is no signing step: the Microsoft Store signs the package. CI has no Store submission step yet (#619).

## Package Inputs

- `Package.appxmanifest` is the source full-trust packaged desktop manifest.
- The staging layout under `msix/out/stage` uses `AppxManifest.xml`, which is the manifest filename expected by `MakeAppx.exe`.
- The script resolves the desktop executable from `packages/clients/desktop/src-tauri/Cargo.toml` (`[package] name`) and stages it next to the sidecars.
- The Windows target is x64-only: `x86_64-pc-windows-msvc`.
- The staged package contains the desktop executable, `lasterm-hub.exe`, `lasterm-agent.exe`, required DLLs, and the logos from `msix/Assets`: one file per scale and, for `Square44x44Logo`, per target size, plated and unplated. `pnpm icons` renders them from `packaging/brand` (see its README).
- `MakePri.exe` indexes those logos into `resources.pri`, so the manifest can name each one without its qualifiers. The default resource-pack split is removed from its config: every candidate stays in the one package.
- Before packing, the script fails closed if any staged executable is not a 64-bit PE file.
- Before packing, the script also fails closed if `lasterm-hub.exe` or `lasterm-agent.exe` reports a strict `x.y.z` version that does not match the first three components of the MSIX package version.

The source sidecars must exist before packaging:

```text
packages\clients\desktop\src-tauri\lasterm-hub-x86_64-pc-windows-msvc.exe
packages\clients\desktop\src-tauri\lasterm-agent-x86_64-pc-windows-msvc.exe
```

The CI desktop job places those files from the Windows hub and agent artifacts before it invokes the MSIX script.

## Local Packaging

Local packaging is optional; CI is the primary path.

Run on Windows with Node, Rust, pnpm dependencies, and the Windows SDK installed. `MakeAppx.exe` may be on `PATH`, or under the Windows Kits `10\bin\<version>\x64` directory.

Build and place the Windows sidecars first:

```powershell
.\scripts\build-agent.ps1
.\scripts\build-hub.ps1

Copy-Item .\dist\sea\lasterm-agent.exe .\packages\clients\desktop\src-tauri\lasterm-agent-x86_64-pc-windows-msvc.exe -Force
Copy-Item .\dist\sea\lasterm-hub.exe .\packages\clients\desktop\src-tauri\lasterm-hub-x86_64-pc-windows-msvc.exe -Force
```

Then package:

```powershell
.\packages\clients\desktop\msix\pack-msix.ps1
```

The output is unsigned:

```text
packages\clients\desktop\msix\out\Lasterm_<version>_x64.msix
```

If a locally installable smoke-test package is needed, sign the generated MSIX outside this script with a certificate-store or other non-argv secret workflow.

## CI Validation Checklist

Validate these points on the next Windows CI dispatch or release run:

1. `pack-msix.ps1` discovers the preinstalled `MakeAppx.exe`.
2. `msix/out/stage/AppxManifest.xml` exists and names the resolved desktop executable.
3. The staged desktop executable, hub sidecar, and agent sidecar all pass the x64 PE check.
4. The sidecar version gate passes for `lasterm-hub.exe` and `lasterm-agent.exe`.
5. `MakeAppx.exe pack /d ... /p ... /o` writes `Lasterm_<version>.0_x64.msix`.
6. Manual `ci.yml` dispatch exposes the `msix-x86_64-pc-windows-msvc` artifact when MSIX packaging is enabled.
7. Release runs keep the `.msix` as that run artifact; it is not uploaded to the release.

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
4. In certification notes, explain `runFullTrust`: Lasterm is a developer terminal app that launches its packaged local hub and agent sidecars, listens only on localhost for its UI transport, and manages user-initiated terminal/SSH session subprocesses.
5. Attach Windows App Certification Kit results and document any accepted full-trust warnings.
