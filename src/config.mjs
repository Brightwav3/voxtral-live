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
  let argumentMode;
  if (modeArgumentIndex !== -1) {
    const argument = argv[modeArgumentIndex];
    if (argument === '--mode') {
      const nextArgument = argv[modeArgumentIndex + 1];
      if (!nextArgument || nextArgument.startsWith('--')) {
        throw invalidCliArgument('missing_value');
      }
      argumentMode = nextArgument;
    } else {
      argumentMode = argument.slice('--mode='.length);
    }
  }
  const mode = argumentMode ?? cleanOptional(env.VOXTRAL_MODE) ?? DEFAULTS.mode;

  if (!['always-on', 'push-to-talk'].includes(mode)) {
    throw invalidCliArgument('invalid_value', 'VOXTRAL_MODE must be always-on or push-to-talk');
  }

  return mode;
}

function invalidCliArgument(reason, message = 'The --mode argument is invalid') {
  const error = new Error(message);
  error.code = 'ERR_INVALID_CLI_ARGUMENT';
  error.argument = '--mode';
  error.reason = reason;
  return error;
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
