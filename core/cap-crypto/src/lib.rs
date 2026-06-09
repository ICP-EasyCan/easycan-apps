//! cap-crypto — VetKeys key derivation per E2EE
//!
//! Fornisce chiavi simmetriche derivate da VetKeys (BLS12-381 G2).
//! Il frontend usa la chiave derivata per cifrare/decifrare con AES-GCM.
//!
//! Contesti di derivazione supportati:
//! - PeerConversation: chiave condivisa tra due utenti (ordine canonico → stessa chiave)
//! - StoredData: chiave per dato archiviato (file, messaggio, ecc.)
//! - Custom: contesto libero
//!
//! Frontend stub attivo — vedere core/crypto.js.
//! I messaggi viaggiano in plaintext finché E2EE non è implementato nel frontend.
//! Endpoint: get_verification_key, derive_encrypted_key
//! Storage: nessuno (stateless — le chiavi sono derivate on-demand)
//! Dipendenze: core-auth (require_owner_or_user)

use candid::{CandidType, Principal};
use serde::Deserialize;

// ─── Tipi ───────────────────────────────────────────────────────────────────

/// Contesto di derivazione — determina l'input per VetKeys.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum DerivationContext {
    /// Chiave condivisa per conversazione con un peer.
    /// Ordine canonico: min(owner, peer) + max(owner, peer) → stessa chiave per entrambi.
    PeerConversation { peer: Principal },

    /// Chiave per dato archiviato (equivalente al file_id del vault).
    StoredData { data_id: String },

    /// Contesto libero per capability future.
    Custom { context: Vec<u8> },
}

/// Tipo di curva VetKeys supportata.
#[derive(CandidType, Deserialize, Clone, Debug)]
pub enum VetKeyName {
    /// Chiave di test (per sviluppo locale e test subnet).
    TestKey1,
    /// Chiave di produzione (quando disponibile su mainnet).
    ProductionKey1,
}

// ─── Configurazione ─────────────────────────────────────────────────────────

/// Configurazione della capability crypto.
pub struct CryptoConfig {
    /// Nome della chiave VetKeys da usare.
    pub key_name: String,
}

impl Default for CryptoConfig {
    fn default() -> Self {
        Self {
            key_name: "test_key_1".to_string(),
        }
    }
}

use std::cell::RefCell;

thread_local! {
    static CONFIG: RefCell<CryptoConfig> = RefCell::new(CryptoConfig::default());
}

pub fn configure(config: CryptoConfig) {
    CONFIG.with(|c| *c.borrow_mut() = config);
}

// ─── Derivation input ───────────────────────────────────────────────────────

/// Genera l'input di derivazione dal contesto e dal principal dell'owner.
///
/// Per PeerConversation: ordine canonico dei principal →
/// Alice e Bob derivano la stessa chiave ciascuno dal proprio canister.
pub fn derivation_input(ctx: &DerivationContext, owner: Principal) -> Vec<u8> {
    match ctx {
        DerivationContext::PeerConversation { peer } => {
            let (a, b) = if owner < *peer {
                (owner, *peer)
            } else {
                (*peer, owner)
            };
            let mut buf = Vec::new();
            buf.extend_from_slice(a.as_slice());
            buf.extend_from_slice(b.as_slice());
            buf
        }
        DerivationContext::StoredData { data_id } => {
            let mut buf = Vec::new();
            buf.extend_from_slice(data_id.as_bytes());
            buf.extend_from_slice(owner.as_slice());
            buf
        }
        DerivationContext::Custom { context } => {
            let mut buf = context.clone();
            buf.extend_from_slice(owner.as_slice());
            buf
        }
    }
}

// ─── VetKeys helpers ────────────────────────────────────────────────────────

fn vet_key_id() -> ic_cdk::management_canister::VetKDKeyId {
    let key_name = CONFIG.with(|c| c.borrow().key_name.clone());
    ic_cdk::management_canister::VetKDKeyId {
        curve: ic_cdk::management_canister::VetKDCurve::Bls12_381_G2,
        name: key_name,
    }
}

// ─── Funzioni pubbliche (async — wrappate dal canister host) ────────────────

/// Ottiene la chiave di verifica pubblica per un contesto.
/// Il canister host deve wrappare con #[update] (è una management canister call).
///
/// `context_name`: "messaging", "archive", "vault", ecc.
pub async fn get_verification_key(context_name: String) -> Result<String, String> {
    let request = ic_cdk::management_canister::VetKDPublicKeyArgs {
        canister_id: None,
        context: context_name.into_bytes(),
        key_id: vet_key_id(),
    };
    let response = ic_cdk::management_canister::vetkd_public_key(&request)
        .await
        .map_err(|e| format!("vetkd_public_key failed: {e:?}"))?;
    Ok(hex::encode(response.public_key))
}

/// Deriva una chiave simmetrica cifrata per il frontend.
/// Il canister host deve verificare require_owner_or_user e wrappare con #[update].
///
/// `context_name`: stessa stringa usata per get_verification_key.
/// `derivation_ctx`: contesto di derivazione (PeerConversation, StoredData, Custom).
/// `transport_public_key`: chiave pubblica effimera del frontend (per cifrare il trasporto).
/// `owner`: principal dell'owner/user (per calcolare il derivation input).
pub async fn derive_encrypted_key(
    context_name: String,
    derivation_ctx: DerivationContext,
    transport_public_key: Vec<u8>,
    owner: Principal,
) -> Result<String, String> {
    let input = derivation_input(&derivation_ctx, owner);

    let request = ic_cdk::management_canister::VetKDDeriveKeyArgs {
        input,
        context: context_name.into_bytes(),
        key_id: vet_key_id(),
        transport_public_key,
    };
    let response = ic_cdk::management_canister::vetkd_derive_key(&request)
        .await
        .map_err(|e| format!("vetkd_derive_key failed: {e:?}"))?;
    Ok(hex::encode(response.encrypted_key))
}

// ─── Test ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: u8) -> Principal {
        Principal::from_slice(&[id])
    }

    #[test]
    fn peer_conversation_canonical_order() {
        // Alice→Bob e Bob→Alice devono produrre lo stesso input
        let alice = p(1);
        let bob = p(2);

        let ctx_ab = DerivationContext::PeerConversation { peer: bob };
        let ctx_ba = DerivationContext::PeerConversation { peer: alice };

        let input_ab = derivation_input(&ctx_ab, alice);
        let input_ba = derivation_input(&ctx_ba, bob);

        assert_eq!(input_ab, input_ba, "Canonical ordering must produce same key");
    }

    #[test]
    fn peer_conversation_different_peers_different_keys() {
        let alice = p(1);
        let bob = p(2);
        let charlie = p(3);

        let ctx_ab = DerivationContext::PeerConversation { peer: bob };
        let ctx_ac = DerivationContext::PeerConversation { peer: charlie };

        assert_ne!(
            derivation_input(&ctx_ab, alice),
            derivation_input(&ctx_ac, alice),
        );
    }

    #[test]
    fn stored_data_includes_owner() {
        let owner = p(1);
        let ctx = DerivationContext::StoredData {
            data_id: "file_42".into(),
        };
        let input = derivation_input(&ctx, owner);
        assert!(input.starts_with(b"file_42"));
        assert!(input.len() > 7); // data_id + owner bytes
    }

    #[test]
    fn custom_context() {
        let owner = p(1);
        let ctx = DerivationContext::Custom {
            context: vec![0xDE, 0xAD],
        };
        let input = derivation_input(&ctx, owner);
        assert_eq!(input[0], 0xDE);
        assert_eq!(input[1], 0xAD);
    }
}
