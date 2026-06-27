#!/usr/bin/env bash
set -euo pipefail

# Deploy script per EasyHub (supercanister-hub) — dev locale.
# Uso: ./deploy.sh [--skip-build] [--skip-ii] [--skip-frontend] [--clean]

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

# 1. Build wasm standalone (dal workspace root) — init(owner) per dev locale.
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building hub canister wasm..."
  ( cd "$PROJ_ROOT" && cargo build --target wasm32-unknown-unknown --release -p hub-canister )
fi

# 1b. Estrai il .did STANDALONE (init a 1 principal, senza platform_*) che dfx richiede per il
# deploy locale. NB: questo "downgrada" il .did committato (forma platform: init a 2 principal +
# 16 platform_*), che è il contratto marketplace e si rigenera SOLO con
# `scripts/build-app-wasm.sh -p hub-canister`. Lo ripristiniamo a fine deploy (passo 7) così il
# working tree resta pulito. Estratto SEMPRE (anche con --skip-build) per garantire a dfx la forma
# a 1 principal anche se il file in tree fosse la forma platform.
echo "==> Extracting standalone Candid interface (temporaneo, ripristinato a fine deploy)..."
candid-extractor "$PROJ_ROOT/target/wasm32-unknown-unknown/release/hub_canister.wasm" \
  > "$PROJ_ROOT/apps/supercanister-hub/canister/hub_canister.did"

# Ripristina il .did committato (forma platform) all'USCITA dello script — anche se il deploy
# fallisce a metà. Il canister già installato NON cambia (la metadata candid:service è incisa
# all'install, non al ripristino del file). Così il working tree resta pulito senza dover ricordare
# il vecchio `git update-index --skip-worktree`.
trap 'git -C "$PROJ_ROOT" checkout -- apps/supercanister-hub/canister/hub_canister.did 2>/dev/null || true' EXIT

# 2. Start dfx (se non è già in esecuzione)
if ! dfx ping &>/dev/null; then
  echo "==> Starting dfx..."
  dfx start --background
fi

# 3. Deploy II
# WASM II pinnato in deps/wasm/ — NON usare `dfx deps pull` (II su mainnet non espone i
# metadata `dfx` → il pull fallisce). Stesso metodo di apps/messenger e platform/portal:
# si copia il wasm pinnato nella cache pulled e poi `dfx deps deploy`.
if [ "$SKIP_II" = false ]; then
  echo "==> Deploying Internet Identity..."
  mkdir -p "$HOME/.cache/dfinity/pulled/rdmx6-jaaaa-aaaaa-aaadq-cai"
  cp deps/wasm/internet_identity_dev.wasm.gz "$HOME/.cache/dfinity/pulled/rdmx6-jaaaa-aaaaa-aaadq-cai/canister.wasm.gz"
  dfx deps init 2>/dev/null || true
  dfx deps deploy 2>&1 | grep -E "Creating|Installing" || true
fi

# 4. Deploy canister
PRINCIPAL=$(dfx identity get-principal)
echo "==> Deploying hub con owner: $PRINCIPAL"
if [ "$CLEAN" = true ]; then
  echo "    (--clean: reinstall — resetta stable memory e claim)"
  dfx deploy hub --argument "(principal \"$PRINCIPAL\")" --mode reinstall --yes
else
  dfx deploy hub --argument "(principal \"$PRINCIPAL\")"
fi

# 5. Allow claim per II login
echo "==> Opening claim window..."
dfx canister call hub allow_claim

CANISTER_ID=$(dfx canister id hub)

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
