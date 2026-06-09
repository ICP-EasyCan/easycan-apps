#!/usr/bin/env bash
set -euo pipefail

# Deploy script per Sovereign Vault
# Uso: ./deploy.sh [--skip-build] [--skip-ii] [--skip-frontend]

SKIP_BUILD=false
SKIP_II=false
SKIP_FRONTEND=false
CLEAN=false

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --skip-ii) SKIP_II=true ;;
    --skip-frontend) SKIP_FRONTEND=true ;;
    --clean) CLEAN=true ;;
  esac
done

cd "$(dirname "$0")"
PROJ_ROOT="$(cd ../.. && pwd)"

# 1. Build wasm (dal workspace root)
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building vault canister wasm..."
  cd "$PROJ_ROOT"
  cargo build --target wasm32-unknown-unknown --release -p vault-canister
  echo "==> Extracting Candid interface..."
  candid-extractor target/wasm32-unknown-unknown/release/vault_canister.wasm > apps/vault/canister/vault_canister.did
  cd apps/vault
fi

# 2. Start dfx (se non è già in esecuzione)
if ! dfx ping &>/dev/null; then
  echo "==> Starting dfx..."
  dfx start --background
fi

# 3. Deploy II
if [ "$SKIP_II" = false ]; then
  echo "==> Deploying Internet Identity..."
  dfx deps init 2>/dev/null || true
  dfx deps deploy 2>&1 | grep -E "Creating|Installing" || true
fi

# 4. Deploy canister
PRINCIPAL=$(dfx identity get-principal)
echo "==> Deploying vault con owner: $PRINCIPAL"
if [ "$CLEAN" = true ]; then
  echo "    (--clean: reinstall — resetta stable memory e claim)"
  dfx deploy vault --argument "(principal \"$PRINCIPAL\")" --mode reinstall --yes
else
  dfx deploy vault --argument "(principal \"$PRINCIPAL\")"
fi

# 5. Allow claim per II login
echo "==> Opening claim window..."
dfx canister call vault allow_claim

CANISTER_ID=$(dfx canister id vault)

# 6. Build + upload frontend
if [ "$SKIP_FRONTEND" = false ] && [ -d "frontend" ]; then
  echo "==> Building frontend..."
  cd frontend && npm install && npm run build && cd ..
  echo "==> Uploading frontend assets..."
  DIST_DIR="frontend/dist" node "$PROJ_ROOT/scripts/upload_assets.js" --canister-id "$CANISTER_ID"
fi

echo ""
echo "Deploy completato!"
echo "Canister ID: $CANISTER_ID"
echo "URL: http://$CANISTER_ID.localhost:4943/"
