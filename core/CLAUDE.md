# core/ — Blocchi riutilizzabili

> **Linea:** Build · **Contratto:** MemoryId e `bucket_size` immutabili dopo deploy — fonte di verità per le app che assemblano.

15 crate Rust: 5 core (`core-types`, `core-auth`, `core-storage`, `core-timer`, `core-assets`) + 10 capability (`cap-presence`, `cap-messaging`, `cap-signaling`, `cap-notify`, `cap-archive`, `cap-crud`, `cap-crypto`, `cap-platform`, `cap-store`, `cap-automation`).

## Regole specifiche di questa zona

- **`core-storage/src/lib.rs` è l'unica fonte di verità per i `MemoryId`.** Blocchi da 10 per capability. Mai `MemoryId::new(N)` inline fuori da qui.
- **Nuovo campo in stable state → `Option<T>`** per backward compat (vedi `memory/feedback_stable_state_compat.md`).
- **Nuova/modifica API di una capability** richiede propagazione a monte: app che la importano, loro `idl.js`, eventualmente portale. Check list in `memory/reference_system_interfaces.md`.
- **Aggiungi/modifichi una capability → aggiorna `docs/catalog/`** (vedi `memory/feedback_catalog_sync.md`). È riferimento per chi costruisce app.

Gli invarianti Rust trasversali (timer async, `export_candid!()`, `ic_cdk 0.19`, `response.candid::<T>()`) sono nel root `CLAUDE.md`.

## Prima di chiudere una modifica

- `memory/feedback_review_patterns.md` — 5 pattern autorevisione pre-commit
- `POCKET_IC_BIN=$(which pocket-ic) cargo test --workspace` se hai toccato logica
