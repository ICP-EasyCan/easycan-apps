#!/usr/bin/env bash
set -euo pipefail

# make-manifest.sh — genera il manifest.json di una release (self-upgrade §B).
#
# Il manifest è il CONTRATTO che l'app legge per scoprire un aggiornamento:
#   - version / min_compatible_version → confronto semver lato client
#   - wasm_sha256  → DEVE combaciare col `module_hash` post `wasm-opt` (§A) e col
#                    `wasm_module_hash` passato a install_chunked_code (Fase 2)
#   - *_url        → TRANSPORT CORS del self-upgrade dal browser: puntano a
#                    raw.githubusercontent.com sul branch `dist`, sotto path versionato.
#                    I release-asset GitHub NON hanno header CORS → fetch() browser bloccato;
#                    i file COMMITTATI serviti da raw hanno `Access-Control-Allow-Origin: *`.
#                    Cfr. memory/gotchas/frontend/github_release_assets_no_cors.md + BACKLOG §7.
#   - release_tag  → ancora d'audit IMMUTABILE (<app>-vX.Y.Z): stessi byte allegati come
#                    release-asset permanente, verificabili per sha256 (no CORS, ma per
#                    audit-via-curl va bene). Il branch `dist` tiene SOLO l'ultima versione.
#   - source_commit→ il commit da cui rifare la build Docker riproducibile (§A #verify)
#
# Il self-upgrade va SEMPRE all'ultima release → la `dist` solo-latest basta (i byte di una
# versione superata non servono più al browser; restano come release-asset per l'audit).
#
# Uso:
#   scripts/make-manifest.sh \
#     --app vault --version 0.3.0 --min-compatible 0.1.0 \
#     --wasm /out/vault_canister.wasm --frontend /tmp/frontend.tar.gz \
#     --repo OWNER/REPO --tag vault-v0.3.0 [--dist-branch dist] --commit <git-sha> \
#     --notes "Changelog…"  > manifest.json
#
# Gli URL usano il basename dei file passati: nominali esattamente come i file su `dist`.

APP="" VERSION="" MIN_COMPAT="0.0.0" WASM="" FRONTEND="" REPO="" TAG="" DIST_BRANCH="dist" COMMIT="" NOTES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)            APP="$2"; shift 2 ;;
    --version)        VERSION="$2"; shift 2 ;;
    --min-compatible) MIN_COMPAT="$2"; shift 2 ;;
    --wasm)           WASM="$2"; shift 2 ;;
    --frontend)       FRONTEND="$2"; shift 2 ;;
    --repo)           REPO="$2"; shift 2 ;;
    --tag)            TAG="$2"; shift 2 ;;
    --dist-branch)    DIST_BRANCH="$2"; shift 2 ;;
    --commit)         COMMIT="$2"; shift 2 ;;
    --notes)          NOTES="$2"; shift 2 ;;
    *) echo "make-manifest: argomento sconosciuto: $1" >&2; exit 1 ;;
  esac
done

for v in APP VERSION WASM FRONTEND REPO TAG COMMIT; do
  if [ -z "${!v}" ]; then echo "make-manifest: manca --${v,,}" >&2; exit 1; fi
done
for f in "$WASM" "$FRONTEND"; do
  if [ ! -f "$f" ]; then echo "make-manifest: file non trovato: $f" >&2; exit 1; fi
done

WASM_NAME="$(basename "$WASM")"
FRONTEND_NAME="$(basename "$FRONTEND")"
WASM_SHA="$(sha256sum "$WASM" | cut -d' ' -f1)"
FRONTEND_SHA="$(sha256sum "$FRONTEND" | cut -d' ' -f1)"
# Transport CORS: raw.githubusercontent sul branch `dist`, path versionato (cache-correct:
# ogni versione ha un URL unico → la cache di raw non serve mai byte vecchi per quella versione).
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${DIST_BRANCH}/${APP}/${VERSION}"
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg app "$APP" \
  --arg version "$VERSION" \
  --arg min "$MIN_COMPAT" \
  --arg wasm_url "${RAW_BASE}/${WASM_NAME}" \
  --arg wasm_sha "$WASM_SHA" \
  --arg fe_url "${RAW_BASE}/${FRONTEND_NAME}" \
  --arg fe_sha "$FRONTEND_SHA" \
  --arg released_at "$RELEASED_AT" \
  --arg commit "$COMMIT" \
  --arg release_tag "$TAG" \
  --arg notes "$NOTES" \
  '{
    app: $app,
    version: $version,
    min_compatible_version: $min,
    wasm_url: $wasm_url,
    wasm_sha256: $wasm_sha,
    frontend_url: $fe_url,
    frontend_sha256: $fe_sha,
    released_at: $released_at,
    source_commit: $commit,
    release_tag: $release_tag,
    notes: $notes
  }'
