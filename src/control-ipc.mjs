import net from 'node:net';

export const DEFAULT_PIPE_PATH = '\\\\.\\pipe\\voxtral-daemon';
const COMMANDS = new Set(['status', 'say', 'interrupt', 'shutdown']);
const MAX_FRAME_BYTES = 65_536;
let requestSequence = 0;

export function createControlServer({
  pipePath = DEFAULT_PIPE_PATH,
  handlers,
  netImpl = net,
  maxFrameBytes = MAX_FRAME_BYTES,
} = {}) {
  validateServerOptions({ pipePath, handlers, netImpl, maxFrameBytes });
  const sockets = new Set();
  let server;
  let started = false;
  let shuttingDown = false;

  return { pipePath, start, close, isShuttingDown: () => shuttingDown };

  async function start() {
    if (started) return;
    server = netImpl.createServer(handleConnection);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(pipePath);
    });
    started = true;
  }

  async function close() {
    if (!server) return;
    for (const socket of sockets) socket.destroy();
    if (!server.listening) {
      server = undefined;
      started = false;
      return;
    }
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    started = false;
  }

  function handleConnection(socket) {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxFrameBytes) {
        handled = true;
        respond(socket, failure(null, 'frame_too_large', 'Control request is too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      void processFrame(socket, buffer.slice(0, newline));
    });
    socket.once('end', () => {
      if (!handled && buffer.trim()) {
        handled = true;
        void processFrame(socket, buffer);
      }
    });
  }

  async function processFrame(socket, frame) {
    let request;
    try {
      request = JSON.parse(frame);
    } catch {
      respond(socket, failure(null, 'invalid_json', 'Control request must be valid JSON'));
      return;
    }
    const id = safeRequestId(request?.id);
    if (shuttingDown) {
      respond(socket, failure(id, 'shutting_down', 'Daemon shutdown is in progress'));
      return;
    }
    let command;
    let params;
    try {
      ({ command, params } = validateRequest(request));
    } catch (error) {
      respond(socket, failure(id, error.code, error.message));
      return;
    }
    if (command === 'shutdown') shuttingDown = true;
    try {
      const result = await handlers[command](params);
      respond(socket, { id, ok: true, result: result ?? {} });
    } catch (error) {
      respond(socket, failure(id, safeErrorCode(error?.code), 'Control command failed'));
    }
  }
}

export function requestControl({
  pipePath = DEFAULT_PIPE_PATH,
  command,
  params = {},
  timeoutMs = 5_000,
  netImpl = net,
} = {}) {
  const request = validateRequest({ id: `r_${process.pid}_${++requestSequence}`, command, params });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  return new Promise((resolve, reject) => {
    const socket = netImpl.createConnection(pipePath);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(controlError('control_timeout', 'Control request timed out')), timeoutMs);

    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: request.id, command: request.command, params: request.params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish(controlError('invalid_response', 'Daemon returned invalid JSON'));
        return;
      }
      if (!response?.ok) {
        finish(controlError(safeErrorCode(response?.error?.code), response?.error?.message ?? 'Control request failed'));
        return;
      }
      finish(undefined, response.result);
    });
    socket.once('error', (error) => finish(controlError(safeErrorCode(error?.code), 'Unable to connect to Voxtral daemon')));
    socket.once('end', () => {
      if (!settled) finish(controlError('connection_closed', 'Daemon closed the control connection'));
    });

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function validateServerOptions({ pipePath, handlers, netImpl, maxFrameBytes }) {
  if (typeof pipePath !== 'string' || !pipePath.trim()) throw new TypeError('pipePath is required');
  if (!handlers || [...COMMANDS].some((command) => typeof handlers[command] !== 'function')) {
    throw new TypeError('control handlers must implement status, say, interrupt, and shutdown');
  }
  if (!netImpl || typeof netImpl.createServer !== 'function') throw new TypeError('net implementation is required');
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) throw new TypeError('maxFrameBytes must be positive');
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw requestError('invalid_request');
  if (!COMMANDS.has(request.command)) throw requestError('unknown_command', 'Unknown control command');
  const params = request.params === undefined ? {} : request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw requestError('invalid_params');
  if (request.command === 'say') {
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw requestError('invalid_params', 'say requires text');
    return { id: request.id, command: request.command, params: { text } };
  }
  return { id: request.id, command: request.command, params: {} };
}

function respond(socket, response) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function failure(id, code, message) {
  return { id, ok: false, error: { code, message } };
}

function safeRequestId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(id) ? id : null;
}

function safeErrorCode(code) {
  return typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'control_error';
}

function requestError(code, message = 'Invalid control request') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function controlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
