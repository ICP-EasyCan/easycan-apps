# core/ — Blocchi Riutilizzabili

15 crate Rust riutilizzabili per assemblare app ICP decentralizzate.

## Core (5) — sempre presenti in ogni app

| Crate | Cosa fa |
|-------|---------|
| `core-types` | Tipi base: `StorablePrincipal`, trait Memory |
| `core-auth` | Owner/user/whitelist/claim + guard functions |
| `core-storage` | MemoryManager, MemoryId registry, StableCounter |
| `core-timer` | Cleanup automatico TTL (messaggi, segnali, presenze) |
| `core-assets` | Asset storage + HTTP serving + IC Certification v2 |

## Capability (10) — aggiungi solo ciò che serve

| Crate | Cosa fa |
|-------|---------|
| `cap-presence` | Online/offline heartbeat (piggyback su update call) |
| `cap-messaging` | Outbox messaggi + TTL + limits (50 msg, 512 byte) |
| `cap-signaling` | WebRTC signal board (Offer/Answer/ICE + TTL 2min) |
| `cap-notify` | Pending senders/callers (notifiche push leggere) |
| `cap-archive` | Cronologia persistente (localStorage + canister sync) |
| `cap-crud` | Operazioni CRUD generiche con namespace e paginazione |
| `cap-crypto` | E2EE stub (VetKeys — TODO) |
| `cap-platform` | Ponte SaaS: claim/eject/tier/metadata per marketplace |
| `cap-store` | KV `namespace:key` + host bundle hash-verificati + permessi (per EasyHub) |
| `cap-automation` | Job (azioni interne + esterne) + scheduler persistente sul tick di core-timer |

## Matrice decisionale

→ `docs/catalog/README.md`

## MemoryId assegnati (IMMUTABILI dopo il primo deploy)

Schema: blocchi da 10 per capability. Fonte di verità: `core-storage/src/lib.rs`

| ID | Crate | Descrizione |
|----|-------|-------------|
| 0 | core-auth | OWNER map |
| 1 | core-auth | WHITELIST |
| 2 | core-assets | ASSETS |
| 3-9 | — | riservato core |
| 10 | cap-presence | PRESENCE |
| 11-19 | — | libero presence |
| 20 | cap-messaging | OUTBOX |
| 21 | cap-messaging | COUNTER |
| 22-29 | — | libero messaging |
| 30 | cap-signaling | BOARD |
| 31 | cap-signaling | COUNTER |
| 32-39 | — | libero signaling |
| 40 | cap-notify | SENDERS |
| 41 | cap-notify | CALLERS |
| 42-49 | — | libero notify |
| 50 | cap-archive | ARCHIVE |
| 51 | cap-archive | COUNTER |
| 52 | cap-archive | PERSIST_FLAGS |
| 53-59 | — | libero archive |
| 60 | cap-crypto | CRYPTO |
| 61-69 | — | libero crypto |
| 70 | cap-crud | RECORDS |
| 71 | cap-crud | COUNTER |
| 72 | cap-crud | NS_INDEX |
| 73-79 | — | libero crud |
| 80-82 | cap-store | STORE_KV (80) · STORE_BUNDLE_META (81) · STORE_ASSETS (82); 83-89 margine |
| 90-93 | cap-automation | AUTO_JOBS (90) · AUTO_SCHEDULES (91) · AUTO_STATUS (92) · AUTO_LOG (93); 94-99 margine |
| 100-199 | — | 10 blocchi per future capability |
| 200-249 | — | riservato Runtime L2 |
| 250 | cap-platform | PLATFORM_STATE (feature-gated) |
| 251-255 | — | riservato SaaS |
