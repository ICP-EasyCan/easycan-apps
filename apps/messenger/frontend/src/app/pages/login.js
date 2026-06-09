/**
 * login.js — Wrapper Messenger per la capability login condivisa.
 */

import { renderLogin as _renderLogin } from '@shared/capabilities/login/index.js';

export function renderLogin(container) {
  _renderLogin(container, {
    title:    'EasyChats',
    subtitle: 'Peer-to-peer messaging on the Internet Computer',
  });
}
