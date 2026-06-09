//! cap-signaling — signal board per WebRTC
//!
//! Ogni utente posta segnali sul PROPRIO canister, il peer li legge da lì.
//!
//! Endpoint: post_signal, get_my_signals, ack_signals
//! Timer: cleanup_expired (registrato via core-timer)
//! Storage: 2 MemoryId (BOARD + COUNTER)
//! Dipendenze: core-auth (require_authorized)

use candid::{CandidType, Principal};
use core_storage::StableCounter;
use core_types::Memory;
use ic_stable_structures::StableBTreeMap;
use serde::Deserialize;
use std::cell::RefCell;

// ─── Configurazione ─────────────────────────────────────────────────────────

pub struct SignalingConfig {
    /// TTL dei segnali in nanosecondi (default: 2 minuti).
    pub signal_ttl_ns: u64,
    /// Max segnali per destinatario (anti-spam, default: 4).
    pub max_signals_per_peer: usize,
    /// Max byte nel campo data di un segnale (default: 16384 — SDP è ~2-4 KB).
    pub max_signal_data_bytes: usize,
}

impl Default for SignalingConfig {
    fn default() -> Self {
        Self {
            signal_ttl_ns: 120 * 1_000_000_000,
            max_signals_per_peer: 4,
            max_signal_data_bytes: 16_384,
        }
    }
}

// ─── Tipi ───────────────────────────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum WebRtcSignalType {
    Offer,
    Answer,
    IceCandidate,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct SignalEntry {
    pub id: u64,
    pub to: Principal,
    pub sig_type: WebRtcSignalType,
    pub data: String,
    pub timestamp: u64,
}

core_types::storable_candid!(SignalEntry);

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static SIGNALS: RefCell<Option<StableBTreeMap<u64, SignalEntry, Memory>>> =
        const { RefCell::new(None) };

    static COUNTER: RefCell<Option<StableCounter>> = const { RefCell::new(None) };

    static CONFIG: RefCell<SignalingConfig> = RefCell::new(SignalingConfig::default());
}

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_storage(signals_mem: Memory, counter_mem: Memory) {
    SIGNALS.with(|s| {
        *s.borrow_mut() = Some(StableBTreeMap::init(signals_mem));
    });
    COUNTER.with(|c| {
        *c.borrow_mut() = Some(StableCounter::new(counter_mem));
    });
}

pub fn configure(config: SignalingConfig) {
    CONFIG.with(|c| *c.borrow_mut() = config);
}

fn with_signals<R>(f: impl FnOnce(&StableBTreeMap<u64, SignalEntry, Memory>) -> R) -> R {
    SIGNALS.with(|s| {
        let borrow = s.borrow();
        f(borrow
            .as_ref()
            .expect("cap-signaling: init_storage() not called"))
    })
}

fn with_signals_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u64, SignalEntry, Memory>) -> R,
) -> R {
    SIGNALS.with(|s| {
        let mut borrow = s.borrow_mut();
        f(borrow
            .as_mut()
            .expect("cap-signaling: init_storage() not called"))
    })
}

fn next_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-signaling: init_storage() not called")
            .next_id()
    })
}

fn current_max_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-signaling: init_storage() not called")
            .current()
    })
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

pub fn cleanup_expired() {
    let now = ic_cdk::api::time();
    let ttl = CONFIG.with(|c| c.borrow().signal_ttl_ns);
    let max_id = current_max_id();

    let expired: Vec<u64> = with_signals(|signals| {
        (0..max_id)
            .filter(|id| {
                signals
                    .get(id)
                    .map(|e| now.saturating_sub(e.timestamp) > ttl)
                    .unwrap_or(false)
            })
            .collect()
    });

    with_signals_mut(|signals| {
        for id in expired {
            signals.remove(&id);
        }
    });
}

// ─── Funzioni pubbliche ─────────────────────────────────────────────────────

/// Posta un segnale WebRTC destinato a un peer.
/// Il canister host deve verificare require_authorized prima di chiamare.
pub fn post_signal(
    to: Principal,
    sig_type: WebRtcSignalType,
    data: String,
) -> Result<(), String> {
    let (ttl, max_per_peer, max_data) = CONFIG.with(|c| {
        let cfg = c.borrow();
        (cfg.signal_ttl_ns, cfg.max_signals_per_peer, cfg.max_signal_data_bytes)
    });

    if data.len() > max_data {
        return Err(format!(
            "Signal data too large: {} bytes (max {max_data})",
            data.len()
        ));
    }

    let now = ic_cdk::api::time();
    let max_id = current_max_id();

    let count = with_signals(|signals| {
        (0..max_id)
            .filter(|id| {
                signals
                    .get(id)
                    .map(|e| e.to == to && now.saturating_sub(e.timestamp) <= ttl)
                    .unwrap_or(false)
            })
            .count()
    });

    if count >= max_per_peer {
        return Err(format!(
            "Too many signals for this peer (max {max_per_peer})"
        ));
    }

    let entry = SignalEntry {
        id: next_id(),
        to,
        sig_type,
        data,
        timestamp: ic_cdk::api::time(),
    };
    with_signals_mut(|signals| {
        signals.insert(entry.id, entry);
    });
    Ok(())
}

/// Recupera i segnali destinati a `caller`, filtrando per non-scaduti.
pub fn get_my_signals(caller: Principal) -> Vec<SignalEntry> {
    let now = ic_cdk::api::time();
    let ttl = CONFIG.with(|c| c.borrow().signal_ttl_ns);
    let max_id = current_max_id();

    with_signals(|signals| {
        (0..max_id)
            .filter_map(|id| signals.get(&id))
            .filter(|e| e.to == caller && now.saturating_sub(e.timestamp) <= ttl)
            .collect()
    })
}

/// Conferma ricezione ed elimina segnali.
pub fn ack_signals(caller: Principal, owner: Principal, ids: Vec<u64>) {
    with_signals_mut(|signals| {
        for id in ids {
            if let Some(entry) = signals.get(&id) {
                if entry.to == caller || caller == owner {
                    signals.remove(&id);
                }
            }
        }
    });
}
