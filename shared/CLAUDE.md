# shared/ — Capability JS condivise

> **Linea:** Build · **Contratto:** fornisce a tutte le zone frontend l'alias `@shared` e l'IDL cap-platform.

10 capability + core usate da ogni app e dal portale. Alias `@shared` in Vite.

---

## Vincoli frontend (qui e in ogni app/portale che le consuma)

- **Route SEMPRE con `#`** — `route('#login', ...)`, `navigate('#chats')`
- **Import via `@shared`** — mai path relativi (`../../`) verso `shared/src/`, usare `import { x } from '@shared/core/x.js'`
- **Vite `dedupe` obbligatorio** sui pacchetti `@dfinity/*` — due copie in `node_modules` rompono l'agent
- **Principal confrontati come stringhe** — sempre `.toText()`, mai `Principal` oggetto vs stringa
- **`AuthClient.isAuthenticated()` è async** — MAI esporre direttamente: cachare in `_isAuthenticated` bool dentro `auth.js`. Una Promise è sempre truthy → il claim gira con identità anonima `2vxsx-fae` → owner sbagliato
- **Boot non-blocking** — claim in background, router parte subito
- **`claimIfNeeded()` solo su login esplicito** — mai al boot (II session sopravvive a `dfx --clean`)
- **Bearer token SOLO nel fragment + cattura pre-router** — claim (`#claim=<hex64>`) e install (`#install=<app>&token=<hex64>`) viaggiano nel fragment, MAI in query string (il fragment non finisce nel Referer né nei log dei boundary node). Le app DEVONO chiamare `captureClaimToken()` (+ `captureInstallParams()` se hanno il ricevitore) come primi statement sincroni del boot, PRIMA di `startRouter()`: il fallback del router riscrive l'hash e distruggerebbe il token.
- **`handleDeepLinkClaim(id, { source })`** — passa `'boot'` fuori da auth events, `'login'` dentro `bus.on('auth:login')`. Al boot con token `#claim=` + sessione II esistente, forza logout+relogin per evitare claim con anchor stale (claim è irreversibile). Login page mostra banner via flag `sessionStorage['claim:relogin-required']`. Cfr. `memory/feedback_deep_link_claim_hardening.md`.
- **App marketplace → IDL deve includere cap-platform** — `platform_claim`, `platform_get_admin`, `platform_eject` obbligatori in ogni `<app>/frontend/src/idl.js` di app con `--features platform`
- **App E2EE → cap-crypto + IDL + dedupe vetkeys obbligatori** — `import { deriveKey, ... } from '@shared/core/crypto.js'` richiede che il canister host wrappi cap-crypto (2 update functions: `get_verification_key`, `derive_encrypted_key`) + i due metodi nell'IDL JS + `@dfinity/vetkeys` nel `dedupe` di `vite.config.js`. Pattern di riferimento: `apps/vault/canister/src/lib.rs:191-207` + `apps/vault/frontend/src/idl.js` + `apps/vault/frontend/vite.config.js`. Senza cap-crypto wrappato, `assertActor()` del modulo shared lancia.
- **Sovranità = sottopagina drop-in, non ricopiarla** — `@shared/capabilities/sovereignty/page.js` espone `mountSovereigntyPage(container, { canisterId, myPrincipal })` (pagina completa: fetch + skeleton + builder L4 + back) e `sovereigntyLinkSection()` (voce nel settings). Integrazione = 2 righe (route `#sovereignty` + sezione settings); se bottom-nav, mappa `#sovereignty` → tab Settings attiva. `listControllers` generico vive in `@shared/core/management.js`. App standalone → degrada a riquadro informativo

---

## Dove applicare

| Regola | File tipici coinvolti |
|--------|----------------------|
| Route `#` | `<app>/frontend/src/router.js`, `shared/src/core/router.js` |
| `@shared` alias | ogni `vite.config.js` di app/portale |
| Dedupe `@dfinity/*` | ogni `vite.config.js` |
| `_isAuthenticated` cache | `shared/src/core/auth.js`, `<app>/frontend/src/lib/auth.js` |
| IDL cap-platform | `<app>/frontend/src/idl.js` |
