/**
 * chat.js — Pagina conversazione con un peer.
 *
 * Params dal router: "canisterId:principalId"
 *
 * Usa la capability di orchestrazione chat-session per tutta la logica
 * (poll, dedup, archive, localStorage). La pagina gestisce solo la UI.
 */

import { CANISTER_ID }     from '@shared/core/config.js';
import { getPrincipalText } from '@shared/core/auth.js';
import { CallError }        from '@shared/capabilities/errors.js';
import { el, render, formatLastSeen }
                            from '@shared/ui/dom.js';
import { navigate }         from '@shared/ui/router.js';
import { checkTier }        from '@shared/core/platform.js';
import { avatarEl }         from '../components/avatar.js';

// Orchestrazione
import { startChatSession } from '@shared/capabilities/chat-session/index.js';

// Capability dirette (non parte della sessione chat)
import { checkPeerPresence, initiateCall, getActiveCall }
                            from '../connection-manager.js';
import { getContactAlias }  from '../contacts-store.js';
import { playMessage }      from '@shared/capabilities/sounds/index.js';

// ─── Pagina chat ───────────────────────────────────────────────────────────

export function renderChat(container, param) {
  const [peerCid, peerPid] = (param || '').split(':');
  if (!peerCid || !peerPid) { navigate('#chats'); return; }

  let session = null;
  // Beep solo sui messaggi arrivati DOPO l'avvio sessione: il replay della storia
  // locale/archivio passa dallo stesso onMessage e non deve suonare.
  let sessionLive = false;
  // localId del messaggio in corso di modifica, null se non si sta modificando.
  let editingLocalId = null;

  // ─── Header ──────────────────────────────────────────────────────────────

  const alias = getContactAlias(peerCid) || peerPid.slice(0, 12) + '...';

  const presenceEl = el('span', { class: 'chat-header-presence' }, '');
  const callBtn = el('button', { class: 'btn-icon', title: 'Call', onclick: handleCall }, '\u{1F4DE}');
  const pinBtn = el('button', { class: 'btn-icon', title: 'Local chat only' }, '\u{1F4CE}');

  // Query presenza all'apertura
  checkPeerPresence(peerCid).then(({ online, lastSeenMs }) => {
    if (online) {
      presenceEl.textContent = 'online';
      presenceEl.style.color = 'var(--online)';
    } else if (lastSeenMs) {
      presenceEl.textContent = formatLastSeen(lastSeenMs);
      presenceEl.style.color = 'var(--text-dim)';
    }
  }).catch(() => {});

  // ─── Layout ──────────────────────────────────────────────────────────────

  const msgList = el('div', { class: 'msg-list' });
  const inputField = el('input', { type: 'text', placeholder: 'Type a message...' });
  const sendBtn = el('button', { class: 'btn-icon', title: 'Send', onclick: handleSend }, '➤');
  const editBanner = el('div', { class: 'chat-edit-banner', style: 'display:none;' },
    el('span', {}, 'Editing message'),
    el('button', { class: 'btn-icon', title: 'Cancel edit', onclick: cancelEdit }, '✕'),
  );

  const headerAv = avatarEl(alias, peerPid);
  headerAv.classList.add('sm');

  render(container,
    el('div', { class: 'page page-chat' },
      el('header', { class: 'topbar' },
        el('button', { class: 'btn-icon', onclick: () => { if (session) session.stop(); navigate('#chats'); }, title: 'Back' }, '\u2190'),
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
        sendBtn,
      ),
    ),
  );

  inputField.focus();

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
    sessionLive = true;
    pinBtn.onclick = async () => {
      if (!session) return;
      const allowed = await checkTier(CANISTER_ID, 1);
      if (!allowed) {
        addSystemMessage('Persistent archive is available in the Pro plan.');
        return;
      }
      session.togglePersist();
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

    if (editingLocalId) {
      const localId = editingLocalId;
      cancelEdit();
      const ok = await session.editMessage(localId, text);
      if (!ok) inputField.value = text; // fallito (es. consegnato nel frattempo) — non perdere il testo
      return;
    }

    inputField.value = '';
    await session.send(text);
  }

  // ─── Modifica ────────────────────────────────────────────────────────────

  function startEdit(localId, text) {
    editingLocalId = localId;
    inputField.value = text;
    inputField.focus();
    editBanner.style.display = 'flex';
    sendBtn.title = 'Save edit';
  }

  function cancelEdit() {
    editingLocalId = null;
    inputField.value = '';
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
    const { localId, status, errorCode, errorMessage, delivery, edited } = meta;

    if (from === 'peer' && sessionLive) playMessage();

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
