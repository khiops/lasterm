# How to Set Up Tauri Auto-Updater Signing

## When

Use this guide when configuring or rotating the cryptographic key pair used to sign Tauri desktop update packages. Without a signing key, Tauri's updater cannot verify update authenticity — this is a supply chain attack vector.

## Prerequisites

- Tauri CLI: `cargo install tauri-cli` or `pnpm add -g @tauri-apps/cli`
- Write access to the GitHub repository secrets

## Steps

### 1. Generate the key pair

```bash
bash scripts/generate-updater-key.sh
```

The script generates an Ed25519 key pair at `~/.tauri/lasterm-updater.key`. It will prompt for a password — choose a strong one and record it securely.

The terminal output includes two values:
- **Public key** — a base64 string starting with `dW50cnVzdGVk...`
- **Private key file** — `~/.tauri/lasterm-updater.key`

### 2. Configure tauri.conf.json

Open `packages/clients/desktop/src-tauri/tauri.conf.json` and set the public key:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "<paste public key here>",
      "endpoints": ["https://releases.lasterm.dev/{{target}}/{{arch}}/{{current_version}}"]
    }
  }
}
```

Commit this change — the public key is not secret.

### 3. Add CI secrets

In GitHub: **Settings > Secrets and variables > Actions > New repository secret**

| Secret name | Value |
|-------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `~/.tauri/lasterm-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password entered during key generation |

### 4. Configure the CI workflow

In the Tauri build job (e.g. `.github/workflows/release-sea.yml`), add these env vars to the build step:

```yaml
- name: Build desktop
  env:
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  run: pnpm -F @lasterm/desktop build
```

Tauri CLI picks up these env vars automatically and signs all update artifacts (`.sig` files alongside installers).

## Key Rotation

When rotating the key pair (e.g. suspected compromise):

1. Run `bash scripts/generate-updater-key.sh` to generate a new pair.
2. Update `pubkey` in `tauri.conf.json` with the new public key.
3. Update both GitHub secrets with the new private key and password.
4. Deploy a release built with the new key — clients on the old key will verify against the old `pubkey` embedded in their installed binary, so the transition release must be signed with the **old** key. After all clients update, old key secrets can be removed.

## Verification

To verify signing works locally before pushing to CI:

```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/lasterm-updater.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<your password>
pnpm -F @lasterm/desktop build
```

Check that the output directory contains `.sig` files alongside the installer artifacts. A missing `.sig` means signing did not occur.

## Key Files

- `packages/clients/desktop/src-tauri/tauri.conf.json` — contains `plugins.updater.pubkey`
- `scripts/generate-updater-key.sh` — key generation helper
- `~/.tauri/lasterm-updater.key` — private key (local only, never commit)

## Gotchas

- Never commit the private key file. Add `~/.tauri/*.key` to your global gitignore.
- Tauri v2 uses `plugins.updater` config path, not the v1 `updater` top-level field.
- The password is required at build time — omitting `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` causes a silent build failure with no `.sig` output.
- If rotating keys, plan the transition release carefully — clients verify against the pubkey baked into their current binary, not the latest `tauri.conf.json`.
