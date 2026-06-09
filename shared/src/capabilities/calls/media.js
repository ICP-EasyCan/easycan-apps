/**
 * Calls Media — gestione microfono e audio remoto.
 *
 * Exports (interni alla capability calls):
 *   acquireMic()                → MediaStream
 *   addLocalTracks(pc, stream)  → void
 *   attachRemoteAudio(pc)       → HTMLAudioElement
 *   cleanupMedia(activeCall)    → void
 */

/**
 * Richiede accesso al microfono. Lancia errore se negato.
 * @returns {Promise<MediaStream>}
 */
export async function acquireMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
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
    pc.addTrack(track, stream);
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
