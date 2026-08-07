#!/usr/bin/env bash
set -euo pipefail

# Generate Tauri updater signing key pair
# The private key should be stored in CI secrets (TAURI_SIGNING_PRIVATE_KEY)
# The public key goes in tauri.conf.json > plugins > updater > pubkey

echo "=== Tauri Updater Key Generation ==="
echo ""
echo "This will generate an Ed25519 key pair for signing Tauri updates."
echo "You will be prompted for a password to protect the private key."
echo ""

# Check if tauri CLI is available
if ! command -v cargo-tauri &> /dev/null && ! npx tauri --version &> /dev/null; then
    echo "Error: Tauri CLI not found. Install with:"
    echo "  cargo install tauri-cli"
    echo "  # or"
    echo "  pnpm add -g @tauri-apps/cli"
    exit 1
fi

# Generate key pair
echo "Generating key pair..."
npx tauri signer generate -w ~/.tauri/lasterm-updater.key 2>&1 || cargo tauri signer generate -w ~/.tauri/lasterm-updater.key

echo ""
echo "=== NEXT STEPS ==="
echo "1. Copy the PUBLIC key and set it in:"
echo "   packages/clients/desktop/src-tauri/tauri.conf.json"
echo "   → plugins.updater.pubkey"
echo ""
echo "2. Store the PRIVATE key as a CI secret:"
echo "   → GitHub: Settings > Secrets > TAURI_SIGNING_PRIVATE_KEY"
echo "   → Value: contents of ~/.tauri/lasterm-updater.key"
echo ""
echo "3. Store the PASSWORD as a CI secret:"
echo "   → GitHub: Settings > Secrets > TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
echo ""
echo "4. In CI workflow, set these env vars before tauri build:"
echo "   TAURI_SIGNING_PRIVATE_KEY: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}"
echo "   TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}"
