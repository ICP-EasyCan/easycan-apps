/**
 * main.js — EasyHub (supercanister-hub) — la shell.
 *
 * Un computer sovrano on-chain: launcher delle mini-app installate, Store verificabile per hash,
 * host iframe sandboxed (bridge postMessage), automazioni schedulate, auto-conoscenza.
 *
 * Boot sul pattern canonico di apps/vault: auth → owner-gate FAIL-CLOSED → claim → router #.
 */

import { bus }                 from '@shared/core/event-bus.js';
import { CANISTER_ID }         from '@shared/core/config.js';
import { initAuth, logout, isAuthenticated, getPrincipalText, getPrincipal }
                               from '@shared/core/auth.js';
import { setDefaultIdlFactory, call, query, setOwnCanisterId }
                               from '@shared/core/icp.js';
import { captureClaimToken, handleDeepLinkClaim, isClaimPending } from '@shared/core/claim.js';
import { $ }                   from '@shared/ui/dom.js';
import { route, fallback, startRouter, navigate }
                               from '@shared/ui/router.js';
import { mountSovereigntyPage } from '@shared/capabilities/sovereignty/page.js';
import { mountVerifyPage }      from '@shared/capabilities/verify/page.js';
import { mountUpdatePage }      from '@shared/capabilities/update/page.js';

import { idlFactory }          from './idl.js';
import { checkin }             from './lib/hub-api.js';
import { renderLogin }         from './app/pages/login.js';
import { renderNotOwner }      from './app/pages/not-owner.js';
import { renderVerifyFailed }  from './app/pages/verify-failed.js';
import { renderFeed }          from './app/pages/feed.js';
import { renderMiniApps }      from './app/pages/mini-apps.js';
import { renderRun, teardownAllBundles } from './app/pages/run.js';
import { renderAutomations }   from './app/pages/automations.js';
import { renderControlRoom }   from './app/pages/control-room.js';
import { renderSettings }      from './app/pages/settings.js';
import { renderCapsule }       from './app/pages/capsule.js';
import { renderCapsuleDecrypt } from './app/pages/capsule-decrypt.js';
import { initTopNav, removeTopNav } from './app/components/top-nav.js';

setDefaultIdlFactory(idlFactory);

// Segnale di fiducia #verify (§A). Non ancora pubblicato → nessun tag/hash autorevole: il badge
// resterà ✗ onesto finché EasyHub non ha una release riproducibile (F5/F6). Da riempire alla cut-release.
const VERIFY = {
  repoUrl: 'https://github.com/ICP-EasyCan/easycan-apps',
  // Stringhe vuote (non null): cut-release.sh riempie questi due via sed su `releaseTag: 'supercanister-hub-v0.1.0'`
  // / `releaseSha256: 'bf908b73be0ab53774a41c63c133c933c88b720c9afbab2d623845215533d2c6'` al taglio della release → finché vuoti, #verify resta ✗ onesto.
  releaseTag: 'supercanister-hub-v0.1.0',
  releaseSha256: 'bf908b73be0ab53774a41c63c133c933c88b720c9afbab2d623845215533d2c6',
  dockerPackage: 'hub-canister',
};

const UPGRADE = { repo: 'ICP-EasyCan/easycan-apps', app: 'hub', enableInstall: false };

// Presenza-owner (F1): timbra il battito server-side appena la proprietà è verificata. Best-effort,
// non blocca la UI — è il sostrato della categoria "se vado in silenzio" (dead-man's switch & co.).
const markPresence = () => { checkin().catch((e) => console.debug('checkin skipped:', e?.message)); };

async function boot() {
  // Cattura del token dal fragment (#claim=): sincrona e PRIMA di startRouter()
  // — il fallback del router riscrive l'hash e lo distruggerebbe. (#decrypt non
  // collide: il claim arriva solo come "#claim=<hex64>" esatto.)
  captureClaimToken();

  await initAuth();

  if (isAuthenticated() && getPrincipalText() === '2vxsx-fae') {
    await logout();
  }

  const routeContainer = $('#route-container');
  let appOwnershipVerified = false;

  const requireAuth = async (renderFn, param) => {
    if (!isAuthenticated()) { navigate('#login'); return; }
    if (!appOwnershipVerified) {
      const isOwner = await checkOwnership(getPrincipalText());
      if (!isOwner) return; // checkOwnership naviga al gate giusto
      appOwnershipVerified = true;
    }
    renderFn(param);
  };

  // ─── Routing ──────────────────────────────────────────────────────────────
  route('#login',         () => renderLogin(routeContainer));
  route('#not-owner',     () => renderNotOwner(routeContainer));
  route('#verify-failed', () => renderVerifyFailed(routeContainer));
  // Home = il Feed-home (F5): il racconto dell'agente, non la griglia di mini-app (quella vive in #mini-apps).
  route('#home',          () => requireAuth(() => renderFeed(routeContainer)));
  route('#mini-apps',     () => requireAuth(() => renderMiniApps(routeContainer)));
  // Compat deep-link: le vecchie rotte (bookmark, link nei bundle) reindirizzano alla pagina fusa.
  route('#launcher',      () => navigate('#mini-apps'));
  route('#store',         () => navigate('#mini-apps'));
  route('#run/*',         ([id]) => requireAuth((p) => renderRun(routeContainer, p), id));
  route('#automations',   () => requireAuth(() => renderAutomations(routeContainer)));
  route('#control-room',  () => requireAuth(() => renderControlRoom(routeContainer)));
  route('#capsule',       () => requireAuth(() => renderCapsule(routeContainer)));
  route('#settings',      () => requireAuth(() => renderSettings(routeContainer)));
  // #decrypt = il decryptor outbound dell'erede: tool puramente client-side, ZERO chiamate al
  // canister, nessuna auth. Fuori dal gate-owner (l'erede non è l'owner e non si logga). Non è una
  // superficie inbound: non tocca il canister — è il modello outbound-only ([[outbound_only]]).
  route('#decrypt',       () => renderCapsuleDecrypt(routeContainer));
  route('#sovereignty',   () => requireAuth(() => mountSovereigntyPage(routeContainer, { canisterId: CANISTER_ID, myPrincipal: getPrincipal() })));
  route('#verify',        () => requireAuth(() => mountVerifyPage(routeContainer, { canisterId: CANISTER_ID, ...VERIFY })));
  route('#update',        () => requireAuth(() => mountUpdatePage(routeContainer, { canisterId: CANISTER_ID, ...UPGRADE })));
  fallback(               () => navigate(isAuthenticated() ? '#home' : '#login'));

  // ─── Auth events ────────────────────────────────────────────────────────────
  bus.on('auth:login', async () => {
    // #decrypt è un tool client-side puro: chi vi atterra (anche autenticato) ci resta, niente gate.
    if (window.location.hash.startsWith('#decrypt')) { renderCapsuleDecrypt(routeContainer); return; }

    // Overlay onesto sulla login-card mentre registriamo/verifichiamo la proprietà (gemello di
    // apps/vault e apps/messenger). Testo "registro la proprietà" solo se un claim sta davvero per
    // partire (acquisto fresh); al re-login/post-reinstall l'owner è già settato → si VERIFICA soltanto.
    const loginCard = document.querySelector('.login-card');
    if (loginCard) {
      const claiming = isClaimPending();
      const title    = claiming ? 'Configuring App' : 'Signing in';
      const detail   = claiming ? 'Registering your ownership on the blockchain...'
                                : 'Verifying your ownership...';
      loginCard.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; animation: fadeIn 0.4s ease-out;">
          <div style="display: inline-block; width: 28px; height: 28px; border: 3px solid var(--accent-dim, rgba(61, 219, 217, 0.15)); border-top-color: var(--accent, #3ddbd9); border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
          <h3 style="margin: 0 0 10px 0; font-weight: 600; font-size: 1.15em; color: var(--text);">${title}</h3>
          <p style="margin: 0; font-size: 0.95em; opacity: 0.7; color: var(--text);">${detail}</p>
        </div>
        <style>
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        </style>
      `;
    }

    setOwnCanisterId(CANISTER_ID);
    try {
      const { claimed } = await handleDeepLinkClaim(CANISTER_ID, { source: 'login' });
      if (!claimed) await claimIfNeeded();

      const isOwner = await checkOwnership(getPrincipalText());
      if (isOwner) {
        appOwnershipVerified = true;
        markPresence();         // battito al login
        initTopNav();           // nav solo DOPO la verifica di proprietà (no chrome sui gate)
        navigate('#home');
      }
    } catch (e) {
      console.error('Claim failed:', e);
    }
  });

  bus.on('auth:logout', () => {
    appOwnershipVerified = false;
    teardownAllBundles();   // invariante: nessun iframe vivo (DOM dell'utente precedente) sopravvive al logout
    removeTopNav();
    navigate('#login');
  });

  // ─── Start ────────────────────────────────────────────────────────────────
  startRouter();

  // #decrypt (decryptor client-side puro): già renderizzato da startRouter, niente gate-owner
  // (l'erede non è l'owner e non si logga; saltare il gate evita un redirect su #not-owner).
  if (window.location.hash.startsWith('#decrypt')) return;

  if (isAuthenticated()) {
    setOwnCanisterId(CANISTER_ID);
    handleDeepLinkClaim(CANISTER_ID, { source: 'boot' })
      .then(() => checkOwnership(getPrincipalText()))
      .then((isOwner) => {
        if (isOwner) {
          appOwnershipVerified = true;
          markPresence();       // battito alla riapertura (sessione II ancora valida)
          initTopNav();
          if (!window.location.hash || window.location.hash === '#login') navigate('#home');
        }
      })
      .catch(console.error);
  }
}

async function claimIfNeeded() {
  try {
    const existing = await query(CANISTER_ID, 'get_user_principal');
    if (existing && existing.length > 0) return;
    const result = await call(CANISTER_ID, 'claim_user_principal');
    if (result?.Err) console.log('Claim:', result.Err);
  } catch (e) {
    console.log('Claim skipped:', e.message);
  }
}

/**
 * Gate di proprietà — FAIL-CLOSED (gemello del vault). owner==me → accesso; owner presente e ≠ me
 * → #not-owner; query in errore o owner vuoto → #verify-failed (mai dare la shell su un dubbio).
 */
async function checkOwnership(myPrincipal) {
  let result;
  try {
    result = await query(CANISTER_ID, 'get_user_principal');
  } catch (e) {
    console.warn('checkOwnership failed:', e.message);
    navigate('#verify-failed');
    return false;
  }
  if (!result || result.length === 0) { navigate('#verify-failed'); return false; }
  const owner = result[0].toText();
  if (owner !== myPrincipal) { navigate('#not-owner'); return false; }
  return true;
}

boot().catch(console.error);
