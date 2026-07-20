/**
 * chat.js — Pagina conversazione con un peer.
 *
 * Params dal router: "canisterId:principalId"
 *
 * Usa la capability di orchestrazione chat-session per tutta la logica
 * (poll, dedup, archive, localStorage). La pagina gestisce solo la UI.
 */

import { CANISTER_ID }     from '@shared/core/config.js';
import { bus }             from '@shared/core/event-bus.js';
import { getPrincipalText } from '@shared/core/auth.js';
import { CallError }        from '@shared/capabilities/errors.js';
import { el, render, formatLastSeen }
                            from '@shared/ui/dom.js';
import { navigate }         from '@shared/ui/router.js';
import { avatarEl }         from '../components/avatar.js';

// Orchestrazione
import { startChatSession } from '@shared/capabilities/chat-session/index.js';

// Capability dirette (non parte della sessione chat)
import { watchPeerPresence, initiateCall, getActiveCall }
                            from '../connection-manager.js';
import { getContactAlias }  from '../contacts-store.js';
import { playMessage }      from '@shared/capabilities/sounds/index.js';

// ─── Pagina chat ───────────────────────────────────────────────────────────

export function renderChat(container, param) {
  const [peerCid, peerPid] = (param || '').split(':');
  if (!peerCid || !peerPid) { navigate('#chats'); return; }

  let session = null;
  // localId del messaggio in corso di modifica, null se non si sta modificando.
  let editingLocalId = null;

  // Stop della sessione appena si lascia questa chat, per QUALSIASI via
  // (back, bottom-nav, click su un'altra chat nel rail desktop, logout).
  // Senza questo la sessione resta viva a pollare: consuma i messaggi del
  // peer al posto di notify (niente pallino) e ruba i messaggi alla chat
  // visibile scrivendoli in un DOM staccato.
  const chatKey = `#chat/${peerCid}:${peerPid}`;
  let leftChat = false;
  let presenceStop = null;
  const unsubRoute = bus.on('route:change', ({ hash }) => {
    if (hash === chatKey) return;
    leftChat = true;
    unsubRoute();
    if (presenceStop) presenceStop();
    if (session) session.stop();
  });

  // ─── Header ──────────────────────────────────────────────────────────────

  const alias = getContactAlias(peerCid) || peerPid.slice(0, 12) + '...';

  const presenceEl = el('span', { class: 'chat-header-presence' }, '');
  const callBtn = el('button', { class: 'btn-icon', title: 'Call', onclick: handleCall }, '\u{1F4DE}');
  const pinBtn = el('button', { class: 'btn-icon', title: 'Local chat only' }, '\u{1F4CE}');

  // Presenza a chat aperta: primo check immediato + auto-refresh (30s) e ripoll
  // su visibilitychange. Lo stop() è agganciato al teardown route:change sopra.
  presenceStop = watchPeerPresence(peerCid, ({ online, lastSeenMs }) => {
    if (online) {
      presenceEl.textContent = 'online';
      presenceEl.style.color = 'var(--online)';
    } else if (lastSeenMs) {
      presenceEl.textContent = formatLastSeen(lastSeenMs);
      presenceEl.style.color = 'var(--text-dim)';
    } else {
      presenceEl.textContent = '';
    }
  });

  // ─── Layout ──────────────────────────────────────────────────────────────

  // Limite payload per messaggio (mirror del cap-messaging max_payload_bytes
  // del messenger). Il contatore compare avvicinandosi alla soglia e blocca
  // l'invio oltre il tetto — l'utente lo vede prima, non con un errore tecnico.
  const MAX_BYTES  = 2048;
  const WARN_BYTES = 1843; // ~90%: sotto questa quota il contatore resta nascosto

  const msgList = el('div', { class: 'msg-list' });
  const inputField = el('input', { type: 'text', placeholder: 'Type a message...' });
  const counterEl = el('span', { class: 'char-counter', style: 'display:none;' }, '');
  const sendBtn = el('button', { class: 'btn-icon', title: 'Send', onclick: handleSend }, '➤');

  function byteLen(str) { return new TextEncoder().encode(str).length; }

  function updateCounter() {
    const bytes = byteLen(inputField.value);
    const over  = bytes > MAX_BYTES;
    if (bytes >= WARN_BYTES) {
      counterEl.style.display = '';
      counterEl.textContent = `${bytes} / ${MAX_BYTES}`;
      counterEl.classList.toggle('over', over);
    } else {
      counterEl.style.display = 'none';
      counterEl.classList.remove('over');
    }
    sendBtn.disabled = over;
  }
  const editBanner = el('div', { class: 'chat-edit-banner', style: 'display:none;' },
    el('span', {}, 'Editing message'),
    el('button', { class: 'btn-icon', title: 'Cancel edit', onclick: cancelEdit }, '✕'),
  );

  const headerAv = avatarEl(alias, peerPid);
  headerAv.classList.add('sm');

  render(container,
    el('div', { class: 'page page-chat' },
      el('header', { class: 'topbar' },
        el('button', { class: 'btn-icon', onclick: () => navigate('#chats'), title: 'Back' }, '\u2190'),
        headerAv,
        el('div', { class: 'chat-header-info' },
          el('span', { class: 'chat-header-name' }, alias),
          presenceEl,
        ),
        el('div', { class: 'topbar-right' },
          callBtn,
          pinBtn,
        ),
      ),
      msgList,
      editBanner,
      el('div', { class: 'chat-input' },
        inputField,
        counterEl,
        sendBtn,
      ),
    ),
  );

  inputField.focus();

  // Contatore byte live
  inputField.addEventListener('input', updateCounter);

  // Enter per inviare
  inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // ─── Avvio sessione chat ─────────────────────────────────────────────────

  startChatSession({
    ownCid:    CANISTER_ID,
    peerCid,
    peerPid,
    senderPid: getPrincipalText(),
    onMessage: addMessage,
    onSystem:  addSystemMessage,
    onPersistence: updatePinUI,
  }).then(s => {
    session = s;
    // Navigato via prima che la sessione finisse di partire: spegnila subito.
    if (leftChat) { s.stop(); return; }
    // Il pin è gratis per tutti: salva la cronologia nel proprio canister.
    pinBtn.onclick = () => {
      if (session) session.togglePersist();
    };
  });

  // ─── Chiamata ──────────────────────────────────────────────────────────

  async function handleCall() {
    const active = getActiveCall();
    if (active) {
      if (active.peerCid === peerCid) return;
      addSystemMessage('Call already in progress with another contact.');
      return;
    }
    try {
      await initiateCall(CANISTER_ID, peerCid, peerPid, getPrincipalText());
    } catch (err) {
      const code = err instanceof CallError ? err.code : 'unknown';
      const msg = callErrorMessage(code, alias, err.message);
      if (msg) addSystemMessage(msg);
    }
  }

  function callErrorMessage(code, who, raw) {
    switch (code) {
      case 'hangup':
        return null;
      case 'not_in_whitelist':
        return `Cannot call ${who}: you are not in their contacts.`;
      case 'peer_offline':
        return `${who} did not answer.`;
      case 'canister_unreachable':
        return `${who} is not reachable right now.`;
      case 'webrtc_failed':
        return `Audio connection failed. Calls use STUN only — if either side is behind a strict NAT, audio may not pass.`;
      case 'mic_denied':
        return `Microphone access was denied.`;
      case 'busy':
        return `A call is already in progress.`;
      default:
        return `Call failed${raw ? `: ${raw}` : '.'}`;
    }
  }

  // ─── Invio ─────────────────────────────────────────────────────────────

  async function handleSend() {
    const text = inputField.value.trim();
    if (!text || !session) return;
    // Oltre il tetto non si invia: il contatore è già rosso e sendBtn disabled,
    // ma l'invio via Enter bypassa il disabled → guardia esplicita qui.
    if (byteLen(text) > MAX_BYTES) return;

    if (editingLocalId) {
      const localId = editingLocalId;
      cancelEdit();
      const ok = await session.editMessage(localId, text);
      if (!ok) { inputField.value = text; updateCounter(); } // fallito (es. consegnato nel frattempo) — non perdere il testo
      return;
    }

    inputField.value = '';
    updateCounter();
    await session.send(text);
  }

  // ─── Modifica ────────────────────────────────────────────────────────────

  function startEdit(localId, text) {
    editingLocalId = localId;
    inputField.value = text;
    inputField.focus();
    updateCounter();
    editBanner.style.display = 'flex';
    sendBtn.title = 'Save edit';
  }

  function cancelEdit() {
    editingLocalId = null;
    inputField.value = '';
    updateCounter();
    editBanner.style.display = 'none';
    sendBtn.title = 'Send';
  }

  // ─── Eliminazione ────────────────────────────────────────────────────────

  async function handleDeleteForEveryone(localId) {
    if (!session) return;
    if (!window.confirm('Delete this message for everyone? The recipient will never see it.')) return;
    const ok = await session.deleteMessage(localId);
    if (ok) removeMessageNode(localId);
  }

  async function handleDeleteForMe(localId) {
    if (!session) return;
    if (!window.confirm('Delete this message for you? It stays visible to the other side if already delivered.')) return;
    await session.deleteMessage(localId);
    removeMessageNode(localId);
  }

  function removeMessageNode(localId) {
    const node = msgList.querySelector(`[data-local-id="${localId}"]`);
    if (node) node.remove();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  function addMessage(from, text, time = new Date().toLocaleTimeString(), meta = {}) {
    const { localId, status, errorCode, errorMessage, delivery, edited, live } = meta;

    // Beep solo sui messaggi davvero nuovi (meta.live, escluso il drain
    // iniziale: per quelli notify ha già suonato) e a pagina visibile
    // (nascosta → suona il ramo notify in main.js, mai entrambi).
    if (from === 'peer' && live && !document.hidden) playMessage();

    // If the message already exists in the DOM (re-render after retry/send),
    // replace it in place so the chat does not get duplicated.
    let existing = null;
    if (localId) {
      existing = msgList.querySelector(`[data-local-id="${localId}"]`);
    }

    const attrs = { class: `msg msg-${from}` };
    if (localId) attrs['data-local-id'] = localId;
    if (status === 'failed') attrs.class += ' msg-failed';
    if (status === 'sending') attrs.class += ' msg-sending';

    const children = [
      el('span', { class: 'msg-text' }, text),
      el('span', { class: 'msg-time' },
        status === 'sending' ? 'sending…' : time),
    ];

    if (edited) {
      children.push(el('span', { class: 'msg-edited' }, 'edited'));
    }

    // ✓/✓✓: solo per i propri messaggi risolti (non sending/failed). Copy
    // onesto — ✓✓ significa "consegnato al dispositivo", mai "letto"; se
    // scaduto (TTL 7gg senza essere stato consegnato) lo si dice esplicito
    // invece di mostrare una spunta doppia falsa.
    const isResolved = status !== 'sending' && status !== 'failed';
    if (from === 'me' && isResolved && delivery) {
      const tick = delivery === 'pending' ? '✓'
        : delivery === 'expired' ? 'expired' : '✓✓';
      const tickTitle = delivery === 'pending' ? 'Sent'
        : delivery === 'expired' ? 'Expired after 7 days without being delivered'
        : 'Delivered to device';
      children.push(el('span', { class: `msg-tick msg-tick-${delivery}`, title: tickTitle }, tick));
    }

    if (status === 'failed') {
      children.push(
        el('span', { class: 'msg-error' }, sendErrorMessage(errorCode, errorMessage)),
        el('div', { class: 'msg-actions' },
          el('button', {
            class: 'msg-action-btn',
            onclick: () => session && session.retry(localId),
          }, 'Retry'),
          el('button', {
            class: 'msg-action-btn msg-action-discard',
            onclick: () => {
              if (!session) return;
              session.discard(localId);
              removeMessageNode(localId);
            },
          }, 'Discard'),
        ),
      );
    } else if (isResolved && localId) {
      if (from === 'me' && delivery === 'pending') {
        children.push(
          el('div', { class: 'msg-actions msg-actions-passive' },
            el('button', {
              class: 'msg-action-btn',
              title: 'Edit',
              onclick: () => startEdit(localId, text),
            }, '✎'),
            el('button', {
              class: 'msg-action-btn msg-action-discard',
              title: 'Delete for everyone',
              onclick: () => handleDeleteForEveryone(localId),
            }, '🗑'),
          ),
        );
      } else {
        children.push(
          el('div', { class: 'msg-actions msg-actions-passive' },
            el('button', {
              class: 'msg-action-btn msg-action-discard',
              title: 'Delete for me',
              onclick: () => handleDeleteForMe(localId),
            }, '🗑'),
          ),
        );
      }
    }

    const msgEl = el('div', attrs, ...children);

    if (existing) {
      existing.replaceWith(msgEl);
    } else {
      msgList.appendChild(msgEl);
    }
    msgList.scrollTop = msgList.scrollHeight;
  }

  function sendErrorMessage(code, raw) {
    switch (code) {
      case 'not_in_whitelist':
        return `Not delivered — ${alias} has not added you to their contacts.`;
      case 'too_many_pending':
        return `Not delivered — ${alias} has too many undelivered messages waiting. They need to open the app to receive them first.`;
      case 'canister_unreachable':
        return `Not delivered — recipient canister unreachable.`;
      default:
        return raw ? `Not delivered — ${raw}` : 'Not delivered.';
    }
  }

  function addSystemMessage(text) {
    const msgEl = el('div', { class: 'msg msg-system' }, text);
    msgList.appendChild(msgEl);
    msgList.scrollTop = msgList.scrollHeight;
  }

  function updatePinUI(isPersistent) {
    pinBtn.textContent = isPersistent ? '\u{1F4CC}' : '\u{1F4CE}';
    pinBtn.title = isPersistent
      ? 'Chat saved in the canister (click to disable)'
      : 'Local chat only (click to save in the canister)';
  }
}
