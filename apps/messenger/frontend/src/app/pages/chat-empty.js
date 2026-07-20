/**
 * chat-empty.js — Splash mostrato nel pannello destro su desktop
 * quando l'hash è #chats (nessuna conversazione selezionata).
 */

import { el, render } from '@shared/ui/dom.js';

export function renderChatEmpty(container) {
  render(container,
    el('div', { class: 'chat-splash' },
      el('div', { class: 'chat-splash-icon' }, '\u{1F4AC}'),
      el('div', { class: 'chat-splash-title' }, 'Select a conversation'),
      el('div', { class: 'chat-splash-sub' },
        'Choose a chat from the list to start messaging. ' +
        'Contacts are mutual: share your code so the other person can add you — and add theirs too. Messages flow only once both sides have added each other.'
      ),
    ),
  );
}
