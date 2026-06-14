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
import { setDefaultIdlFactory, call, query, resetActors, setOwnCanisterId }
                               from '@shared/core/icp.js';
import { handleDeepLinkClaim }
                               from '@shared/core/claim.js';
import { getInstallParamsFromUrl, stashInstallParams, cleanInstallFromUrl, getPendingInstall }
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

// ─── Bootstrap ──────────────────────────────────────────────────────────────

setDefaultIdlFactory(idlFactory);

// Dati per la pagina #verify (segnale di fiducia §A). Riempiti dal release flow
// (GitHub Release pubblica): il badge ✓ si accende solo se il module_hash live del
// canister == releaseSha256. Un canister buildato col deploy veloce (cargo-nudo) ha
// hash diverso → ✗ onesto. Il ✓ richiede una factory coi byte Docker della release
// (vedi scripts/deploy-factory.sh). releaseSha256 = wasm_sha256 del manifest GitHub.
const VERIFY = {
  repoUrl: 'https://github.com/ICP-EasyCan/easycan-apps',
  releaseTag: 'messenger-v0.1.0',
  releaseSha256: 'a3f3b04ae05e7cf13cb5a6bbffab456d519cca72b6d9c133f0fc9f9450652583',
  dockerPackage: 'messenger-canister',
  e2eeFrontend: false,      // messenger NON è E2EE
};

// Coordinate self-upgrade. `app` = sottocartella su `dist` (transport raw.githubusercontent).
// `enableInstall` accende il flusso in-app a 6 passi (Fase 2: fetch+verify → chunk → snapshot
// → install → frontend → health), con rollback manuale + auto allo snapshot.
const UPGRADE = { repo: 'ICP-EasyCan/easycan-apps', app: 'messenger', enableInstall: true };

async function boot() {
  await initAuth();

  // Se la delegation II è scaduta (principal anonimo), pulisci la sessione
  if (isAuthenticated() && getPrincipalText() === '2vxsx-fae') {
    await logout();
  }

  // Route container per App Shell
  const routeContainer = $('#route-container');

  // Deep-link cambio-app (Arco B): atterriamo con ?install=<app>&token=<hex> dal portale.
  // Stash + pulisci l'URL subito (sopravvive a login/relogin; back/refresh non ri-scatta).
  // Il reinstall vero parte solo dalla pagina #install, dietro conferma esplicita.
  const installParams = getInstallParamsFromUrl();
  if (installParams) {
    stashInstallParams(installParams);
    cleanInstallFromUrl();
  }

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
  route('#login',         () => renderLogin(routeContainer));
  route('#not-owner',     () => renderNotOwner(routeContainer));
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
      loginCard.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; animation: fadeIn 0.4s ease-out;">
          <div style="display: inline-block; width: 28px; height: 28px; border: 3px solid rgba(13, 148, 136, 0.15); border-top-color: var(--color-primary, #0d9488); border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
          <h3 style="margin: 0 0 10px 0; font-weight: 600; font-size: 1.15em; color: var(--color-text);">Configuring App</h3>
          <p style="margin: 0; font-size: 0.95em; opacity: 0.7; color: var(--color-text);">Registering your ownership on the blockchain...</p>
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
        initCallBanner();
        initBottomNav();
        initDesktopRail();
        initConnectionManager();
        // Cambio-app pendente (Arco B): vai al ricevitore invece che alla home.
        navigate(getPendingInstall() ? '#install' : '#chats');
      }
    } catch (e) {
      console.error('Login flow error:', e);
    }
  });

  bus.on('auth:logout', () => {
    appOwnershipVerified = false;
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

    initCallBanner();
    initBottomNav();
    initDesktopRail();
    // Al boot NON claimare implicitamente — la sessione potrebbe essere stale (dopo dfx --clean).
    // Eccezione: deep link claim (?claim=<token>) è un'azione esplicita dell'utente.
    handleDeepLinkClaim(CANISTER_ID, { source: 'boot' })
      .then(() => checkOwnership(getPrincipalText()))
      .then(isOwner => {
        if (isOwner) {
          appOwnershipVerified = true;
          initConnectionManager();
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
 * Verifica che il principal loggato sia il proprietario del canister.
 * Se il canister non ha ancora un proprietario (user_principal = null),
 * l'accesso è libero (flusso onboarding).
 * @param {string} myPrincipal
 * @returns {Promise<boolean>} true = accesso consentito
 */
async function checkOwnership(myPrincipal) {
  try {
    const result = await query(CANISTER_ID, 'get_user_principal');
    // result è Option<Principal>: [] = None, [Principal] = Some
    if (result && result.length > 0) {
      const owner = result[0].toText();
      if (owner !== myPrincipal) {
        navigate('#not-owner');
        return false;
      }
    }
    // null o canister non ancora claimato → accesso libero
    return true;
  } catch (e) {
    // Query fallita (es. canister non raggiungibile) → non bloccare
    console.warn('checkOwnership failed:', e.message);
    return true;
  }
}

boot().catch(console.error);
