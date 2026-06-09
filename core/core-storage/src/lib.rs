//! core-storage — MemoryManager e registry dei MemoryId
//!
//! Il MemoryManager vive nel canister host (thread_local!).
//! Questo crate fornisce:
//! - Il registry centralizzato dei MemoryId (non cambiare l'ordine dopo il deploy)
//! - Helper per inizializzare StableBTreeMap con counter pattern
//! - Re-export dei tipi necessari

pub use core_types::Memory;
pub use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
pub use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap};

use std::cell::RefCell;

// ─── MemoryId Registry ──────────────────────────────────────────────────────
//
// Schema allocazione (u8, 0-255 — invariante dopo il primo deploy):
//
//   0-9     → Core platform (auth, assets)       [10 slot, 3 usati]
//   10-199  → Capability (blocchi di 10)          [190 slot, 19 blocchi]
//              10-19  cap-presence
//              20-29  cap-messaging
//              30-39  cap-signaling
//              40-49  cap-notify
//              50-59  cap-archive
//              60-69  cap-crypto
//              70-79  cap-crud
//              80-199 libero (12 blocchi per future capability)
//   200-249 → Runtime L2 (riservato)             [50 slot]
//   250-255 → cap-platform (ponte SaaS)           [6 slot, 1 usato]
//
// Regole:
//   - Nuova capability: primo blocco di 10 libero (attualmente: 80-89)
//   - Espansione capability: usa slot libero nel suo blocco
//   - MAI riassegnare un MemoryId dopo il deploy — corruzione dati garantita
//   - Capability ritirata: lasciare il commento "// RETIRED", non riusare lo slot

// ── Core (0-9) ──
pub const AUTH_OWNER_MEM:     MemoryId = MemoryId::new(0);
pub const AUTH_WHITELIST_MEM: MemoryId = MemoryId::new(1);
pub const ASSETS_MEM:         MemoryId = MemoryId::new(2);
// 3-9: riservato core

// ── cap-presence (10-19) ──
pub const PRESENCE_MEM: MemoryId = MemoryId::new(10);
// 11-19: libero presence

// ── cap-messaging (20-29) ──
pub const MESSAGING_OUTBOX_MEM:  MemoryId = MemoryId::new(20);
pub const MESSAGING_COUNTER_MEM: MemoryId = MemoryId::new(21);
// 22-29: libero messaging

// ── cap-signaling (30-39) ──
pub const SIGNALING_BOARD_MEM:   MemoryId = MemoryId::new(30);
pub const SIGNALING_COUNTER_MEM: MemoryId = MemoryId::new(31);
// 32-39: libero signaling

// ── cap-notify (40-49) ──
pub const NOTIFY_SENDERS_MEM: MemoryId = MemoryId::new(40);
pub const NOTIFY_CALLERS_MEM: MemoryId = MemoryId::new(41);
// 42-49: libero notify

// ── cap-archive (50-59) ──
pub const ARCHIVE_MEM:              MemoryId = MemoryId::new(50);
pub const ARCHIVE_COUNTER_MEM:      MemoryId = MemoryId::new(51);
pub const ARCHIVE_PERSIST_FLAGS_MEM: MemoryId = MemoryId::new(52);
// 53-59: libero archive

// ── cap-crypto (60-69) ──
pub const CRYPTO_MEM: MemoryId = MemoryId::new(60);
// 61-69: libero crypto

// ── cap-crud (70-79) ──
pub const CRUD_RECORDS_MEM:  MemoryId = MemoryId::new(70);
pub const CRUD_COUNTER_MEM:  MemoryId = MemoryId::new(71);
pub const CRUD_NS_INDEX_MEM: MemoryId = MemoryId::new(72);
// 73-79: libero crud

// ── 80-199: libero per future capability ──

// ── cap-platform (250-255 — range piattaforma) ──
pub const PLATFORM_STATE_MEM: MemoryId = MemoryId::new(250);
// 251-255: riservato platform (asset management, config SaaS)

// ─── MemoryManager init helper ──────────────────────────────────────────────

/// Crea un MemoryManager. Da chiamare nel thread_local! del canister host.
///
/// ```rust,ignore
/// thread_local! {
///     static MM: RefCell<MemoryManager<DefaultMemoryImpl>> =
///         RefCell::new(core_storage::new_memory_manager());
/// }
/// ```
pub fn new_memory_manager() -> MemoryManager<DefaultMemoryImpl> {
    // bucket_size = 8 pagine (512 KB) invece del default 128 (8 MiB): riduce
    // del ~93-94% lo stable pre-allocato per StableBTreeMap su install fresco.
    // ⚠️ IMMUTABILE dopo il primo deploy — scritto nell'header stable memory,
    // riletto al post_upgrade; cambiarlo su un canister con dati corrompe.
    // Tetto MAX_NUM_BUCKETS=32768 totali → con 512 KB la capacità max è ~16 GiB.
    MemoryManager::init_with_bucket_size(DefaultMemoryImpl::default(), 8)
}

// ─── Counter pattern ────────────────────────────────────────────────────────

/// Counter sequenziale persistente in una StableBTreeMap<u8, u64, Memory>.
/// Usato da messaging, signaling, archive per generare ID univoci.
pub struct StableCounter {
    map: RefCell<StableBTreeMap<u8, u64, Memory>>,
}

impl StableCounter {
    pub fn new(memory: Memory) -> Self {
        Self {
            map: RefCell::new(StableBTreeMap::init(memory)),
        }
    }

    /// Ritorna il prossimo ID e incrementa il contatore.
    pub fn next_id(&self) -> u64 {
        let mut m = self.map.borrow_mut();
        let id = m.get(&0u8).unwrap_or(0u64);
        m.insert(0u8, id + 1);
        id
    }

    /// Ritorna il valore corrente del contatore (= prossimo ID che verrà assegnato).
    pub fn current(&self) -> u64 {
        self.map.borrow().get(&0u8).unwrap_or(0u64)
    }
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_memory() -> Memory {
        let mm = new_memory_manager();
        mm.get(MemoryId::new(200))
    }

    #[test]
    fn counter_starts_at_zero() {
        let c = StableCounter::new(test_memory());
        assert_eq!(c.current(), 0);
    }

    #[test]
    fn counter_increments() {
        let c = StableCounter::new(test_memory());
        assert_eq!(c.next_id(), 0);
        assert_eq!(c.next_id(), 1);
        assert_eq!(c.next_id(), 2);
        assert_eq!(c.current(), 3);
    }

    #[test]
    fn memory_ids_no_overlap() {
        let ids = vec![
            AUTH_OWNER_MEM,
            AUTH_WHITELIST_MEM,
            ASSETS_MEM,
            PRESENCE_MEM,
            MESSAGING_OUTBOX_MEM,
            MESSAGING_COUNTER_MEM,
            SIGNALING_BOARD_MEM,
            SIGNALING_COUNTER_MEM,
            NOTIFY_SENDERS_MEM,
            NOTIFY_CALLERS_MEM,
            ARCHIVE_MEM,
            ARCHIVE_COUNTER_MEM,
            ARCHIVE_PERSIST_FLAGS_MEM,
            CRYPTO_MEM,
            CRUD_RECORDS_MEM,
            CRUD_COUNTER_MEM,
            CRUD_NS_INDEX_MEM,
            PLATFORM_STATE_MEM,
        ];
        // Nessun duplicato
        let mut seen = std::collections::HashSet::new();
        for id in &ids {
            assert!(seen.insert(format!("{id:?}")), "Duplicate MemoryId: {id:?}");
        }
    }

    // Verifica che ogni MemoryId stia nel blocco della sua capability.
    // Se fallisce, significa che qualcuno ha assegnato un ID fuori range — fix prima del deploy.
    #[test]
    fn memory_ids_in_correct_block() {
        fn id_val(m: MemoryId) -> u8 {
            // MemoryId non espone il valore direttamente; lo estraiamo via debug
            let s = format!("{m:?}");
            s.trim_start_matches("MemoryId(").trim_end_matches(')').parse().unwrap()
        }

        // (nome, valore, range del blocco) — range esclusivo
        let rules: &[(&str, MemoryId, std::ops::Range<u8>)] = &[
            ("AUTH_OWNER",            AUTH_OWNER_MEM,             0..10),
            ("AUTH_WHITELIST",         AUTH_WHITELIST_MEM,         0..10),
            ("ASSETS",                 ASSETS_MEM,                 0..10),
            ("PRESENCE",               PRESENCE_MEM,               10..20),
            ("MESSAGING_OUTBOX",       MESSAGING_OUTBOX_MEM,       20..30),
            ("MESSAGING_COUNTER",      MESSAGING_COUNTER_MEM,      20..30),
            ("SIGNALING_BOARD",        SIGNALING_BOARD_MEM,        30..40),
            ("SIGNALING_COUNTER",      SIGNALING_COUNTER_MEM,      30..40),
            ("NOTIFY_SENDERS",         NOTIFY_SENDERS_MEM,         40..50),
            ("NOTIFY_CALLERS",         NOTIFY_CALLERS_MEM,         40..50),
            ("ARCHIVE",                ARCHIVE_MEM,                50..60),
            ("ARCHIVE_COUNTER",        ARCHIVE_COUNTER_MEM,        50..60),
            ("ARCHIVE_PERSIST_FLAGS",  ARCHIVE_PERSIST_FLAGS_MEM,  50..60),
            ("CRYPTO",                 CRYPTO_MEM,                 60..70),
            ("CRUD_RECORDS",           CRUD_RECORDS_MEM,           70..80),
            ("CRUD_COUNTER",           CRUD_COUNTER_MEM,           70..80),
            ("CRUD_NS_INDEX",          CRUD_NS_INDEX_MEM,          70..80),
        ];

        for (name, mem_id, range) in rules {
            let v = id_val(*mem_id);
            assert!(
                range.contains(&v),
                "{name} ha MemoryId={v} ma dovrebbe stare in {range:?}"
            );
        }

        // Range piattaforma (250-255) — u8 non supporta Range esclusivo fino a 256
        let v = id_val(PLATFORM_STATE_MEM);
        assert!(
            v >= 250,
            "PLATFORM_STATE ha MemoryId={v} ma dovrebbe stare in 250..=255"
        );
    }
}
