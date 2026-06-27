/**
 * capsule-decrypt.js — Decryptor della Time Capsule, lato EREDE. Rotta #decrypt.
 *
 * Il rovescio outbound di #open: l'erede NON entra nel computer dell'owner per "ritirare" il segreto.
 * Al silenzio l'agente gli ha già CONSEGNATO l'envelope sigillato sul suo canale (un webhook). Qui lo
 * apre — interamente nel browser, **zero chiamate al canister**, nessun login, nessun caller: incolla
 * l'envelope ricevuto + la passphrase avuta out-of-band → plaintext. È un puro tool client-side, quindi
 * non è una superficie inbound ([[outbound_only]]): non tocca il canister, non ha endpoint, non ha gate.
 *
 * Il payload è autodescrittivo (envelope-metodo F1): `readEnvelopeMethod` legge la strategia SENZA
 * decifrare → oggi 'passphrase'. Le altre etichette (vetkeys/subnetkey) sono riconosciute e respinte
 * con un messaggio chiaro finché non implementate.
 */

import { el, render } from '@shared/ui/dom.js';
import { openStringWithPassphrase, readEnvelopeMethod, METHOD_PASSPHRASE } from '@shared/core/crypto.js';

export function renderCapsuleDecrypt(container) {
  const envIn = el('textarea', { class: 'mono', rows: '7',
    placeholder: 'Paste the sealed capsule you received on your channel (a JSON block starting with {"v":1,…}).' });
  const passIn = el('input', { type: 'text', class: 'mono',
    placeholder: 'Paste the passphrase the sender gave you separately' });
  const out = el('div', { class: 'decrypt-out' });
  const openBtn = el('button', { class: 'btn-primary' }, 'Open the capsule');

  openBtn.onclick = async () => {
    out.replaceChildren();
    const envText = envIn.value.trim();
    const passphrase = passIn.value;
    if (!envText) { out.append(el('p', { class: 'error' }, 'Paste the sealed capsule first.')); return; }
    if (!passphrase) { out.append(el('p', { class: 'error' }, 'Paste the passphrase the sender gave you.')); return; }

    let envBytes;
    try {
      envBytes = new TextEncoder().encode(envText);
    } catch {
      out.append(el('p', { class: 'error' }, 'The capsule text could not be read.'));
      return;
    }

    // Riconosci la strategia SENZA decifrare. Oggi solo 'passphrase'.
    let method;
    try {
      method = readEnvelopeMethod(envBytes);
    } catch {
      out.append(el('p', { class: 'error' },
        'This does not look like a sealed capsule. Paste the exact block you received, including the outer { }.'));
      return;
    }
    if (method !== METHOD_PASSPHRASE) {
      out.append(el('p', { class: 'error' },
        `This capsule uses the “${method}” method, which this opener can’t handle yet. It was sealed with a different strategy.`));
      return;
    }

    openBtn.disabled = true;
    openBtn.textContent = 'Opening…';
    try {
      const plaintext = await openStringWithPassphrase(envBytes, passphrase);
      out.append(
        el('div', { class: 'card decrypt-result' },
          el('div', { class: 'meta ok' }, '🔓 Opened'),
          el('div', { class: 'decrypt-plaintext' }, plaintext),
          el('div', { class: 'card-actions' },
            el('button', { class: 'btn-secondary',
              onclick: () => navigator.clipboard?.writeText(plaintext) }, 'Copy message'))));
    } catch {
      // Errore di decifratura = passphrase sbagliata o envelope alterato (AES-GCM autentica).
      out.append(el('p', { class: 'error' },
        'Could not open it. Check the passphrase character-for-character, and make sure the capsule text is complete and unaltered.'));
    } finally {
      openBtn.disabled = false;
      openBtn.textContent = 'Open the capsule';
    }
  };

  render(container,
    el('div', { class: 'page-header' },
      el('h1', {}, 'Open a Time Capsule'),
      el('p', {}, 'A sealed message was left for you. Open it here — entirely in your browser. ' +
        'Nothing you type is sent anywhere: this page never contacts the sender’s computer.')),
    el('div', { class: 'card' },
      el('label', { class: 'field' }, el('span', {}, 'The sealed capsule'), envIn),
      el('label', { class: 'field' }, el('span', {}, 'The passphrase'), passIn),
      el('div', { class: 'card-actions' }, openBtn),
    ),
    out,
    el('p', { class: 'hint small', style: 'margin-top:1rem;' },
      'The passphrase and the capsule reach you through two separate channels on purpose: the capsule rides a delivery webhook, ' +
      'the passphrase comes to you directly. One without the other reveals nothing.'),
  );
}
