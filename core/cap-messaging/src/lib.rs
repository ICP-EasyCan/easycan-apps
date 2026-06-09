//! cap-messaging — outbox messaggi con TTL
//!
//! L'owner lascia messaggi per peer offline nel proprio canister.
//! Il peer scarica i messaggi (query gratis) e conferma la ricezione (ack).
//!
//! Endpoint: leave_message, fetch_my_messages, count_my_messages, ack_messages
//! Timer: cleanup_expired (registrato via core-timer)
//! Storage: 2 MemoryId (OUTBOX + COUNTER)
//! Dipendenze: core-auth (is_authorized, require_owner_or_user)

use candid::{CandidType, Principal};
use core_storage::StableCounter;
use core_types::Memory;
use ic_stable_structures::StableBTreeMap;
use serde::Deserialize;
use std::cell::RefCell;

// ─── Configurazione ─────────────────────────────────────────────────────────

pub struct MessagingConfig {
    pub max_payload_bytes: usize,
    pub max_pending_per_recipient: u64,
}

impl Default for MessagingConfig {
    fn default() -> Self {
        Self {
            max_payload_bytes: 512,
            max_pending_per_recipient: 50,
        }
    }
}

// ─── Tipi ───────────────────────────────────────────────────────────────────

#[derive(CandidType, Deserialize, Clone, Debug)]
struct OutboxMessage {
    pub id: u64,
    pub to: Principal,
    pub payload: Vec<u8>,
    pub timestamp: u64,
    pub ttl_secs: u64,
}

core_types::storable_candid!(OutboxMessage);

/// Record restituito al destinatario.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct FetchedMessage {
    pub id: u64,
    pub payload: Vec<u8>,
    pub timestamp: u64,
}

/// Risultato di leave_message — is_first per evitare notifiche ridondanti.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct LeaveMessageResult {
    pub id: u64,
    pub is_first: bool,
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static OUTBOX: RefCell<Option<StableBTreeMap<u64, OutboxMessage, Memory>>> =
        const { RefCell::new(None) };

    static COUNTER: RefCell<Option<StableCounter>> = const { RefCell::new(None) };

    static CONFIG: RefCell<MessagingConfig> = RefCell::new(MessagingConfig::default());
}

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_storage(outbox_mem: Memory, counter_mem: Memory) {
    OUTBOX.with(|o| {
        *o.borrow_mut() = Some(StableBTreeMap::init(outbox_mem));
    });
    COUNTER.with(|c| {
        *c.borrow_mut() = Some(StableCounter::new(counter_mem));
    });
}

pub fn configure(config: MessagingConfig) {
    CONFIG.with(|c| *c.borrow_mut() = config);
}

fn with_outbox<R>(f: impl FnOnce(&StableBTreeMap<u64, OutboxMessage, Memory>) -> R) -> R {
    OUTBOX.with(|o| {
        let borrow = o.borrow();
        f(borrow
            .as_ref()
            .expect("cap-messaging: init_storage() not called"))
    })
}

fn with_outbox_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u64, OutboxMessage, Memory>) -> R,
) -> R {
    OUTBOX.with(|o| {
        let mut borrow = o.borrow_mut();
        f(borrow
            .as_mut()
            .expect("cap-messaging: init_storage() not called"))
    })
}

fn next_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-messaging: init_storage() not called")
            .next_id()
    })
}

fn current_max_id() -> u64 {
    COUNTER.with(|c| {
        c.borrow()
            .as_ref()
            .expect("cap-messaging: init_storage() not called")
            .current()
    })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn count_pending_for(recipient: Principal) -> u64 {
    let max_id = current_max_id();
    with_outbox(|outbox| {
        (0..max_id)
            .filter(|id| {
                outbox
                    .get(id)
                    .map(|msg| msg.to == recipient)
                    .unwrap_or(false)
            })
            .count() as u64
    })
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/// Rimuove messaggi scaduti. Registrare in core-timer.
pub fn cleanup_expired() {
    let now = ic_cdk::api::time();
    let max_id = current_max_id();

    let expired: Vec<u64> = with_outbox(|outbox| {
        (0..max_id)
            .filter(|id| {
                outbox
                    .get(id)
                    .map(|msg| now > msg.timestamp + msg.ttl_secs * 1_000_000_000)
                    .unwrap_or(false)
            })
            .collect()
    });

    with_outbox_mut(|outbox| {
        for id in expired {
            outbox.remove(&id);
        }
    });
}

// ─── Funzioni pubbliche ─────────────────────────────────────────────────────

/// Lascia un messaggio per un peer.
/// Il canister host deve verificare require_owner_or_user prima di chiamare.
pub fn leave_message(
    to: Principal,
    payload: Vec<u8>,
    ttl_secs: u64,
) -> Result<LeaveMessageResult, String> {
    let (max_payload, max_pending) =
        CONFIG.with(|c| {
            let cfg = c.borrow();
            (cfg.max_payload_bytes, cfg.max_pending_per_recipient)
        });

    if payload.len() > max_payload {
        return Err(format!("Payload too large: max {max_payload} bytes"));
    }

    let pending_count = count_pending_for(to);
    if pending_count >= max_pending {
        return Err(format!(
            "Too many pending messages for this recipient: max {max_pending}"
        ));
    }

    let is_first = pending_count == 0;
    let id = next_id();
    with_outbox_mut(|outbox| {
        outbox.insert(
            id,
            OutboxMessage {
                id,
                to,
                payload,
                timestamp: ic_cdk::api::time(),
                ttl_secs,
            },
        );
    });
    Ok(LeaveMessageResult { id, is_first })
}

/// Scarica i messaggi destinati a `caller`. Filtra per non-scaduti.
/// Il canister host deve verificare is_authorized prima di chiamare.
pub fn fetch_my_messages(caller: Principal) -> Vec<FetchedMessage> {
    let now = ic_cdk::api::time();
    let max_id = current_max_id();

    with_outbox(|outbox| {
        (0..max_id)
            .filter_map(|id| outbox.get(&id))
            .filter(|msg| {
                let not_expired = now <= msg.timestamp + msg.ttl_secs * 1_000_000_000;
                msg.to == caller && not_expired
            })
            .map(|msg| FetchedMessage {
                id: msg.id,
                payload: msg.payload.clone(),
                timestamp: msg.timestamp,
            })
            .collect()
    })
}

/// Conta i messaggi non letti per `caller`.
pub fn count_my_messages(caller: Principal) -> u64 {
    let now = ic_cdk::api::time();
    let max_id = current_max_id();

    with_outbox(|outbox| {
        (0..max_id)
            .filter(|id| {
                outbox
                    .get(id)
                    .map(|msg| {
                        msg.to == caller
                            && now <= msg.timestamp + msg.ttl_secs * 1_000_000_000
                    })
                    .unwrap_or(false)
            })
            .count() as u64
    })
}

/// Conferma ricezione ed elimina messaggi.
/// `owner` è il principal dell'owner del canister (può cancellare qualsiasi messaggio).
pub fn ack_messages(caller: Principal, owner: Principal, ids: Vec<u64>) {
    with_outbox_mut(|outbox| {
        for id in ids {
            if let Some(msg) = outbox.get(&id) {
                if msg.to == caller || caller == owner {
                    outbox.remove(&id);
                }
            }
        }
    });
}
