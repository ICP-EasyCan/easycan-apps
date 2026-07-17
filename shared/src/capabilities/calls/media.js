/**
 * Calls Media — gestione microfono e audio remoto.
 *
 * Exports (interni alla capability calls):
 *   acquireMic()                → MediaStream
 *   addLocalTracks(pc, stream)  → void
 *   attachRemoteAudio(pc)       → HTMLAudioElement
 *   cleanupMedia(activeCall)    → void
 *   tuneOpusSdp(sdp)            → string (SDP con fmtp Opus per voce su cellulare)
 */

/**
 * Richiede accesso al microfono. Lancia errore se negato.
 * @returns {Promise<MediaStream>}
 */
export async function acquireMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError'
      ? 'Microphone access denied'
      : `Microphone unavailable: ${err.message}`);
  }
}

/**
 * Aggiunge le track audio locali alla PeerConnection.
 */
export function addLocalTracks(pc, stream) {
  for (const track of stream.getAudioTracks()) {
    track.contentHint = 'speech';
    pc.addTrack(track, stream);
  }
}

/**
 * Forza nei fmtp di Opus i parametri per voce su rete cellulare:
 *   useinbandfec=1        → FEC in-band, recupera pacchetti persi (il più importante)
 *   usedtx=1              → silenzio ≈ zero banda
 *   maxaveragebitrate=24000 → 24 kbps medi, voce pulita senza saturare l'uplink
 *   stereo=0              → mono
 * I parametri fmtp li legge il MITTENTE dalla description remota → vanno
 * applicati su TUTTE le description (offer/answer, locali e remote).
 * SDP inatteso → ritorna l'originale intatto: il tuning non deve mai rompere
 * la negoziazione.
 * @param {string} sdp
 * @returns {string}
 */
export function tuneOpusSdp(sdp) {
  try {
    if (typeof sdp !== 'string') return sdp;
    const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000(?:\/2)?/i);
    if (!rtpmap) return sdp;
    const pt = rtpmap[1];
    const params = {
      useinbandfec: '1',
      usedtx: '1',
      maxaveragebitrate: '24000',
      stereo: '0',
    };
    const fmtpRe = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    const fmtp = sdp.match(fmtpRe);
    const forced = Object.entries(params).map(([k, v]) => `${k}=${v}`);
    if (fmtp) {
      const kept = fmtp[1].split(';')
        .map(s => s.trim())
        .filter(kv => kv && !(kv.split('=')[0].trim() in params));
      return sdp.replace(fmtpRe, `a=fmtp:${pt} ${[...kept, ...forced].join(';')}`);
    }
    // Nessuna fmtp per Opus: aggiungila subito dopo la rtpmap
    return sdp.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${forced.join(';')}`);
  } catch {
    return sdp;
  }
}

/**
 * Crea un <audio> nascosto e registra pc.ontrack per audio remoto.
 * @returns {HTMLAudioElement}
 */
export function attachRemoteAudio(pc) {
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.style.display = 'none';
  document.body.appendChild(audio);
  pc.ontrack = (ev) => {
    audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
  };
  return audio;
}

/**
 * Pulisce stream locale e audio remoto.
 * @param {{ localStream?: MediaStream, remoteAudio?: HTMLAudioElement }} activeCall
 */
export function cleanupMedia(activeCall) {
  if (activeCall?.localStream) {
    for (const track of activeCall.localStream.getTracks()) track.stop();
  }
  if (activeCall?.remoteAudio) {
    activeCall.remoteAudio.srcObject = null;
    activeCall.remoteAudio.remove();
  }
}
