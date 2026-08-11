const DEFAULTS = {
  mode: 'always-on',
  sttModel: 'voxtral-mini-transcribe-realtime-2602',
  llmModel: 'mistral-small-latest',
  ttsModel: 'voxtral-mini-tts-latest',
};

export function loadConfig(env = process.env, argv = []) {
  const apiKey = cleanRequired(env.MISTRAL_API_KEY);
  const mode = readMode(env, argv);

  return {
    apiKey,
    mode,
    sttModel: cleanOptional(env.MISTRAL_STT_MODEL) ?? DEFAULTS.sttModel,
    llmModel: cleanOptional(env.MISTRAL_LLM_MODEL) ?? DEFAULTS.llmModel,
    ttsModel: cleanOptional(env.MISTRAL_TTS_MODEL) ?? DEFAULTS.ttsModel,
    voiceId: cleanOptional(env.MISTRAL_VOICE_ID),
    sampleRate: 16000,
    frameMs: 20,
  };
}

function readMode(env, argv) {
  const modeArgumentIndex = argv.findIndex((argument) => argument === '--mode' || argument.startsWith('--mode='));
  const argumentMode = modeArgumentIndex === -1
    ? undefined
    : argv[modeArgumentIndex].startsWith('--mode=')
      ? argv[modeArgumentIndex].slice('--mode='.length)
      : argv[modeArgumentIndex + 1];
  const mode = argumentMode ?? cleanOptional(env.VOXTRAL_MODE) ?? DEFAULTS.mode;

  if (!['always-on', 'push-to-talk'].includes(mode)) {
    throw new Error('VOXTRAL_MODE must be always-on or push-to-talk');
  }

  return mode;
}

function cleanRequired(value) {
  const cleaned = cleanOptional(value);
  if (!cleaned) throw new Error('MISTRAL_API_KEY is required');
  return cleaned;
}

function cleanOptional(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}
