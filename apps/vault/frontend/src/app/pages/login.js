/**
 * login.js — Wrapper Vault per la capability login condivisa.
 */

import { renderLogin as _renderLogin } from '@shared/capabilities/login/index.js';

export function renderLogin(container) {
  _renderLogin(container, {
    title:    'Sovereign Vault',
    subtitle: 'Your digital vault on the Internet Computer',
  });
}
