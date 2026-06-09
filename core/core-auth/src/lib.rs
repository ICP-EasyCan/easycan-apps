//! core-auth — ownership, whitelist, claim, guard functions
//!
//! Due livelli di autorità:
//!   key 0u8 = dfx owner (deploy, upload asset, gestione tecnica)
//!   key 1u8 = user principal (Internet Identity, messaggistica, whitelist)
//!   key 2u8 = flag "claim aperto" (sentinel per allow_claim/claim_user_principal)
//!
//! Nessun #[update]/#[query] qui — solo funzioni pubbliche.
//! Il canister host le wrappa con le macro ic-cdk.

use candid::Principal;
use core_types::{EmptyMarker, Memory, StorablePrincipal};
use ic_stable_structures::StableBTreeMap;
use std::cell::RefCell;

// ─── Storage ────────────────────────────────────────────────────────────────

thread_local! {
    static OWNER: RefCell<Option<StableBTreeMap<u8, StorablePrincipal, Memory>>> =
        const { RefCell::new(None) };

    static WHITELIST: RefCell<Option<StableBTreeMap<StorablePrincipal, EmptyMarker, Memory>>> =
        const { RefCell::new(None) };
}

// ─── Init (chiamata dal canister host) ──────────────────────────────────────

/// Inizializza le strutture auth con le memory allocate dal MemoryManager.
/// Deve essere chiamata una volta sola, in init() del canister host.
pub fn init_storage(owner_mem: Memory, whitelist_mem: Memory) {
    OWNER.with(|o| {
        *o.borrow_mut() = Some(StableBTreeMap::init(owner_mem));
    });
    WHITELIST.with(|w| {
        *w.borrow_mut() = Some(StableBTreeMap::init(whitelist_mem));
    });
}

// ─── Helpers interni ────────────────────────────────────────────────────────

fn with_owner<R>(f: impl FnOnce(&StableBTreeMap<u8, StorablePrincipal, Memory>) -> R) -> R {
    OWNER.with(|o| {
        let borrow = o.borrow();
        let map = borrow.as_ref().expect("core-auth: init_storage() not called");
        f(map)
    })
}

fn with_owner_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<u8, StorablePrincipal, Memory>) -> R,
) -> R {
    OWNER.with(|o| {
        let mut borrow = o.borrow_mut();
        let map = borrow.as_mut().expect("core-auth: init_storage() not called");
        f(map)
    })
}

fn with_whitelist<R>(
    f: impl FnOnce(&StableBTreeMap<StorablePrincipal, EmptyMarker, Memory>) -> R,
) -> R {
    WHITELIST.with(|w| {
        let borrow = w.borrow();
        let map = borrow.as_ref().expect("core-auth: init_storage() not called");
        f(map)
    })
}

fn with_whitelist_mut<R>(
    f: impl FnOnce(&mut StableBTreeMap<StorablePrincipal, EmptyMarker, Memory>) -> R,
) -> R {
    WHITELIST.with(|w| {
        let mut borrow = w.borrow_mut();
        let map = borrow.as_mut().expect("core-auth: init_storage() not called");
        f(map)
    })
}

// ─── Owner ──────────────────────────────────────────────────────────────────

/// Imposta l'owner dfx del canister (key 0u8).
pub fn set_owner(p: Principal) {
    with_owner_mut(|m| {
        m.insert(0u8, StorablePrincipal(p));
    });
}

/// Ritorna l'owner dfx del canister.
pub fn owner() -> Principal {
    with_owner(|m| m.get(&0u8).map(|sp| sp.0).unwrap_or(Principal::anonymous()))
}

// ─── User Principal (Internet Identity) ─────────────────────────────────────

/// Ritorna l'user principal II, se registrato.
pub fn user_principal() -> Option<Principal> {
    with_owner(|m| m.get(&1u8).map(|sp| sp.0))
}

/// Imposta direttamente l'user principal. Usato internamente da claim.
pub fn set_user_principal(p: Principal) {
    with_owner_mut(|m| {
        m.insert(1u8, StorablePrincipal(p));
    });
}

// ─── Claim mechanism ────────────────────────────────────────────────────────

/// Apre la finestra di claim — dopo questa chiamata, chiunque può diventare user
/// chiamando claim_user_principal(). Richiede owner o user II.
pub fn allow_claim(caller: Principal) -> Result<(), String> {
    require_owner_or_user(caller)?;
    with_owner_mut(|m| {
        m.insert(2u8, StorablePrincipal(Principal::anonymous()));
    });
    Ok(())
}

/// Registra il caller come user principal. Funziona solo se allow_claim() è stato chiamato.
/// La finestra resta aperta per permettere re-claim (necessario per II in incognito).
pub fn claim_user_principal(caller: Principal) -> Result<(), String> {
    let has_claim = with_owner(|m| m.contains_key(&2u8));
    if has_claim {
        set_user_principal(caller);
        Ok(())
    } else {
        Err("Claim non abilitato".to_string())
    }
}

// ─── Guard functions ────────────────────────────────────────────────────────

/// Verifica che il caller sia l'owner dfx.
pub fn require_owner(caller: Principal) -> Result<(), String> {
    if caller == owner() {
        Ok(())
    } else {
        Err("Unauthorized: caller is not the owner".to_string())
    }
}

/// Verifica che il caller sia l'owner dfx oppure l'user II.
pub fn require_owner_or_user(caller: Principal) -> Result<(), String> {
    if caller == owner() {
        return Ok(());
    }
    if let Some(up) = user_principal() {
        if caller == up {
            return Ok(());
        }
    }
    Err("Unauthorized: caller is not the owner or user".to_string())
}

/// Controlla se un principal è autorizzato (owner, user II, o whitelist).
pub fn is_authorized(p: Principal) -> bool {
    if p == owner() {
        return true;
    }
    if let Some(up) = user_principal() {
        if p == up {
            return true;
        }
    }
    with_whitelist(|w| w.contains_key(&StorablePrincipal(p)))
}

/// Verifica che il caller sia autorizzato (owner, user II, o whitelist).
pub fn require_authorized(caller: Principal) -> Result<(), String> {
    if is_authorized(caller) {
        Ok(())
    } else {
        Err("Unauthorized: caller is not whitelisted".to_string())
    }
}

// ─── Whitelist ──────────────────────────────────────────────────────────────

/// Aggiunge un peer alla whitelist. Richiede owner o user II.
pub fn add_to_whitelist(caller: Principal, peer: Principal) -> Result<(), String> {
    require_owner_or_user(caller)?;
    with_whitelist_mut(|w| {
        w.insert(StorablePrincipal(peer), EmptyMarker);
    });
    Ok(())
}

/// Rimuove un peer dalla whitelist. Richiede owner o user II.
pub fn remove_from_whitelist(caller: Principal, peer: Principal) -> Result<(), String> {
    require_owner_or_user(caller)?;
    with_whitelist_mut(|w| {
        w.remove(&StorablePrincipal(peer));
    });
    Ok(())
}

/// Controlla se un peer è in whitelist (o è owner/user).
pub fn is_whitelisted(peer: Principal) -> bool {
    is_authorized(peer)
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ic_stable_structures::memory_manager::MemoryId;

    fn setup() {
        let mm = core_storage::new_memory_manager();
        init_storage(mm.get(MemoryId::new(0)), mm.get(MemoryId::new(1)));
    }

    fn p(id: u8) -> Principal {
        Principal::from_slice(&[id])
    }

    #[test]
    fn owner_set_and_get() {
        setup();
        set_owner(p(1));
        assert_eq!(owner(), p(1));
    }

    #[test]
    fn require_owner_ok() {
        setup();
        set_owner(p(1));
        assert!(require_owner(p(1)).is_ok());
        assert!(require_owner(p(2)).is_err());
    }

    #[test]
    fn user_principal_none_initially() {
        setup();
        assert_eq!(user_principal(), None);
    }

    #[test]
    fn claim_flow() {
        setup();
        set_owner(p(1));

        // Claim non aperto → errore
        assert!(claim_user_principal(p(10)).is_err());

        // Owner apre il claim
        assert!(allow_claim(p(1)).is_ok());

        // Chiunque può claimare
        assert!(claim_user_principal(p(10)).is_ok());
        assert_eq!(user_principal(), Some(p(10)));

        // Re-claim funziona (finestra resta aperta)
        assert!(claim_user_principal(p(20)).is_ok());
        assert_eq!(user_principal(), Some(p(20)));
    }

    #[test]
    fn require_owner_or_user() {
        setup();
        set_owner(p(1));
        set_user_principal(p(10));

        assert!(super::require_owner_or_user(p(1)).is_ok());
        assert!(super::require_owner_or_user(p(10)).is_ok());
        assert!(super::require_owner_or_user(p(99)).is_err());
    }

    #[test]
    fn whitelist_add_remove() {
        setup();
        set_owner(p(1));

        // Solo owner può aggiungere
        assert!(add_to_whitelist(p(99), p(50)).is_err());
        assert!(add_to_whitelist(p(1), p(50)).is_ok());

        assert!(is_whitelisted(p(50)));
        assert!(!is_whitelisted(p(51)));

        // Rimuovi
        assert!(remove_from_whitelist(p(1), p(50)).is_ok());
        assert!(!is_whitelisted(p(50)));
    }

    #[test]
    fn is_authorized_all_levels() {
        setup();
        set_owner(p(1));
        set_user_principal(p(10));
        let _ = add_to_whitelist(p(1), p(50));

        assert!(is_authorized(p(1)));   // owner
        assert!(is_authorized(p(10)));  // user
        assert!(is_authorized(p(50)));  // whitelist
        assert!(!is_authorized(p(99))); // nessuno
    }

    #[test]
    fn require_authorized_guard() {
        setup();
        set_owner(p(1));
        assert!(require_authorized(p(1)).is_ok());
        assert!(require_authorized(p(99)).is_err());
    }
}
