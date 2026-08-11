#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { encodeAudioFile, synthesizeSpeech } from './mistral-tts.mjs';

const args = parseArgs(process.argv.slice(2));

if (!args.text || args.help) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

try {
  const refAudio = args.refAudio
    ? await encodeAudioFile(args.refAudio)
    : undefined;

  const result = await synthesizeSpeech({
    input: args.text,
    model: args.model,
    voiceId: args.voiceId,
    refAudio,
    responseFormat: args.format,
  });

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, result.audio);
  console.log(`Saved ${result.audio.length} bytes to ${args.output}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    format: 'mp3',
    output: 'output.mp3',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--text' || arg === '-t') options.text = next;
    else if (arg === '--voice-id') options.voiceId = next;
    else if (arg === '--ref-audio') options.refAudio = next;
    else if (arg === '--format' || arg === '-f') options.format = next;
    else if (arg === '--output' || arg === '-o') options.output = next;
    else if (arg === '--model') options.model = next;
    else if (!arg.startsWith('-') && !options.text) options.text = arg;
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  MISTRAL_API_KEY=... node src/cli.mjs "Text to speak" --voice-id VOICE_ID

Options:
  -t, --text TEXT       Text sent to Voxtral TTS
      --voice-id ID     Saved preset or custom voice ID
      --ref-audio PATH  Reference audio file path for voice cloning
  -f, --format FORMAT   mp3, wav, flac, opus, or pcm (default: mp3)
  -o, --output PATH     Output file (default: output.mp3)
      --model MODEL     Model override (default: voxtral-mini-tts-2603)
  -h, --help            Show this help`);
}
