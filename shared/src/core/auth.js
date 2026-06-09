/**
 * auth.js — Internet Identity wrapper generico.
 *
 * Emette eventi sull'event bus:
 *   auth:login  { identity, principal }
 *   auth:logout {}
 *
 * Uso:
 *   import { initAuth, login, logout, getPrincipal } from './core/auth.js';
 *   await initAuth();
 *   await login();
 */

import { AuthClient } from '@dfinity/auth-client';
import { II_URL } from './config.js';
import { bus } from './event-bus.js';

let _client = null;
let _isAuthenticated = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initAuth() {
  _client = await AuthClient.create();
  _isAuthenticated = await _client.isAuthenticated();
  return _client;
}

// ─── Login / Logout ───────────────────────────────────────────────────────────

export function login() {
  return new Promise((resolve, reject) => {
    _client.login({
      identityProvider: II_URL,
      onSuccess: () => {
        _isAuthenticated = true;
        const identity = getIdentity();
        const principal = identity?.getPrincipal();
        bus.emit('auth:login', { identity, principal });
        resolve(identity);
      },
      onError: (err) => reject(new Error(err ?? 'Login failed')),
    });
  });
}

export async function logout() {
  _isAuthenticated = false;
  bus.emit('auth:logout', {});
  await _client.logout();
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function isAuthenticated() {
  return _isAuthenticated;
}

export function getIdentity() {
  return _client?.getIdentity() ?? null;
}

export function getPrincipal() {
  return getIdentity()?.getPrincipal() ?? null;
}

export function getPrincipalText() {
  return getPrincipal()?.toText() ?? '';
}
