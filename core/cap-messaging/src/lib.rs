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
    pub edited: Option<bool>,
}

core_types::storable_candid!(OutboxMessage);

/// Record restituito al destinatario.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub struct FetchedMessage {
    pub id: u64,
    pub payload: Vec<u8>,
    pub timestamp: u64,
    pub edited: Option<bool>,
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

// ─── Helpers ────────────────────────────────────────────────────────────────

fn count_pending_for(recipient: Principal) -> u64 {
    // .iter() cammina solo le entry vive (O(vive)), non 0..max_id (O(id storici)):
    // il counter è monotono e non decresce, ma le entry rimosse non ci sono più.
    with_outbox(|outbox| {
        outbox
            .iter()
            .filter(|e| e.value().to == recipient)
            .count() as u64
    })
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/// Rimuove messaggi scaduti. Registrare in core-timer.
pub fn cleanup_expired() {
    let now = ic_cdk::api::time();

    // Raccoglie le chiavi scadute PRIMA di rimuovere (non mutare durante l'iterazione).
    let expired: Vec<u64> = with_outbox(|outbox| {
        outbox
            .iter()
            .filter_map(|e| {
                let msg = e.value();
                if now > msg.timestamp + msg.ttl_secs * 1_000_000_000 {
                    Some(*e.key())
                } else {
                    None
                }
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
                edited: None,
            },
        );
    });
    Ok(LeaveMessageResult { id, is_first })
}

/// Scarica i messaggi destinati a `caller`. Filtra per non-scaduti.
/// Il canister host deve verificare is_authorized prima di chiamare.
pub fn fetch_my_messages(caller: Principal) -> Vec<FetchedMessage> {
    let now = ic_cdk::api::time();

    with_outbox(|outbox| {
        outbox
            .iter()
            .filter_map(|e| {
                let msg = e.value();
                let not_expired = now <= msg.timestamp + msg.ttl_secs * 1_000_000_000;
                if msg.to == caller && not_expired {
                    Some(FetchedMessage {
                        id: msg.id,
                        payload: msg.payload,
                        timestamp: msg.timestamp,
                        edited: msg.edited,
                    })
                } else {
                    None
                }
            })
            .collect()
    })
}

/// Conta i messaggi non letti per `caller`.
pub fn count_my_messages(caller: Principal) -> u64 {
    let now = ic_cdk::api::time();

    with_outbox(|outbox| {
        outbox
            .iter()
            .filter(|e| {
                let msg = e.value();
                msg.to == caller && now <= msg.timestamp + msg.ttl_secs * 1_000_000_000
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

/// Cancella un messaggio ancora nel proprio outbox (non ancora consegnato/ackato).
/// Guardia (owner/user) va verificata dal canister host prima di chiamare.
pub fn delete_own_message(id: u64) -> Result<(), String> {
    let existed = with_outbox_mut(|outbox| outbox.remove(&id).is_some());
    if existed {
        Ok(())
    } else {
        Err("already delivered".to_string())
    }
}

/// Sovrascrive il payload di un messaggio ancora in outbox e marca `edited`.
/// Guardia (owner/user) va verificata dal canister host prima di chiamare.
pub fn edit_own_message(id: u64, new_payload: Vec<u8>) -> Result<(), String> {
    let max_payload = CONFIG.with(|c| c.borrow().max_payload_bytes);
    if new_payload.len() > max_payload {
        return Err(format!("Payload too large: max {max_payload} bytes"));
    }
    let found = with_outbox_mut(|outbox| {
        if let Some(mut msg) = outbox.get(&id) {
            msg.payload = new_payload;
            msg.edited = Some(true);
            outbox.insert(id, msg);
            true
        } else {
            false
        }
    });
    if found {
        Ok(())
    } else {
        Err("already delivered".to_string())
    }
}

/// Id dei messaggi ancora in outbox verso `to` (pendenti, non ancora consegnati/ackati).
pub fn pending_ids_for(to: Principal) -> Vec<u64> {
    with_outbox(|outbox| {
        outbox
            .iter()
            .filter_map(|e| if e.value().to == to { Some(*e.key()) } else { None })
            .collect()
    })
}
