#!/usr/bin/env bash
set -euo pipefail

# build_platform.sh — Compila un'app della fabbrica in modalita' SaaS
#
# Produce un WASM con gli endpoint platform (claim, eject, metadata)
# pronto per essere caricato su app_factory del marketplace.
#
# Uso:
#   ./build_platform.sh -p <package-name> [-o <output-dir>]
#
# Esempi:
#   ./build_platform.sh -p messenger-canister
#   ./build_platform.sh -p vault-canister -o /tmp/wasm_marketplace
#
# Prerequisiti:
#   - Il package deve avere cap-platform come dipendenza opzionale:
#       [features]
#       platform = ["cap-platform"]
#       [dependencies]
#       cap-platform = { workspace = true, optional = true }
#   - Il lib.rs deve avere gli endpoint #[cfg(feature = "platform")]
#     (vedi templates/canister/lib.rs.template)
#
# Output:
#   <output-dir>/<package_name>.wasm       — WASM ottimizzato
#   <output-dir>/<package_name>.did        — Candid interface (se candid-extractor disponibile)

PACKAGE=""
OUTPUT_DIR="target/platform"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--package) PACKAGE="$2"; shift 2 ;;
    -o|--output)  OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "Uso: $0 -p <package-name> [-o <output-dir>]"
      echo ""
      echo "  -p, --package   Nome del package Cargo (es. messenger-canister)"
      echo "  -o, --output    Directory output (default: target/platform)"
      exit 0
      ;;
    *) echo "Argomento sconosciuto: $1"; exit 1 ;;
  esac
done

if [ -z "$PACKAGE" ]; then
  echo "Errore: specificare il package con -p <nome>"
  echo "Uso: $0 -p <package-name>"
  exit 1
fi

# I path sotto sono relativi alla root del repo (target/, scripts/), non a scripts/.
cd "$(dirname "$0")/.."

# Deriva il nome del file wasm dal nome del package (trattini → underscore)
WASM_NAME="${PACKAGE//-/_}"

echo "==> Building $PACKAGE con feature 'platform'..."
cargo build \
  --target wasm32-unknown-unknown \
  --release \
  -p "$PACKAGE" \
  --features platform

WASM_SRC="target/wasm32-unknown-unknown/release/${WASM_NAME}.wasm"

if [ ! -f "$WASM_SRC" ]; then
  echo "Errore: WASM non trovato: $WASM_SRC"
  echo "Verifica che il nome del package sia corretto."
  exit 1
fi

# Crea output dir
mkdir -p "$OUTPUT_DIR"

# Copia WASM
cp "$WASM_SRC" "$OUTPUT_DIR/${WASM_NAME}.wasm"
BEFORE_SIZE=$(du -h "$OUTPUT_DIR/${WASM_NAME}.wasm" | cut -f1)
echo "==> WASM (raw): $OUTPUT_DIR/${WASM_NAME}.wasm ($BEFORE_SIZE)"

# Ottimizza con wasm-opt — OBBLIGATORIO (non più condizionale).
# L'artefatto verificabile dal buyer è il post `wasm-opt -Oz --strip-debug`: è ciò che
# va a install_code, quindi è ciò che il `module_hash` certificato dall'IC riflette.
# Saltarlo o usare una versione diversa cambia l'hash → rompe il segnale di fiducia (§A).
EXPECTED_BINARYEN="129"
if ! command -v wasm-opt &>/dev/null; then
  echo "Errore: wasm-opt non trovato ma è OBBLIGATORIO per una build verificabile."
  echo "        Installa binaryen $EXPECTED_BINARYEN (vedi docs/build/REPRODUCIBLE_BUILD.md)."
  exit 1
fi

WASM_OPT_VERSION="$(wasm-opt --version | grep -oE '[0-9]+' | head -1)"
if [ "$WASM_OPT_VERSION" != "$EXPECTED_BINARYEN" ]; then
  echo "Errore: wasm-opt versione $WASM_OPT_VERSION, attesa $EXPECTED_BINARYEN."
  echo "        Una versione diversa produce un module_hash diverso → build non riproducibile."
  echo "        Vedi docs/build/REPRODUCIBLE_BUILD.md per il pin."
  exit 1
fi

echo "==> Optimizing with wasm-opt $WASM_OPT_VERSION (mandatory)..."
wasm-opt -Oz --strip-debug "$OUTPUT_DIR/${WASM_NAME}.wasm" -o "$OUTPUT_DIR/${WASM_NAME}.wasm"
AFTER_SIZE=$(du -h "$OUTPUT_DIR/${WASM_NAME}.wasm" | cut -f1)
echo "==> WASM (optimized): $OUTPUT_DIR/${WASM_NAME}.wasm ($AFTER_SIZE)"

# SHA-256 del WASM finale = il `module_hash` che l'IC certificherà a install_code.
# È il valore che va nella GitHub Release (Fase 2) e che la pagina #verify confronta.
WASM_SHA256="$(sha256sum "$OUTPUT_DIR/${WASM_NAME}.wasm" | cut -d' ' -f1)"
echo "==> module_hash (SHA-256, post wasm-opt): $WASM_SHA256"

# Estrai Candid se candid-extractor è disponibile
if command -v candid-extractor &>/dev/null; then
  echo "==> Extracting Candid interface..."
  candid-extractor "$OUTPUT_DIR/${WASM_NAME}.wasm" > "$OUTPUT_DIR/${WASM_NAME}.did"
  echo "==> DID:  $OUTPUT_DIR/${WASM_NAME}.did"
else
  echo "==> candid-extractor non trovato — skip estrazione .did"
  echo "    Installa con: cargo install candid-extractor"
fi

echo ""
echo "Build platform completata!"
echo "WASM pronto per upload su marketplace: $OUTPUT_DIR/${WASM_NAME}.wasm"
echo ""
echo "Per caricare sul SaaS:"
echo "  source scripts/build_factory.sh"
echo "  build_factory $PACKAGE --wasm $OUTPUT_DIR/${WASM_NAME}.wasm --spawner-id <ID>"
