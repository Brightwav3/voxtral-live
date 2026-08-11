import { createPortAudioBackend } from './portaudio-backend.mjs';

export function createAudioBackend(options = {}) {
  return createPortAudioBackend(options);
}
