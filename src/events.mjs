const SECRET_KEYS = /(?:api[-_]?key|authorization|password|secret|token)/i;
const REDACTED = '[REDACTED]';

export function emitEvent(event, write = process.stdout.write) {
  const redacted = redactEvent(event);
  write(`${JSON.stringify(redacted)}\n`);
}

export function redactEvent(value, secrets = collectSecrets(value)) {
  if (Array.isArray(value)) return value.map((item) => redactEvent(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS.test(key) ? REDACTED : redactEvent(item, secrets),
    ]));
  }
  if (typeof value === 'string') {
    return secrets.reduce((result, secret) => result.split(secret).join(REDACTED), value);
  }
  return value;
}

function collectSecrets(value, secrets = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecrets(item, secrets));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (SECRET_KEYS.test(key) && typeof item === 'string' && item.trim()) secrets.push(item);
      collectSecrets(item, secrets);
    });
  }

  const environmentKey = process.env.MISTRAL_API_KEY?.trim();
  if (environmentKey) secrets.push(environmentKey);
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}
