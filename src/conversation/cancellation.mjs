export function createCancellationManager({ AbortControllerImpl = AbortController } = {}) {
  if (typeof AbortControllerImpl !== 'function') throw new TypeError('AbortController implementation is required');

  let current;

  return { begin, cancel, current: () => current, isCurrent, guard };

  function begin({ turnId, generationId }) {
    validateIdentity(turnId, 'turnId');
    validateIdentity(generationId, 'generationId');
    cancel('superseded');
    const controller = new AbortControllerImpl();
    current = { turnId, generationId, controller, signal: controller.signal };
    return current;
  }

  function cancel(reason = 'cancelled') {
    if (!current || current.signal.aborted) return false;
    current.controller.abort(reason);
    return true;
  }

  function isCurrent(scope) {
    return Boolean(scope)
      && current === scope
      && !scope.signal.aborted;
  }

  function guard(scope, callback) {
    if (!isCurrent(scope)) return undefined;
    return callback();
  }
}

function validateIdentity(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
}
