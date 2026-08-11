const DEFAULTS = {
  mode: 'always-on',
  sttModel: 'voxtral-mini-transcribe-realtime-2602',
  sttDelayMs: 240,
  llmModel: 'mistral-small-latest',
  ttsModel: 'voxtral-mini-tts-latest',
};

export function loadConfig(env = process.env, argv = []) {
  const apiKey = cleanRequired(env.MISTRAL_API_KEY);
  const mode = readMode(env, argv);
  const audioProfile = readAudioProfile(argv);
  const echoCancellation = argv.includes('--echo-cancel');
  if (audioProfile === 'speaker' && !echoCancellation) {
    throw invalidCliArgument('missing_echo_cancel', 'speaker mode requires --echo-cancel', '--echo-cancel');
  }

  return {
    apiKey,
    mode,
    sttModel: cleanOptional(env.MISTRAL_STT_MODEL) ?? DEFAULTS.sttModel,
    sttDelayMs: readPositiveInteger(argv, '--stt-delay-ms', DEFAULTS.sttDelayMs),
    llmModel: cleanOptional(env.MISTRAL_LLM_MODEL) ?? DEFAULTS.llmModel,
    ttsModel: cleanOptional(env.MISTRAL_TTS_MODEL) ?? DEFAULTS.ttsModel,
    voiceId: cleanOptional(env.MISTRAL_VOICE_ID),
    inputDevice: readDeviceId(argv, '--input-device'),
    outputDevice: readDeviceId(argv, '--output-device'),
    audioProfile,
    echoCancellation,
    sampleRate: 16000,
    frameMs: 20,
  };
}

function readAudioProfile(argv) {
  const flag = '--audio-profile';
  const index = argv.findIndex((argument) => argument === flag || argument.startsWith(`${flag}=`));
  if (index === -1) return 'headset';
  const argument = argv[index];
  const value = argument === flag ? argv[index + 1] : argument.slice(flag.length + 1);
  if (!value || value.startsWith('--')) throw invalidCliArgument('missing_value', `${flag} requires headset or speaker`, flag);
  if (!['headset', 'speaker'].includes(value)) {
    throw invalidCliArgument('invalid_value', `${flag} must be headset or speaker`, flag);
  }
  return value;
}

function readPositiveInteger(argv, flag, defaultValue) {
  const index = argv.findIndex((argument) => argument === flag || argument.startsWith(`${flag}=`));
  if (index === -1) return defaultValue;
  const argument = argv[index];
  const value = argument === flag ? argv[index + 1] : argument.slice(flag.length + 1);
  if (!value || value.startsWith('--')) throw invalidCliArgument('missing_value', `${flag} requires a positive integer`, flag);
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw invalidCliArgument('invalid_value', `${flag} must be a positive integer`, flag);
  }
  return Number(value);
}

function readDeviceId(argv, flag) {
  const index = argv.findIndex((argument) => argument === flag || argument.startsWith(`${flag}=`));
  if (index === -1) return undefined;
  const argument = argv[index];
  const value = argument === flag ? argv[index + 1] : argument.slice(flag.length + 1);
  if (!value || value.startsWith('--')) throw invalidCliArgument('missing_value', `${flag} requires a device ID`, flag);
  if (!/^\d+$/.test(value)) throw invalidCliArgument('invalid_value', `${flag} must be a non-negative integer`, flag);
  return Number(value);
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

function invalidCliArgument(reason, message = 'The --mode argument is invalid', argument = '--mode') {
  const error = new Error(message);
  error.code = 'ERR_INVALID_CLI_ARGUMENT';
  error.argument = argument;
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
