# core/ — Blocchi Riutilizzabili

13 crate Rust riutilizzabili per assemblare app ICP decentralizzate.

## Core (5) — sempre presenti in ogni app

| Crate | Cosa fa |
|-------|---------|
| `core-types` | Tipi base: `StorablePrincipal`, trait Memory |
| `core-auth` | Owner/user/whitelist/claim + guard functions |
| `core-storage` | MemoryManager, MemoryId registry, StableCounter |
| `core-timer` | Cleanup automatico TTL (messaggi, segnali, presenze) |
| `core-assets` | Asset storage + HTTP serving + IC Certification v2 |

## Capability (8) — aggiungi solo ciò che serve

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
| 80-199 | — | 12 blocchi per future capability |
| 200-249 | — | riservato Runtime L2 |
| 250 | cap-platform | PLATFORM_STATE (feature-gated) |
| 251-255 | — | riservato SaaS |
