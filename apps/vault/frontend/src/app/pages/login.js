/**
 * login.js — Wrapper Vault per la capability login condivisa.
 */

import { renderLogin as _renderLogin } from '@shared/capabilities/login/index.js';

export function renderLogin(container) {
  _renderLogin(container, {
    title:    'EasySafe',
    subtitle: 'Your sovereign encrypted vault',
  });
}
