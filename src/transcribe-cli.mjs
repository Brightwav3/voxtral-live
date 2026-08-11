#!/usr/bin/env node

import { transcribeAudio } from './mistral-transcribe.mjs';

const args = parseArgs(process.argv.slice(2));

if (!args.file || args.help) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

try {
  const result = await transcribeAudio({
    filePath: args.file,
    model: args.model,
    language: args.language,
  });

  console.log(result.text);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--file' || arg === '-f') options.file = next;
    else if (arg === '--language' || arg === '-l') options.language = next;
    else if (arg === '--model') options.model = next;
    else if (!arg.startsWith('-') && !options.file) options.file = arg;
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  node src/transcribe-cli.mjs audio.mp3 --language en

Options:
  -f, --file PATH        Audio file to transcribe
  -l, --language CODE    Optional language code, e.g. en, de, fr
      --model MODEL      Default: voxtral-mini-latest
  -h, --help             Show this help`);
}
