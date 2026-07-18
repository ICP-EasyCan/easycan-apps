//! cap-presence — heartbeat e stato online/offline
//!
//! Endpoint: set_presence (update), get_presence (query)
//! Timer: cleanup_stale (ogni 2 min, registrato via core-timer)
//! Storage: 1 MemoryId (PRESENCE_MEM)
//! Dipendenze: core-auth (require_authorized per get_presence)

use candid::CandidType;
use core_types::Memory;
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

// ─── Configurazione ─────────────────────────────────────────────────────────

/// Configurazione della capability presence.
pub struct PresenceConfig {
    /// Soglia in nanosecondi oltre la quale la presenza è considerata stale (default: 90s).
    pub stale_threshold_ns: u64,
}

impl Default for PresenceConfig {
    fn default() -> Self {
        Self {
            stale_threshold_ns: 90 * 1_000_000_000,
        }
    }
}

// ─── Tipi ───────────────────────────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct PresenceInfo {
    pub online: bool,
    pub last_seen_ns: u64,
}

impl Storable for PresenceInfo {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut buf = vec![0u8; 9];
        buf[0] = self.online as u8;
        buf[1..9].copy_from_slice(&self.last_seen_ns.to_be_bytes());
        Cow::Owned(buf)
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        let online = bytes[0] != 0;
        let arr: [u8; 8] = bytes[1..9].try_into().unwrap_or([0u8; 8]);
        PresenceInfo {
            online,
            last_seen_ns: u64::from_be_bytes(arr),
        }
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 9,
        is_fixed_size: true,
    };
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static PRESENCE: RefCell<Option<StableBTreeMap<u8, PresenceInfo, Memory>>> =
        const { RefCell::new(None) };

    static CONFIG: RefCell<PresenceConfig> = RefCell::new(PresenceConfig::default());
}

// ─── Init ───────────────────────────────────────────────────────────────────

/// Inizializza la capability con la memory dal MemoryManager.
pub fn init_storage(presence_mem: Memory) {
    PRESENCE.with(|p| {
        *p.borrow_mut() = Some(StableBTreeMap::init(presence_mem));
    });
}

/// Configura la capability (opzionale — i default sono ragionevoli).
pub fn configure(config: PresenceConfig) {
    CONFIG.with(|c| {
        *c.borrow_mut() = config;
    });
}

fn with_presence<R>(f: impl FnOnce(&StableBTreeMap<u8, PresenceInfo, Memory>) -> R) -> R {
    PRESENCE.with(|p| {
        let borrow = p.borrow();
        let map = borrow
            .as_ref()
            .expect("cap-presence: init_storage() not called");
        f(map)
    })
}

fn with_presence_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u8, PresenceInfo, Memory>) -> R,
) -> R {
    PRESENCE.with(|p| {
        let mut borrow = p.borrow_mut();
        let map = borrow
            .as_mut()
            .expect("cap-presence: init_storage() not called");
        f(map)
    })
}

// ─── Cleanup (registrata in core-timer) ─────────────────────────────────────

/// Resetta online=false se l'ultimo heartbeat è più vecchio della soglia.
/// Registrare in core-timer:
/// ```rust,ignore
/// core_timer::register_cleanup(|| cap_presence::cleanup_stale());
/// ```
pub fn cleanup_stale() {
    let now = ic_cdk::api::time();
    let threshold = CONFIG.with(|c| c.borrow().stale_threshold_ns);
    with_presence_mut(|map| {
        if let Some(info) = map.get(&0u8) {
            if info.online && now.saturating_sub(info.last_seen_ns) > threshold {
                map.insert(
                    0u8,
                    PresenceInfo {
                        online: false,
                        last_seen_ns: info.last_seen_ns,
                    },
                );
            }
        }
    });
}

// ─── Funzioni pubbliche (wrappate dal canister host) ────────────────────────

/// Aggiorna la presenza. Il canister host deve verificare require_owner_or_user.
pub fn set_presence(online: bool) {
    with_presence_mut(|map| {
        map.insert(
            0u8,
            PresenceInfo {
                online,
                last_seen_ns: ic_cdk::api::time(),
            },
        );
    });
}

/// Ritorna la presenza attuale, con staleness calcolata **in lettura**: se `online`
/// ma l'ultimo heartbeat supera `stale_threshold_ns`, riporta `offline` senza
/// scrivere (resta query gratis). Così il badge è esatto-a-soglia e indipendente
/// dalla frequenza del timer di cleanup — stessa logica di `cleanup_stale`, ma
/// autorevole al momento della lettura. `last_seen_ns` resta quello reale.
/// Il canister host deve verificare require_authorized.
pub fn get_presence() -> PresenceInfo {
    let now = ic_cdk::api::time();
    let threshold = CONFIG.with(|c| c.borrow().stale_threshold_ns);
    with_presence(|map| {
        let info = map.get(&0u8).unwrap_or(PresenceInfo {
            online: false,
            last_seen_ns: 0,
        });
        if info.online && now.saturating_sub(info.last_seen_ns) > threshold {
            PresenceInfo {
                online: false,
                last_seen_ns: info.last_seen_ns,
            }
        } else {
            info
        }
    })
}
