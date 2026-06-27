/** login.js — wrapper EasyHub sulla capability login condivisa. */

import { renderLogin as _renderLogin } from '@shared/capabilities/login/index.js';

export function renderLogin(container) {
  _renderLogin(container, {
    title:    'EasyHub',
    subtitle: 'Your sovereign computer — awake when you\'re not, verifiable',
  });
}
