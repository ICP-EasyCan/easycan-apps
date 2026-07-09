/**
 * main.js — Entry point Sovereign Vault
 *
 * Personal security vault: Passwords, Files, Notes — encrypted with VetKeys.
 */

// ─── Blocchi dalla fabbrica ─────────────────────────────────────────────────
import { bus }                 from '@shared/core/event-bus.js';
import { CANISTER_ID }         from '@shared/core/config.js';
import { initAuth, login, logout, isAuthenticated, getPrincipalText }
                               from '@shared/core/auth.js';
import { setDefaultIdlFactory, call, query, resetActors, setOwnCanisterId }
                               from '@shared/core/icp.js';
import { captureClaimToken, handleDeepLinkClaim, isClaimPending }
                               from '@shared/core/claim.js';
import { captureInstallParams, getPendingInstall }
                               from '@shared/capabilities/update/handoff.js';
import { $ }                   from '@shared/ui/dom.js';
import { route, fallback, startRouter, navigate }
                               from '@shared/ui/router.js';

// ─── App-specifica ──────────────────────────────────────────────────────────
import { idlFactory }          from './idl.js';
import { renderLogin }         from './app/pages/login.js';
import { renderNotOwner }      from './app/pages/not-owner.js';
import { renderVerifyFailed }  from './app/pages/verify-failed.js';
import { renderDashboard }     from './app/pages/dashboard.js';
import { renderPasswords }     from './app/pages/passwords.js';
import { renderPasswordEdit }  from './app/pages/password-edit.js';
import { renderFiles }         from './app/pages/files.js';
import { renderNotes }         from './app/pages/notes.js';
import { renderNoteEdit }      from './app/pages/note-edit.js';
import { renderSettings }      from './app/pages/settings.js';
import { mountSovereigntyPage } from '@shared/capabilities/sovereignty/page.js';
import { mountVerifyPage }      from '@shared/capabilities/verify/page.js';
import { mountUpdatePage }      from '@shared/capabilities/update/page.js';
import { mountInstallPage }     from '@shared/capabilities/update/handoff-page.js';
import { getPrincipal }         from '@shared/core/auth.js';
import { clearKeyCache }        from '@shared/core/crypto.js';
import { initTopNav, removeTopNav }
                               from './app/components/top-nav.js';
import { initBottomNav, removeBottomNav }
                               from './app/components/bottom-nav.js';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

setDefaultIdlFactory(idlFactory);

// Dati per la pagina #verify (segnale di fiducia §A). Riempiti dal release flow
// (GitHub Release pubblica): il badge ✓ si accende solo se il module_hash live del
// canister == releaseSha256. Un canister buildato col deploy veloce (cargo-nudo) ha
// hash diverso → ✗ onesto. Il ✓ richiede una factory coi byte Docker della release
// (vedi scripts/deploy-factory.sh). releaseSha256 = wasm_sha256 del manifest GitHub.
const VERIFY = {
  repoUrl: 'https://github.com/ICP-EasyCan/easycan-apps',
  releaseTag: 'vault-v0.2.1',
  releaseSha256: 'f1b6d00474dc6473b5563378b1211fcd5b19a4fa3001b0f79e2fc9df484521da',
  dockerPackage: 'vault-canister',
  e2eeFrontend: true,       // il vault cifra nel frontend → caveat E2EE
};

// Coordinate self-upgrade. Canale rolling pre-release. `enableInstall` accende il flusso
// in-app a 6 passi (fetch+verify → chunk → snapshot → install → frontend → health) con
// auto-rollback + restore standalone. `e2ee` mostra il caveat onesto sul rollback: la
// master key VetKeys è per-canister deterministica → un rollback non perde la decifratura
// dei dati esistenti (solo i dati scritti DOPO un cambio di formato sono a rischio).
const UPGRADE = {
  repo: 'ICP-EasyCan/easycan-apps', app: 'vault', enableInstall: true, e2ee: true,
};

async function boot() {
  // Cattura dei token dal fragment (#claim= / #install=): sincrona e PRIMA di
  // startRouter() — il fallback del router riscrive l'hash e li distruggerebbe.
  // Stash in sessionStorage + pulizia URL (sopravvive a login/relogin; back/refresh
  // non ri-scatta). Il reinstall vero parte solo dalla pagina #install, dietro
  // conferma esplicita.
  captureClaimToken();
  const installCaptured = captureInstallParams();

  await initAuth();

  if (isAuthenticated() && getPrincipalText() === '2vxsx-fae') {
    await logout();
  }

  const routeContainer = $('#route-container');

  // Deep-link cambio-app (Arco B): cambio-app = reinstall distruttivo (gemello del
  // claim irreversibile): se esiste già una sessione II su questo origin, forziamo
  // logout così l'utente passa per il login col banner di autorizzazione e conferma
  // l'identità coscientemente — niente salto silenzioso a #install. I params restano
  // in sessionStorage e l'auth:login post-relogin porta a #install. Cfr. relogin del
  // claim (claim.js).
  if (installCaptured && isAuthenticated()) {
    await logout();
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

  // ─── Routing ──────────────────────────────────────────────────────────────
  route('#login',          () => renderLogin(routeContainer));
  route('#not-owner',      () => renderNotOwner(routeContainer));
  route('#verify-failed',  () => renderVerifyFailed(routeContainer));
  route('#dashboard',      () => requireAuth(() => renderDashboard(routeContainer)));
  route('#passwords',      () => requireAuth(() => renderPasswords(routeContainer)));
  route('#password/*',     ([id]) => requireAuth((param) => renderPasswordEdit(routeContainer, param), id));
  route('#files',          () => requireAuth(() => renderFiles(routeContainer)));
  route('#notes',          () => requireAuth(() => renderNotes(routeContainer)));
  route('#note/*',         ([id]) => requireAuth((param) => renderNoteEdit(routeContainer, param), id));
  route('#settings',       () => requireAuth(() => renderSettings(routeContainer)));
  route('#sovereignty',    () => requireAuth(() => mountSovereigntyPage(routeContainer, { canisterId: CANISTER_ID, myPrincipal: getPrincipal() })));
  route('#verify',         () => requireAuth(() => mountVerifyPage(routeContainer, { canisterId: CANISTER_ID, ...VERIFY })));
  route('#update',         () => requireAuth(() => mountUpdatePage(routeContainer, { canisterId: CANISTER_ID, ...UPGRADE })));
  route('#install',        () => requireAuth(() => mountInstallPage(routeContainer, { canisterId: CANISTER_ID, repo: UPGRADE.repo })));
  fallback(                () => navigate(isAuthenticated() ? '#dashboard' : '#login'));

  // ─── Auth events ──────────────────────────────────────────────────────────
  bus.on('auth:login', async () => {
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
    // Claim BEFORE navigating — without claim, queries fail with "Unauthorized"
    try {
      const { claimed } = await handleDeepLinkClaim(CANISTER_ID, { source: 'login' });
      if (!claimed) await claimIfNeeded();

      const isOwner = await checkOwnership(getPrincipalText());
      if (isOwner) {
        appOwnershipVerified = true;
        // Nav montati SOLO dopo la verifica di proprietà: prima eviterebbe lo
        // scatto (chrome attorno allo spinner di login) e, sul ramo non-owner,
        // lascerebbe la chrome dell'app sulla pagina #not-owner.
        initTopNav();
        initBottomNav();
        // Cambio-app pendente (Arco B): vai al ricevitore invece che alla home.
        navigate(getPendingInstall() ? '#install' : '#dashboard');
      }
    } catch (e) {
      console.error('Claim failed:', e);
    }
  });

  bus.on('auth:logout', () => {
    appOwnershipVerified = false;
    clearKeyCache();
    removeTopNav();
    removeBottomNav();
    navigate('#login');
  });

  // ─── Start ────────────────────────────────────────────────────────────────
  startRouter();

  if (isAuthenticated()) {
    setOwnCanisterId(CANISTER_ID);
    handleDeepLinkClaim(CANISTER_ID, { source: 'boot' })
      .then(() => checkOwnership(getPrincipalText()))
      .then(isOwner => {
        if (isOwner) {
          appOwnershipVerified = true;
          // Nav solo dopo la verifica di proprietà (vedi auth:login).
          initTopNav();
          initBottomNav();
          // Cambio-app pendente (Arco B): apri il ricevitore.
          if (getPendingInstall()) navigate('#install');
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
 * Gate di proprietà — FAIL-CLOSED. Tre esiti distinti:
 *  - owner verificato == me            → accesso (true)
 *  - owner verificato presente e != me → #not-owner (false): appartiene a un altro
 *  - query in errore OPPURE owner vuoto → #verify-failed (false): proprietà NON
 *    verificabile → niente accesso. Mai dare la dashboard su un dubbio: un errore di
 *    rete transitorio (o canister lento) non deve far entrare un non-owner.
 * L'owner vuoto è sicuro come fail-closed: nel login `claimIfNeeded` gira PRIMA e
 * popola l'owner; se resta vuoto il claim non è andato → giusto non dare accesso.
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
