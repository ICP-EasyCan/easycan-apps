//! core-types — tipi condivisi da tutti i crate del framework
//!
//! Contiene: StorablePrincipal, tipi di errore, Memory alias,
//! e il trait Storable via Candid riutilizzabile.

use candid::Principal;
use ic_stable_structures::memory_manager::VirtualMemory;
use ic_stable_structures::{storable::Bound, DefaultMemoryImpl, Storable};
use std::borrow::Cow;

// ─── Memory alias ────────────────────────────────────────────────────────────

/// Tipo di memoria usato da tutti i crate — VirtualMemory allocata dal MemoryManager.
pub type Memory = VirtualMemory<DefaultMemoryImpl>;

// ─── StorablePrincipal ───────────────────────────────────────────────────────

/// Wrapper di Principal per usarlo come chiave/valore in StableBTreeMap.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct StorablePrincipal(pub Principal);

impl StorablePrincipal {
    pub fn new(p: Principal) -> Self {
        Self(p)
    }

    pub fn principal(&self) -> &Principal {
        &self.0
    }
}

impl Storable for StorablePrincipal {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(self.0.as_slice().to_vec())
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        StorablePrincipal(Principal::from_slice(&bytes))
    }
    fn into_bytes(self) -> Vec<u8> {
        self.to_bytes().into_owned()
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 29,
        is_fixed_size: false,
    };
}

impl From<Principal> for StorablePrincipal {
    fn from(p: Principal) -> Self {
        Self(p)
    }
}

impl From<StorablePrincipal> for Principal {
    fn from(sp: StorablePrincipal) -> Self {
        sp.0
    }
}

// ─── Marker vuoto (per set-like StableBTreeMap) ──────────────────────────────

/// Marker vuoto — usato come valore quando serve una mappa usata come set.
/// Esempio: whitelist = StableBTreeMap<StorablePrincipal, EmptyMarker, Memory>
#[derive(Default, Clone, Debug)]
pub struct EmptyMarker;

impl Storable for EmptyMarker {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(vec![1])
    }
    fn from_bytes(_: Cow<'_, [u8]>) -> Self {
        EmptyMarker
    }
    fn into_bytes(self) -> Vec<u8> {
        vec![1]
    }
    const BOUND: Bound = Bound::Bounded {
        max_size: 1,
        is_fixed_size: true,
    };
}

// ─── Errori comuni ───────────────────────────────────────────────────────────

/// Errore standard restituito dalle capability.
#[derive(Debug, Clone)]
pub enum CoreError {
    Unauthorized(String),
    LimitExceeded(String),
    NotFound(String),
    InvalidInput(String),
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::Unauthorized(msg) => write!(f, "Unauthorized: {msg}"),
            CoreError::LimitExceeded(msg) => write!(f, "Limit exceeded: {msg}"),
            CoreError::NotFound(msg) => write!(f, "Not found: {msg}"),
            CoreError::InvalidInput(msg) => write!(f, "Invalid input: {msg}"),
        }
    }
}

impl From<CoreError> for String {
    fn from(e: CoreError) -> Self {
        e.to_string()
    }
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storable_principal_roundtrip() {
        let p = Principal::from_text("2vxsx-fae").unwrap();
        let sp = StorablePrincipal::new(p);
        let bytes = sp.to_bytes();
        let sp2 = StorablePrincipal::from_bytes(bytes);
        assert_eq!(sp, sp2);
        assert_eq!(*sp2.principal(), p);
    }

    #[test]
    fn storable_principal_ordering() {
        let a = StorablePrincipal::new(Principal::from_slice(&[1]));
        let b = StorablePrincipal::new(Principal::from_slice(&[2]));
        assert!(a < b);
    }

    #[test]
    fn storable_principal_from_into() {
        let p = Principal::from_slice(&[1, 2, 3]);
        let sp: StorablePrincipal = p.into();
        let p2: Principal = sp.into();
        assert_eq!(p, p2);
    }

    #[test]
    fn empty_marker_roundtrip() {
        let m = EmptyMarker;
        let bytes = m.to_bytes();
        assert_eq!(bytes.len(), 1);
        let _ = EmptyMarker::from_bytes(bytes);
    }

    #[test]
    fn core_error_display() {
        let e = CoreError::Unauthorized("test".into());
        assert_eq!(e.to_string(), "Unauthorized: test");
        let e = CoreError::NotFound("x".into());
        assert_eq!(e.to_string(), "Not found: x");
    }

    #[test]
    fn core_error_into_string() {
        let e = CoreError::Unauthorized("denied".into());
        let s: String = e.into();
        assert!(s.contains("Unauthorized"));
    }
}

// ─── Storable via Candid (helper) ────────────────────────────────────────────

/// Macro per implementare Storable via serializzazione Candid.
/// Usata dai tipi complessi che non hanno un layout fisso.
///
/// ```rust,ignore
/// #[derive(CandidType, Deserialize, Clone, Debug)]
/// struct MyType { ... }
/// storable_candid!(MyType);
/// ```
#[macro_export]
macro_rules! storable_candid {
    ($t:ty) => {
        impl ::ic_stable_structures::Storable for $t {
            fn to_bytes(&self) -> ::std::borrow::Cow<[u8]> {
                ::std::borrow::Cow::Owned(::candid::encode_one(self).unwrap())
            }
            fn from_bytes(bytes: ::std::borrow::Cow<[u8]>) -> Self {
                ::candid::decode_one(&bytes).unwrap()
            }
            fn into_bytes(self) -> Vec<u8> {
                self.to_bytes().into_owned()
            }
            const BOUND: ::ic_stable_structures::storable::Bound =
                ::ic_stable_structures::storable::Bound::Unbounded;
        }
    };
}

// ─── app_version (self-upgrade §B) ────────────────────────────────────────────

/// Versione semver dell'app, letta a **compile-time** dal `Cargo.toml` del crate chiamante.
///
/// È una macro, non una funzione, di proposito: `env!("CARGO_PKG_VERSION")` si risolve nel crate
/// dove viene *scritto*; una funzione in `core-types` catturerebbe la versione di `core-types`, non
/// dell'app. Espandendola nell'app, `Cargo.toml [package] version` resta l'**unica fonte di verità**
/// per la versione, condivisa con il `manifest.version` della GitHub Release (self-upgrade §B Fase 0):
/// così l'endpoint `app_version()` e il manifest non possono divergere.
///
/// ```rust,ignore
/// #[ic_cdk::query]
/// fn app_version() -> String { core_types::app_version!() }
/// ```
#[macro_export]
macro_rules! app_version {
    () => {
        env!("CARGO_PKG_VERSION").to_string()
    };
}
