/**
 * main.js — Entry point Sovereign Messenger
 *
 * Assembla i blocchi della fabbrica (core/, ui/) con la logica app-specifica (app/).
 * I moduli core/ e ui/ sono importati dalla fabbrica via alias @shared.
 */

// ─── Blocchi dalla fabbrica ─────────────────────────────────────────────────
import { bus }                 from '@shared/core/event-bus.js';
import { CANISTER_ID }         from '@shared/core/config.js';
import { initAuth, login, logout, isAuthenticated, getPrincipalText, getPrincipal }
                               from '@shared/core/auth.js';
import { setDefaultIdlFactory, call, query, resetActors, setOwnCanisterId, getActorFor }
                               from '@shared/core/icp.js';
import { captureClaimToken, handleDeepLinkClaim, isClaimPending }
                               from '@shared/core/claim.js';
import { captureInstallParams, getPendingInstall }
                               from '@shared/capabilities/update/handoff.js';
import { $ }                   from '@shared/ui/dom.js';
import { route, fallback, startRouter, navigate }
                               from '@shared/ui/router.js';

// ─── App-specifica ──────────────────────────────────────────────────────────
import { mountSovereigntyPage } from '@shared/capabilities/sovereignty/page.js';
import { mountVerifyPage }      from '@shared/capabilities/verify/page.js';
import { mountUpdatePage }      from '@shared/capabilities/update/page.js';
import { mountInstallPage }     from '@shared/capabilities/update/handoff-page.js';
import { idlFactory }          from './idl.js';
import { renderLogin }         from './app/pages/login.js';
import { renderNotOwner }      from './app/pages/not-owner.js';
import { renderVerifyFailed }  from './app/pages/verify-failed.js';
import { renderChats }         from './app/pages/chats.js';
import { renderChat }          from './app/pages/chat.js';
import { renderContacts }      from './app/pages/contacts.js';
import { renderAddContact }    from './app/pages/add-contact.js';
import { renderSettings }      from './app/pages/settings.js';
import { initCallBanner }      from './app/components/call-banner.js';
import { initBottomNav, removeBottomNav }
                               from './app/components/bottom-nav.js';
import { initDesktopRail, teardownDesktopRail }
                               from './app/layout/desktop-rail.js';
import { initConnectionManager, stopConnectionManager }
                               from './app/connection-manager.js';
import { initSounds, playMessage }
                               from '@shared/capabilities/sounds/index.js';
import { getContactByPrincipal }
                               from '@shared/capabilities/contacts/index.js';
import { initContacts, resetContactsSession }
                               from './app/contacts-store.js';
import { maybeNotify, closeNotification }
                               from './app/lib/notifications.js';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

setDefaultIdlFactory(idlFactory);

// Dati per la pagina #verify (segnale di fiducia §A). Riempiti dal release flow
// (GitHub Release pubblica): il badge ✓ si accende solo se il module_hash live del
// canister == releaseSha256. Un canister buildato col deploy veloce (cargo-nudo) ha
// hash diverso → ✗ onesto. Il ✓ richiede una factory coi byte Docker della release
// (vedi scripts/deploy-factory.sh). releaseSha256 = wasm_sha256 del manifest GitHub.
const VERIFY = {
  repoUrl: 'https://github.com/ICP-EasyCan/easycan-apps',
  releaseTag: 'messenger-v0.3.5',
  releaseSha256: '7189b562b8a9eb8ddd1fee88d3c0a977c6f35a00d706c5823d4b093b5def6bc3',
  dockerPackage: 'messenger-canister',
  e2eeFrontend: false,      // messenger NON è E2EE
};

// Coordinate self-upgrade. `app` = sottocartella su `dist` (transport raw.githubusercontent).
// `enableInstall` accende il flusso in-app a 6 passi (Fase 2: fetch+verify → chunk → snapshot
// → install → frontend → health), con rollback manuale + auto allo snapshot.
// `takeSnapshot` (default ON): leva per saltare lo snapshot pre-upgrade su un upgrade di cui
// si è sicuri — messenger ha comunque dfx come rete di recovery. A false: nessuno snapshot,
// nessun auto-rollback (solo Retry su fallimento). Nessuna UI utente: è una scelta di config.
const UPGRADE = { repo: 'ICP-EasyCan/easycan-apps', app: 'messenger', enableInstall: true, takeSnapshot: true };

async function boot() {
  // Cattura dei token dal fragment (#claim= / #install=): sincrona e PRIMA di
  // startRouter() — il fallback del router riscrive l'hash e li distruggerebbe.
  // Stash in sessionStorage + pulizia URL (sopravvive a login/relogin; back/refresh
  // non ri-scatta). Il reinstall vero parte solo dalla pagina #install, dietro
  // conferma esplicita.
  captureClaimToken();
  captureInstallParams();

  await initAuth();

  // Se la delegation II è scaduta (principal anonimo), pulisci la sessione
  if (isAuthenticated() && getPrincipalText() === '2vxsx-fae') {
    await logout();
  }

  // Route container per App Shell
  const routeContainer = $('#route-container');

  let appOwnershipVerified = false;

  const requireAuth = async (renderFn, param) => {
    if (!isAuthenticated()) {
      navigate('#login');
      return;
    }
    if (!appOwnershipVerified) {
      const isOwner = await checkOwnership(getPrincipalText());
      if (!isOwner) return; // checkOwnership naviga a #not-owner
      appOwnershipVerified = true;
    }
    renderFn(param);
  };

  // ─── Routing (le pagine renderizzano dentro routeContainer) ─────────────
  // Se la sessione II è ancora valida, #login (es. URL ripristinato dalla PWA)
  // non deve chiedere un login inutile: si entra direttamente.
  route('#login',         () => isAuthenticated() ? navigate('#chats') : renderLogin(routeContainer));
  route('#not-owner',     () => renderNotOwner(routeContainer));
  route('#verify-failed', () => renderVerifyFailed(routeContainer));
  route('#chats',         () => requireAuth(() => renderChats(routeContainer)));
  route('#chat/*',        ([param]) => requireAuth((p) => renderChat(routeContainer, p), param));
  route('#contacts',      () => requireAuth(() => renderContacts(routeContainer)));
  route('#add-contact',   () => requireAuth(() => renderAddContact(routeContainer)));
  route('#settings',      () => requireAuth(() => renderSettings(routeContainer)));
  route('#sovereignty',   () => requireAuth(() => mountSovereigntyPage(routeContainer, { canisterId: CANISTER_ID, myPrincipal: getPrincipal() })));
  route('#verify',        () => requireAuth(() => mountVerifyPage(routeContainer, { canisterId: CANISTER_ID, ...VERIFY })));
  route('#update',        () => requireAuth(() => mountUpdatePage(routeContainer, { canisterId: CANISTER_ID, ...UPGRADE })));
  route('#install',       () => requireAuth(() => mountInstallPage(routeContainer, { canisterId: CANISTER_ID, repo: UPGRADE.repo })));
  fallback(               () => navigate(isAuthenticated() ? '#chats' : '#login'));

  // ─── Auth events ─────────────────────────────────────────────────────────
  bus.on('auth:login', async ({ principal }) => {
    const loginCard = document.querySelector('.login-card');
    if (loginCard) {
      // Testo onesto: "registro la proprietà" solo se un claim sta davvero per
      // partire (acquisto fresh). Al re-login o dopo un reinstall l'owner è già
      // settato (cap-platform adopt_sovereign) → si VERIFICA soltanto.
      const claiming = isClaimPending();
      const title    = claiming ? 'Configuring App' : 'Signing in';
      const detail   = claiming ? 'Registering your ownership on the blockchain...'
                                : 'Verifying your ownership...';
      loginCard.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; animation: fadeIn 0.4s ease-out;">
          <div style="display: inline-block; width: 28px; height: 28px; border: 3px solid rgba(13, 148, 136, 0.15); border-top-color: var(--color-primary, #0d9488); border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
          <h3 style="margin: 0 0 10px 0; font-weight: 600; font-size: 1.15em; color: var(--color-text);">${title}</h3>
          <p style="margin: 0; font-size: 0.95em; opacity: 0.7; color: var(--color-text);">${detail}</p>
        </div>
        <style>
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        </style>
      `;
    }

    setOwnCanisterId(CANISTER_ID);
    
    // Mostra Header App Shell
    const header = $('#app-header');
    if (header) {
      header.style.display = 'flex';
      const prinEl = $('#header-principal');
      if (prinEl) prinEl.textContent = getPrincipalText().slice(0, 8) + '...';
      const logoutBtn = $('#btn-logout');
      if (logoutBtn) logoutBtn.onclick = () => logout();
    }

    try {
      const { claimed } = await handleDeepLinkClaim(CANISTER_ID, { source: 'login' });
      if (!claimed) await claimIfNeeded();
      
      const isOwner = await checkOwnership(principal.toText());
      if (isOwner) {
        appOwnershipVerified = true;
        initSounds();
        initCallBanner();
        initBottomNav();
        initDesktopRail();
        initConnectionManager();
        await initContacts(await getActorFor(CANISTER_ID)).catch(e => console.warn('initContacts:', e.message));
        // Cambio-app pendente (Arco B): vai al ricevitore invece che alla home.
        navigate(getPendingInstall() ? '#install' : '#chats');
      }
    } catch (e) {
      console.error('Login flow error:', e);
    }
  });

  // ─── Suoni + notifiche su eventi bus ─────────────────────────────────────
  // 'notify:pending-update' riporta lo stato INTERO ogni poll, non i delta →
  // snapshot locale e beep/notifica solo sui sender assenti al giro prima.
  // Il beep in-chat vive in chat.js (callback chat-session); l'anti-doppio-beep
  // è il throttle 1s dentro playMessage(). maybeNotify è già no-op a pagina
  // visibile e senza permesso.
  const aliasOf = (pid) => getContactByPrincipal(pid)?.alias || pid.slice(0, 12) + '...';

  let knownSenders = new Set();
  bus.on('notify:pending-update', ({ senders }) => {
    const newSenders = [...senders].filter(pid => !knownSenders.has(pid));
    knownSenders = new Set(senders);
    if (newSenders.length === 0) return;
    // Il sender della chat aperta e visibile non suona da qui: il suo beep lo
    // fa la chat stessa quando il messaggio compare (meta.live). Evita il
    // doppio suono quando il tick di notify batte il poll della sessione.
    const hash = window.location.hash;
    const openChatPid = (!document.hidden && hash.startsWith('#chat/') && hash.includes(':'))
      ? hash.slice(hash.indexOf(':') + 1)
      : null;
    const audible = newSenders.filter(pid => pid !== openChatPid);
    if (audible.length === 0) return;
    playMessage();
    for (const pid of audible) {
      const contact = getContactByPrincipal(pid);
      maybeNotify({
        title: 'New message',
        body: `From ${aliasOf(pid)}`,
        tag: `msg-${pid}`,
        route: contact ? `#chat/${contact.canisterId}:${pid}` : '#chats',
      });
    }
  });

  bus.on('call:incoming', ({ callerPid }) => {
    maybeNotify({
      title: 'Incoming call',
      body: `From ${aliasOf(callerPid)}`,
      tag: `call-${callerPid}`,
      requireInteraction: true,
    });
  });

  bus.on('call:cancelled', ({ callerPid }) => {
    closeNotification(`call-${callerPid}`);
  });

  bus.on('auth:logout', () => {
    knownSenders = new Set();
    appOwnershipVerified = false;
    resetContactsSession();
    stopConnectionManager();
    teardownDesktopRail();
    removeBottomNav();
    const header = $('#app-header');
    if (header) header.style.display = 'none';
    navigate('#login');
  });

  // ─── Start ────────────────────────────────────────────────────────────────
  startRouter();

  if (isAuthenticated()) {
    setOwnCanisterId(CANISTER_ID);
    
    // Mostra Header App Shell
    const header = $('#app-header');
    if (header) {
      header.style.display = 'flex';
      const prinEl = $('#header-principal');
      if (prinEl) prinEl.textContent = getPrincipalText().slice(0, 8) + '...';
      const logoutBtn = $('#btn-logout');
      if (logoutBtn) logoutBtn.onclick = () => logout();
    }

    initSounds();
    initCallBanner();
    initBottomNav();
    initDesktopRail();
    // Al boot NON claimare implicitamente — la sessione potrebbe essere stale (dopo dfx --clean).
    // Eccezione: deep link claim (#claim=<token>) è un'azione esplicita dell'utente.
    handleDeepLinkClaim(CANISTER_ID, { source: 'boot' })
      .then(() => checkOwnership(getPrincipalText()))
      .then(isOwner => {
        if (isOwner) {
          appOwnershipVerified = true;
          initConnectionManager();
          getActorFor(CANISTER_ID)
            .then(initContacts)
            .catch(e => console.warn('initContacts:', e.message));
          // Cambio-app pendente (Arco B): apri il ricevitore.
          if (getPendingInstall()) navigate('#install');
        }
      })
      .catch(console.error);
  }
}

async function claimIfNeeded() {
  try {
    // Se il canister ha già un user_principal, non sovrascrivere.
    // Il claim serve solo al primo login; per re-claimare serve allow_claim.
    const existing = await query(CANISTER_ID, 'get_user_principal');
    if (existing && existing.length > 0) return;
    const result = await call(CANISTER_ID, 'claim_user_principal');
    if (result?.Err) console.log('Claim:', result.Err);
  } catch (e) {
    console.log('Claim skipped:', e.message);
  }
}

/**
 * Gate di proprietà — FAIL-CLOSED. Tre esiti distinti:
 *  - owner verificato == me            → accesso (true)
 *  - owner verificato presente e != me → #not-owner (false): appartiene a un altro
 *  - query in errore OPPURE owner vuoto → #verify-failed (false): proprietà NON
 *    verificabile → niente accesso. Mai dare l'app su un dubbio: un errore di rete
 *    transitorio (o canister lento) non deve far entrare un non-owner.
 * L'owner vuoto è sicuro come fail-closed: nel login `claimIfNeeded` gira PRIMA e
 * popola l'owner; se resta vuoto il claim non è andato → giusto non dare accesso.
 * @param {string} myPrincipal
 * @returns {Promise<boolean>} true = accesso consentito
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
  // result è Option<Principal>: [] = None (owner non ancora registrato)
  if (!result || result.length === 0) {
    navigate('#verify-failed');
    return false;
  }
  const owner = result[0].toText();
  if (owner !== myPrincipal) {
    navigate('#not-owner');
    return false;
  }
  return true;
}

boot().catch(console.error);
