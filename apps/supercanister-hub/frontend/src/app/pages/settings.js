/**
 * settings.js — wrapper EasyHub sulla pagina impostazioni CONDIVISA (come vault/messenger).
 * Account (canister+principal+logout) dalla capability; sovranità/verifica/aggiornamenti come link-section.
 */

import { renderSettings as _renderSettings } from '@shared/capabilities/settings/index.js';
import { sovereigntyLinkSection } from '@shared/capabilities/sovereignty/page.js';
import { verifyLinkSection }      from '@shared/capabilities/verify/page.js';
import { updateLinkSection }      from '@shared/capabilities/update/page.js';
import { CANISTER_ID }            from '@shared/core/config.js';

export function renderSettings(container) {
  _renderSettings(container, {
    canisterId: CANISTER_ID,
    showCanisterHealth: true,
    extraSections: [
      sovereigntyLinkSection(),
      verifyLinkSection(),
      updateLinkSection(),
    ],
  });
}
