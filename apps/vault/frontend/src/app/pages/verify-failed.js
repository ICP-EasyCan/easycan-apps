/**
 * verify-failed.js — Schermata "non ho potuto verificare la proprietà".
 *
 * Mostrata quando il gate di proprietà (checkOwnership) NON riesce a confermare
 * che il canister è del chiamante: query in errore (rete/canister non raggiungibile)
 * oppure owner non ancora registrato. Fail-CLOSED: niente accesso alla dashboard.
 * Diversa da #not-owner (lì sappiamo che appartiene a un altro → cambio identità);
 * qui l'esito è incerto → Retry (errore transitorio) o re-login (claim mancante).
 */

import { el, render }  from '@shared/ui/dom.js';
import { logout }      from '@shared/core/auth.js';
import { navigate }    from '@shared/ui/router.js';

export function renderVerifyFailed(container) {
  render(container,
    el('div', { class: 'page page-not-owner' },
      el('div', { class: 'not-owner-box' },
        el('div', { class: 'not-owner-icon' }, '⚠️'),
        el('h2', {}, 'Couldn’t verify ownership'),
        el('p', {},
          'We couldn’t confirm that this canister belongs to you.',
        ),
        el('p', { class: 'hint small' },
          'This is usually a temporary network issue. Retry, or log in again ' +
          'to finish setting up this app.',
        ),
        // Retry: torna alla home → requireAuth ri-esegue checkOwnership
        // (appOwnershipVerified è ancora false finché non passa).
        el('button', { class: 'btn-primary', onclick: () => navigate('#dashboard') },
          'Retry',
        ),
        el('button', { class: 'btn-secondary', onclick: () => logout() },
          'Log in again',
        ),
      ),
    ),
  );
}
