#!/bin/bash
# dev.sh — Avvia Messenger (fabbrica) in locale con Alice e Bob
# Uso: ./dev.sh [--skip-build] [--skip-deploy]
set -e
cd "$(dirname "$0")"
PROJ_ROOT="$(cd ../.. && pwd)"

SKIP_BUILD=false
SKIP_DEPLOY=false
for arg in "$@"; do
  [[ "$arg" == "--skip-build"  ]] && SKIP_BUILD=true
  [[ "$arg" == "--skip-deploy" ]] && SKIP_DEPLOY=true
done

# ─── Colori ───────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; C='\033[0;36m'; B='\033[1m'; N='\033[0m'
step() { echo -e "\n${Y}▶ $1${N}"; }
ok()   { echo -e "  ${G}✓${N} $1"; }
link() {
  local label="$1" url="$2"
  printf "  ${G}%-8s${N} \033]8;;%s\033\\${C}%s${N}\033]8;;\033\\\n" "$label" "$url" "$url"
}

echo -e "\n${B}════════════════════════════════════════${N}"
echo -e "${B}  Messenger (Fabbrica) — Dev Launcher    ${N}"
echo -e "${B}════════════════════════════════════════${N}"

# ── 1. Build WASM ─────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  step "1/6  Build WASM"
  cd "$PROJ_ROOT"
  cargo build --target wasm32-unknown-unknown --release -p messenger-canister
  candid-extractor target/wasm32-unknown-unknown/release/messenger_canister.wasm > apps/messenger/canister/messenger_canister.did
  cd apps/messenger
  ok "messenger_canister.wasm + .did pronti"
else
  step "1/6  Build — saltato (--skip-build)"
fi

# ── 2. DFX ────────────────────────────────────────────────────────────────────
step "2/6  Replica DFX locale"
if dfx ping 2>/dev/null | grep -q "healthy\|ic_api_version"; then
  ok "DFX già in esecuzione"
else
  dfx start --background --clean
  ok "DFX avviato"
fi

maybe_allow_claim() {
  local canister="$1"
  dfx canister call "$canister" allow_claim > /dev/null
  ok "Claim aperto per $canister"
}

if [ "$SKIP_DEPLOY" = false ]; then
  # ── 3. Deploy Alice ──────────────────────────────────────────────────────────
  step "3/6  Deploy Alice (identità default)"
  dfx identity use default 2>/dev/null
  ALICE_PRINCIPAL=$(dfx identity get-principal)
  dfx deploy messenger --argument "(principal \"${ALICE_PRINCIPAL}\")" \
    --yes 2>&1 | grep -E "^(Uploading|Creating|Installing|Upgrading|messenger)" || true
  ALICE_ID=$(dfx canister id messenger)
  ok "Alice → ${ALICE_ID}"
  maybe_allow_claim messenger

  # ── 4. Deploy Bob ────────────────────────────────────────────────────────────
  step "4/6  Deploy Bob (identità bob)"
  if ! dfx identity list 2>/dev/null | grep -qx "bob"; then
    dfx identity new bob --storage-mode plaintext
    ok "Identità 'bob' creata"
  fi
  dfx identity use bob 2>/dev/null
  BOB_PRINCIPAL=$(dfx identity get-principal)
  dfx deploy messenger_bob --argument "(principal \"${BOB_PRINCIPAL}\")" \
    --yes 2>&1 | grep -E "^(Uploading|Creating|Installing|Upgrading|messenger)" || true
  dfx identity use default 2>/dev/null
  BOB_ID=$(dfx canister id messenger_bob)
  ok "Bob   → ${BOB_ID}"
  dfx identity use bob 2>/dev/null
  maybe_allow_claim messenger_bob
  dfx identity use default 2>/dev/null

  # ── Internet Identity ────────────────────────────────────────────────────
  step "4b/6 Deploy Internet Identity locale"
  # Sync pinned II WASM into global cache to avoid hash mismatch
  mkdir -p "$HOME/.cache/dfinity/pulled/rdmx6-jaaaa-aaaaa-aaadq-cai"
  cp deps/wasm/internet_identity_dev.wasm.gz "$HOME/.cache/dfinity/pulled/rdmx6-jaaaa-aaaaa-aaadq-cai/canister.wasm.gz"
  dfx deps init 2>/dev/null || true
  dfx deps deploy 2>&1 | grep -E "Creating|Installing" || true
  ok "Internet Identity → rdmx6-jaaaa-aaaaa-aaadq-cai"
else
  step "3-4/6 Deploy — saltato (--skip-deploy)"
  ALICE_ID=$(dfx canister id messenger)
  BOB_ID=$(dfx canister id messenger_bob)
  dfx identity use default 2>/dev/null
  maybe_allow_claim messenger
  dfx identity use bob 2>/dev/null
  maybe_allow_claim messenger_bob
  dfx identity use default 2>/dev/null
fi

# ── 5. Whitelist reciproca ─────────────────────────────────────────────────────
step "5/6  Whitelist Alice ↔ Bob"
ALICE_PRINCIPAL=$(dfx identity get-principal)
dfx identity use bob 2>/dev/null
BOB_PRINCIPAL=$(dfx identity get-principal)
dfx identity use default 2>/dev/null

dfx canister call messenger add_to_whitelist \
  "(principal \"${BOB_PRINCIPAL}\")" > /dev/null
ok "Alice ha aggiunto Bob alla whitelist"

dfx identity use bob 2>/dev/null
dfx canister call messenger_bob add_to_whitelist \
  "(principal \"${ALICE_PRINCIPAL}\")" > /dev/null
dfx identity use default 2>/dev/null
ok "Bob ha aggiunto Alice alla whitelist"

# ── 6. Build & Upload frontend ─────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  step "6/6  Build frontend + upload assets"
  cd frontend
  npm install --silent
  npm run build --silent
  cd ..
  ok "frontend/dist/ pronto"

  cd "$PROJ_ROOT"
  DIST_DIR="apps/messenger/frontend/dist" node scripts/upload_assets.js --canister-id "$ALICE_ID"
  ok "Assets su Alice (${ALICE_ID})"

  DIST_DIR="apps/messenger/frontend/dist" node scripts/upload_assets.js --canister-id "$BOB_ID" --identity bob
  ok "Assets su Bob   (${BOB_ID})"
  cd apps/messenger
else
  step "6/6  Build & Upload — saltato (--skip-build)"
fi

# ── Riepilogo ──────────────────────────────────────────────────────────────────
echo -e "\n${B}════════════════════════════════════════${N}"
echo -e "${B}  Apri nel browser (Ctrl+click):         ${N}"
echo -e "${B}════════════════════════════════════════${N}"
link "Alice" "http://${ALICE_ID}.localhost:4943"
link "Bob"   "http://${BOB_ID}.localhost:4943"
echo -e "\n${B}  Tip:${N} apri Alice in un browser e Bob"
echo -e "       in una finestra in incognito."
echo -e "${B}════════════════════════════════════════${N}\n"
