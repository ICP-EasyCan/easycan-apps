//! cap-notify — pending senders + pending callers (unificato)
//!
//! Quando Alice lascia un messaggio per Bob, il frontend di Alice notifica
//! il canister di Bob aggiungendo Alice ai "pending senders".
//! Stesso meccanismo per le chiamate (pending callers).
//!
//! Endpoint: notify_pending, get_pending_senders, get_pending_callers,
//!           clear_pending_sender, clear_pending_caller
//! Storage: 2 MemoryId (SENDERS + CALLERS)
//! Dipendenze: core-auth (require_authorized, require_owner_or_user)

use candid::{CandidType, Principal};
use core_types::Memory;
use ic_stable_structures::{storable::Bound, StableBTreeMap, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

// ─── Tipi ───────────────────────────────────────────────────────────────────

/// Lista di Principal serializzata come Candid.
#[derive(CandidType, Deserialize, Default, Clone)]
struct PrincipalList(Vec<Principal>);

impl Storable for PrincipalList {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(&self.0).unwrap())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        PrincipalList(candid::decode_one(&bytes).unwrap())
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    const BOUND: Bound = Bound::Unbounded;
}

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static PENDING_SENDERS: RefCell<Option<StableBTreeMap<u8, PrincipalList, Memory>>> =
        const { RefCell::new(None) };

    static PENDING_CALLERS: RefCell<Option<StableBTreeMap<u8, PrincipalList, Memory>>> =
        const { RefCell::new(None) };
}

// ─── Init ───────────────────────────────────────────────────────────────────

pub fn init_storage(senders_mem: Memory, callers_mem: Memory) {
    PENDING_SENDERS.with(|p| {
        *p.borrow_mut() = Some(StableBTreeMap::init(senders_mem));
    });
    PENDING_CALLERS.with(|p| {
        *p.borrow_mut() = Some(StableBTreeMap::init(callers_mem));
    });
}

// ─── Helpers (operano su thread_local via macro) ────────────────────────────

macro_rules! with_map {
    ($tl:ident, $f:expr) => {
        $tl.with(|p| {
            let borrow = p.borrow();
            let map = borrow.as_ref().expect("cap-notify: init_storage() not called");
            $f(map)
        })
    };
}

macro_rules! with_map_mut {
    ($tl:ident, $f:expr) => {
        $tl.with(|p| {
            let mut borrow = p.borrow_mut();
            let map = borrow.as_mut().expect("cap-notify: init_storage() not called");
            $f(map)
        })
    };
}

// ─── Pending Senders ────────────────────────────────────────────────────────

/// Segnala che `caller` ha messaggi in attesa per l'owner di questo canister.
/// Il canister host deve verificare require_authorized.
/// Idempotente: aggiungere lo stesso sender più volte non crea duplicati.
pub fn notify_pending_message(caller: Principal) {
    let mut list: Vec<Principal> = with_map!(PENDING_SENDERS, |map: &StableBTreeMap<u8, PrincipalList, Memory>| {
        map.get(&0u8).map(|l| l.0).unwrap_or_default()
    });
    if !list.contains(&caller) {
        list.push(caller);
        with_map_mut!(PENDING_SENDERS, |map: &mut StableBTreeMap<u8, PrincipalList, Memory>| {
            map.insert(0u8, PrincipalList(list));
        });
    }
}

/// Lista dei mittenti con messaggi in attesa.
pub fn get_pending_senders() -> Vec<Principal> {
    with_map!(PENDING_SENDERS, |map: &StableBTreeMap<u8, PrincipalList, Memory>| {
        map.get(&0u8).map(|l| l.0).unwrap_or_default()
    })
}

/// Rimuove un mittente dalla lista pending.
pub fn clear_pending_sender(sender: Principal) {
    let list: Vec<Principal> = get_pending_senders()
        .into_iter()
        .filter(|&p| p != sender)
        .collect();
    with_map_mut!(PENDING_SENDERS, |map: &mut StableBTreeMap<u8, PrincipalList, Memory>| {
        map.insert(0u8, PrincipalList(list));
    });
}

// ─── Pending Callers ────────────────────────────────────────────────────────

/// Segnala che `caller` vuole chiamare l'owner di questo canister.
/// Idempotente.
pub fn notify_pending_call(caller: Principal) {
    let mut list: Vec<Principal> = with_map!(PENDING_CALLERS, |map: &StableBTreeMap<u8, PrincipalList, Memory>| {
        map.get(&0u8).map(|l| l.0).unwrap_or_default()
    });
    if !list.contains(&caller) {
        list.push(caller);
        with_map_mut!(PENDING_CALLERS, |map: &mut StableBTreeMap<u8, PrincipalList, Memory>| {
            map.insert(0u8, PrincipalList(list));
        });
    }
}

/// Lista dei caller con chiamate in attesa.
pub fn get_pending_callers() -> Vec<Principal> {
    with_map!(PENDING_CALLERS, |map: &StableBTreeMap<u8, PrincipalList, Memory>| {
        map.get(&0u8).map(|l| l.0).unwrap_or_default()
    })
}

/// Rimuove un caller dalla lista pending call.
pub fn clear_pending_caller(caller: Principal) {
    let list: Vec<Principal> = get_pending_callers()
        .into_iter()
        .filter(|&p| p != caller)
        .collect();
    with_map_mut!(PENDING_CALLERS, |map: &mut StableBTreeMap<u8, PrincipalList, Memory>| {
        map.insert(0u8, PrincipalList(list));
    });
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        init_storage(mm.get(MemoryId::new(40)), mm.get(MemoryId::new(41)));
    }

    fn p(id: u8) -> Principal {
        Principal::from_slice(&[id])
    }

    #[test]
    fn pending_senders_empty_initially() {
        setup();
        assert!(get_pending_senders().is_empty());
    }

    #[test]
    fn notify_and_get_senders() {
        setup();
        notify_pending_message(p(1));
        notify_pending_message(p(2));
        let senders = get_pending_senders();
        assert_eq!(senders.len(), 2);
        assert!(senders.contains(&p(1)));
        assert!(senders.contains(&p(2)));
    }

    #[test]
    fn notify_idempotent() {
        setup();
        notify_pending_message(p(1));
        notify_pending_message(p(1));
        notify_pending_message(p(1));
        assert_eq!(get_pending_senders().len(), 1);
    }

    #[test]
    fn clear_sender() {
        setup();
        notify_pending_message(p(1));
        notify_pending_message(p(2));
        clear_pending_sender(p(1));
        let senders = get_pending_senders();
        assert_eq!(senders.len(), 1);
        assert_eq!(senders[0], p(2));
    }

    #[test]
    fn pending_callers_mirror() {
        setup();
        assert!(get_pending_callers().is_empty());
        notify_pending_call(p(10));
        notify_pending_call(p(10)); // idempotente
        assert_eq!(get_pending_callers().len(), 1);
        clear_pending_caller(p(10));
        assert!(get_pending_callers().is_empty());
    }

    #[test]
    fn senders_and_callers_independent() {
        setup();
        notify_pending_message(p(1));
        notify_pending_call(p(2));
        assert_eq!(get_pending_senders().len(), 1);
        assert_eq!(get_pending_callers().len(), 1);
        assert_eq!(get_pending_senders()[0], p(1));
        assert_eq!(get_pending_callers()[0], p(2));
    }
}
