#!/usr/bin/env bash
set -euo pipefail

# Deploy script per Sovereign Messenger
# Uso: ./deploy.sh [--skip-build] [--skip-ii] [--skip-frontend]

SKIP_BUILD=false
SKIP_II=false
SKIP_FRONTEND=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-ii) SKIP_II=true ;;
    --skip-frontend) SKIP_FRONTEND=true ;;
  esac
done

cd "$(dirname "$0")"
PROJ_ROOT="$(cd ../.. && pwd)"

# 1. Build wasm (dal workspace root)
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building messenger canister wasm..."
  cd "$PROJ_ROOT"
  cargo build --target wasm32-unknown-unknown --release -p messenger-canister
  echo "==> Extracting Candid interface..."
  candid-extractor target/wasm32-unknown-unknown/release/messenger_canister.wasm > apps/messenger/canister/messenger_canister.did
  cd apps/messenger
fi

# 2. Start dfx (se non è già in esecuzione)
if ! dfx ping &>/dev/null; then
  echo "==> Starting dfx..."
  dfx start --background
fi

# 3. Deploy II
if [ "$SKIP_II" = false ]; then
  echo "==> Deploying Internet Identity..."
  # NON usare dfx deps pull — usa WASM pinnato in deps/wasm/ (release-2026-02-28)
  # L'ultima versione mainnet ha un bug DataView con passkey in locale
  dfx deps init 2>/dev/null || true
  dfx deps deploy 2>&1 | grep -E "Creating|Installing" || true
fi

# 4. Deploy canister
PRINCIPAL=$(dfx identity get-principal)
echo "==> Deploying messenger con owner: $PRINCIPAL"
dfx deploy messenger --argument "(principal \"$PRINCIPAL\")"

# 5. Allow claim per II login
echo "==> Opening claim window..."
dfx canister call messenger allow_claim

CANISTER_ID=$(dfx canister id messenger)

# 6. Build + upload frontend
if [ "$SKIP_FRONTEND" = false ] && [ -d "frontend" ]; then
  echo "==> Building frontend..."
  cd frontend && npm install && npm run build && cd ..
  echo "==> Uploading frontend assets..."
  cd "$PROJ_ROOT"
  DIST_DIR="apps/messenger/frontend/dist" node upload_assets.js --canister-id "$CANISTER_ID"
  cd apps/messenger
fi

echo ""
echo "Deploy completato!"
echo "Canister ID: $CANISTER_ID"
echo "URL: http://$CANISTER_ID.localhost:4943/"
