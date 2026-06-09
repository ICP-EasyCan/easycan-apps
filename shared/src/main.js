/**
 * main.js — entry point dell'app minimale.
 *
 * Dimostra il pattern di assemblaggio frontend:
 * 1. Configura l'idlFactory
 * 2. Inizializza auth
 * 3. Registra route
 * 4. Ascolta eventi dal bus
 *
 * Questo è l'equivalente frontend del canister host (lib.rs).
 * La logica vera sta nei moduli — qui c'è solo colla.
 */

import { CANISTER_ID } from './core/config.js';
import { bus } from './core/event-bus.js';
import { initAuth, login, logout, isAuthenticated, getPrincipalText } from './core/auth.js';
import { setDefaultIdlFactory, setOwnCanisterId, call, query } from './core/icp.js';
import { idlFactory } from './idl.js';
import { $, el, render } from './ui/dom.js';
import { route, fallback, startRouter, navigate } from './ui/router.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

async function init() {
  // 1. Registra l'interfaccia del canister
  setDefaultIdlFactory(idlFactory);

  // 2. Inizializza auth
  await initAuth();

  // 3. Se già autenticato, configura il canister e claimsee
  if (isAuthenticated()) {
    setOwnCanisterId(CANISTER_ID);
    await claimIfNeeded();
  }

  // 4. Ascolta eventi
  bus.on('auth:login', async () => {
    setOwnCanisterId(CANISTER_ID);
    await claimIfNeeded();
    navigate('#home');
  });

  bus.on('auth:logout', () => {
    navigate('#login');
  });

  // 5. Registra route e avvia il router
  route('#login', renderLogin);
  route('#home', renderHome);
  fallback(() => navigate(isAuthenticated() ? '#home' : '#login'));
  startRouter();
}

// ─── Claim automatico ─────────────────────────────────────────────────────────

async function claimIfNeeded() {
  try {
    await call(CANISTER_ID, 'claim_user_principal');
  } catch (_) {
    // claim non abilitato — ok
  }
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function renderLogin() {
  const app = $('#app');
  render(app,
    el('div', { class: 'page login' },
      el('h1', {}, 'Sovereign App'),
      el('p', {}, `Canister: ${CANISTER_ID || 'not detected'}`),
      el('button', { onClick: () => login() }, 'Login with Internet Identity'),
    )
  );
}

async function renderHome() {
  if (!isAuthenticated()) return navigate('#login');

  const app = $('#app');
  render(app,
    el('div', { class: 'page home' },
      el('h1', {}, 'Home'),
      el('p', {}, `Principal: ${getPrincipalText()}`),
      el('p', { id: 'status' }, 'Loading...'),
      el('div', { class: 'actions' },
        el('button', { onClick: testPresence }, 'Test Presence'),
        el('button', { onClick: testOwner }, 'Get Owner'),
        el('button', { onClick: () => logout() }, 'Logout'),
      ),
    )
  );

  await testOwner();
}

// ─── Test functions ───────────────────────────────────────────────────────────

async function testOwner() {
  const status = $('#status');
  try {
    const owner = await query(CANISTER_ID, 'get_owner');
    status.textContent = `Owner: ${owner.toText()}`;
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

async function testPresence() {
  const status = $('#status');
  try {
    await call(CANISTER_ID, 'set_presence', true);
    const result = await query(CANISTER_ID, 'get_presence');
    if (result.Ok) {
      status.textContent = `Online: ${result.Ok.online}, last seen: ${result.Ok.last_seen_ns}`;
    } else {
      status.textContent = `Error: ${result.Err}`;
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

init().catch(err => console.error('Init failed:', err));
