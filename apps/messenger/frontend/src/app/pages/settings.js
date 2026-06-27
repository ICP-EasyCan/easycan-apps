/**
 * settings.js — Wrapper Messenger per la capability settings condivisa.
 */

import { renderSettings as _renderSettings } from '@shared/capabilities/settings/index.js';
import { sovereigntyLinkSection }            from '@shared/capabilities/sovereignty/page.js';
import { verifyLinkSection }                 from '@shared/capabilities/verify/page.js';
import { updateLinkSection }                 from '@shared/capabilities/update/page.js';
import { el }                                from '@shared/ui/dom.js';
import { CANISTER_ID }                       from '@shared/core/config.js';

export function renderSettings(container) {
  _renderSettings(container, {
    canisterId: CANISTER_ID,
    showCanisterHealth: true,
    extraSections: [
      sovereigntyLinkSection(),
      verifyLinkSection(),
      updateLinkSection(),
      {
        title: 'Privacy & limitations',
        content: [
          el('div', { class: 'settings-notice' },
            el('div', { class: 'settings-notice-title' }, '\u{1F513} Messages are not end-to-end encrypted'),
            el('div', { class: 'hint small' },
              'Your messages travel over HTTPS to the Internet Computer, but the recipient’s canister can read them in plain text. ' +
              'Do not share secrets, passwords or sensitive personal data here. ' +
              'End-to-end encryption is on the roadmap but not active yet.'),
          ),
          el('div', { class: 'settings-notice' },
            el('div', { class: 'settings-notice-title' }, '\u{1F4DE} Voice calls may not always connect'),
            el('div', { class: 'hint small' },
              'Calls go directly from device to device, without a relay server. ' +
              'On most home and mobile networks this works, but on some restrictive networks (corporate Wi-Fi, certain mobile carriers, public hotspots) the connection cannot be established and the call will fail. ' +
              'Video calls are not supported yet.'),
          ),
          el('div', { class: 'settings-notice' },
            el('div', { class: 'settings-notice-title' }, '\u{1F91D} Contacts are mutual'),
            el('div', { class: 'hint small' },
              'You can only message or call someone who has also added you to their contacts. ' +
              'If the other person has not added you, your message or call will not be delivered — you will see a clear notice in the chat.'),
          ),
          el('div', { class: 'settings-notice' },
            el('div', { class: 'settings-notice-title' }, '\u{1F4E6} Message storage'),
            el('div', { class: 'hint small' },
              'Pending messages are kept on the sender’s canister for up to 7 days, then deleted automatically. ' +
              'Chat history is stored locally in your browser unless you pin a conversation (Pro plan), in which case it is archived in your canister.'),
          ),
        ],
      },
    ],
  });
}
