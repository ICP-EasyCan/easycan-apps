# Sovereign Messenger

## Scopo

Messaggistica decentralizzata su ICP. Un canister per utente — funziona come relay personale.
Messaggi di testo via canister (outbox), chiamate vocali via WebRTC (signaling via canister).

## Modello

Ogni utente deploya il proprio canister. Il canister contiene backend + frontend (servito da stable memory).

```
[Canister di Alice]                    [Canister di Bob]
  dfx_owner: alice_dfx_principal         dfx_owner: bob_dfx_principal
  user_principal: alice_ii_principal     user_principal: bob_ii_principal
  whitelist: [bob_ii_principal, ...]     whitelist: [alice_ii_principal, ...]
  signal_board → segnali WebRTC          signal_board → segnali WebRTC
  outbox → messaggi                      outbox → messaggi
  pending_callers → chi vuole chiamare   pending_callers → chi vuole chiamare
  archive → cronologia persistente       archive → cronologia persistente
  persist_flags → chat con 📌 attivo     persist_flags → chat con 📌 attivo
  assets → frontend (stable mem)         assets → frontend (stable mem)
```

## Blocchi backend richiesti

Tutti i blocchi della fabbrica:

| Blocco | Uso |
|---|---|
| core-types | Tipi base, StorablePrincipal, Memory |
| core-auth | Owner/user/whitelist/claim/guards |
| core-storage | MemoryManager, MemoryId, StableCounter |
| core-timer | Timer consolidato cleanup |
| core-assets | Asset storage + HTTP serving + cert v2 |
| cap-presence | Heartbeat online/offline |
| cap-messaging | Outbox messaggi con TTL |
| cap-signaling | Signal board WebRTC |
| cap-notify | Pending senders + callers |
| cap-archive | Cronologia persistente + persist flags |
| cap-crypto | VetKeys E2EE (stub per ora) |

## Blocchi frontend richiesti

| Blocco (dalla fabbrica) | Uso |
|---|---|
| core/event-bus.js | Comunicazione tra moduli |
| core/config.js | Canister ID, host, URLs |
| core/auth.js | Internet Identity login/logout |
| core/icp.js | Actor management, call/query |
| core/crypto.js | E2EE stub (passthrough) |
| ui/dom.js | Helpers DOM |
| ui/router.js | Hash router |

## Logica app-specifica (da scrivere)

### Pagine
- **login** — Internet Identity login + claim automatico
- **chats** — Lista contatti con indicatori pending (pallino rosso/verde), count on-demand (🔍)
- **chat** — Conversazione con un peer: invio/ricezione messaggi, bottone chiamata, toggle 📌 archivio
- **settings** — Gestione contatti (add/remove whitelist)

### Componenti
- **call-banner** — Banner chiamata globale (stato: idle/calling/connecting/connected/ended, mute, riaggancia)

### Moduli
- **connection-manager.js** — Presenza, pending poll, chiamate WebRTC + call state machine
- **contacts-store.js** — localStorage contatti condiviso tra pagine
- **transport/webrtc.js** — Implementazione WebRTC (usata per chiamate, non per messaggi)

### Flussi
1. **Messaggi**: `leave_message` → outbox peer → `fetch_my_messages` (poll 3s) → `ack_messages`
2. **Notifiche**: `notify_pending_message` al primo messaggio → peer vede pallino rosso
3. **Chiamate**: `notify_pending_call` → callee crea Offer → caller Answer → ICE → connessi
4. **Archivio**: localStorage automatico + toggle 📌 per backup su canister
5. **Presenza**: piggyback su update call (throttle 60s), cleanup stale 90s

## Endpoint canister

### Update
- `allow_claim()` — apre finestra claim
- `claim_user_principal()` — II principal diventa user
- `add_to_whitelist(peer)` / `remove_from_whitelist(peer)`
- `leave_message(to, payload, ttl_secs)` → `LeaveMessageResult`
- `ack_messages(ids)`
- `set_presence(online)`
- `post_signal(to, sig_type, data)`
- `ack_signals(ids)`
- `notify_pending_message(sender)` / `clear_pending_sender(sender)`
- `notify_pending_call(caller)` / `clear_pending_caller(caller)`
- `archive_messages(peer, messages)` / `set_chat_persistent(peer, persistent)`
- `upload_asset(path, content_type, content)`
- `http_request_update(req)`
- `get_verification_key(context)` / `derive_encrypted_key(context, derivation, transport_pk)`

### Query
- `get_owner()` / `get_user_principal()` / `is_whitelisted(peer)`
- `fetch_my_messages()` / `count_my_messages()`
- `get_presence()`
- `get_my_signals()`
- `get_pending_senders()` / `get_pending_callers()`
- `get_archived_messages(peer)` / `is_chat_persistent(peer)` / `get_all_persistent_chats()`
- `http_request(req)`

## Vincoli

- Payload messaggi: max 512 byte
- Max 50 messaggi non letti per destinatario
- Max 4 segnali WebRTC per destinatario
- Segnali TTL: 2 minuti
- Archive: max 1000 msg/peer, batch max 100
- localStorage: max 500 msg/chat

## Deploy

```bash
cd apps/messenger
./deploy.sh                    # tutto: wasm + dfx + II + claim + frontend
./deploy.sh --skip-build
./deploy.sh --skip-ii
./deploy.sh --skip-frontend
```

## Config STUN

```js
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```
Solo STUN — nessun TURN per ora.
