/* Session D-Bus client for GDI's separately activated local service. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.DesktopIntelligence1';
const OBJECT_PATH = '/org/gnome/DesktopIntelligence1';
const INTERFACE = 'org.gnome.DesktopIntelligence1';

/* One reusable session connection for every call. Gio caches the session bus
 * internally, but resolving it per call still allocates callbacks and a
 * round-trip through the async queue for each request; a single cached
 * promise keeps launcher-side latency flat. The cache is dropped when the
 * connection itself fails, so a restarted or vanished service reconnects. */
let _sessionBus = null;

function sessionBus() {
  if (!_sessionBus) {
    _sessionBus = new Promise((resolve, reject) => {
      Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
        try {
          resolve(Gio.bus_get_finish(result));
        } catch (error) {
          _sessionBus = null;
          reject(error);
        }
      });
    });
  }
  return _sessionBus;
}

function connectionLost(error) {
  return error instanceof Gio.IOErrorEnum &&
    [Gio.IOErrorEnum.CLOSED, Gio.IOErrorEnum.CANCELLED].includes(error.code);
}

function call(method, signature, args, timeout, callback, flags = Gio.DBusCallFlags.NONE, retried = false) {
  sessionBus().then(connection => {
    connection.call(
      BUS_NAME,
      OBJECT_PATH,
      INTERFACE,
      method,
      new GLib.Variant(signature, args),
      null,
      flags,
      timeout,
      null,
      (bus, reply) => {
        let value;
        try {
          value = bus.call_finish(reply).deep_unpack();
        } catch (error) {
          // A closed/lost connection is re-established once; caller-level
          // errors (service missing, cancelled) surface unchanged.
          if (!retried && connectionLost(error)) {
            _sessionBus = null;
            call(method, signature, args, timeout, callback, flags, true);
            return;
          }
          callback(null, error);
          return;
        }
        callback(value, null);
      },
    );
  }, error => callback(null, error));
}

function callAsync(method, signature, args, timeout, flags = Gio.DBusCallFlags.NONE) {
  return new Promise((resolve, reject) => {
    call(method, signature, args, timeout, (reply, error) => {
      if (error) reject(error);
      else resolve(reply);
    }, flags);
  });
}

export function captureFocusedContext(pid, callback) {
  call('GetFocusedContext', '(i)', [pid], 3000, callback);
}

/* Explicit no-selection capture: the bounded sentence or paragraph at the
 * caret in a supported field, captured only when the user picks an action. */
export function captureCaretContext(pid, kind, callback) {
  call('GetCaretContext', '(is)', [pid, kind], 4000, callback);
}

/* Clipboard Intelligence: the Shell reads the clipboard through St and
 * registers the text as a bounded service-side context only when the user
 * explicitly chooses a clipboard action. The service never reads the
 * clipboard itself and never logs or persists the text. */
export function setClipboardContext(text, callback) {
  call('SetClipboardContext', '(s)', [text], 4000, callback);
}

export function transform(request, callback) {
  call('Transform', '(sssssssssssiii)', [
    request.token,
    request.action,
    request.selected,
    request.nearby,
    request.question,
    request.provider,
    request.endpoint,
    request.quickModel,
    request.intentModel,
    request.assistantModel,
    request.reasoningModel,
    request.timeout,
    request.contextTokens,
    request.outputTokens,
  ], (request.timeout + 10) * 1000, callback);
}

export function providerStatus(provider, endpoint, callback) {
  call('ProviderStatus', '(ss)', [provider, endpoint], 8000, (reply, error) => {
    if (error) {
      callback(null, error);
      return;
    }
    try {
      callback(JSON.parse(reply[0]), null);
    } catch (parseError) {
      callback(null, parseError);
    }
  });
}

export function releaseContext(token) {
  if (token)
    call('ReleaseContext', '(s)', [token], 3000, () => {});
}

export function cancelTransform(token) {
  call('CancelTransform', '(s)', [token], 3000, () => {});
}

export function replaceSelection(token, replacement, learningEnabled, callback) {
  call('Replace', '(ssb)', [token, replacement, learningEnabled], 10000, callback);
}

export function undoReplacement(token, callback) {
  call('Undo', '(s)', [token], 10000, callback);
}

export function recordSignal(token, action, signal, learningEnabled) {
  if (!learningEnabled)
    return;
  call('RecordSignal', '(sssb)', [token, action, signal, learningEnabled], 5000, () => {});
}

export function clearLearning(callback) {
  call('ClearLearning', '()', [], 5000, callback);
}

/* Intelligence history: local conversations owned by the service. Writes are
 * no-ops at the service while save-intelligence-history is disabled. */
export function historyStart(model) {
  return callAsync('HistoryStart', '(s)', [model ?? ''], 5000).then(reply => reply[0]);
}

export function historyAdd(conversationId, role, content) {
  return callAsync('HistoryAdd', '(sss)', [conversationId, role, content], 5000);
}

export function historyTrim(conversationId, role) {
  return callAsync('HistoryTrim', '(ss)', [conversationId, role], 5000);
}

export function historyList() {
  return callAsync('HistoryList', '()', [], 5000).then(reply => JSON.parse(reply[0]));
}

export function historyGet(conversationId) {
  return callAsync('HistoryGet', '(s)', [conversationId], 5000).then(reply => JSON.parse(reply[0]));
}

export function historyRename(conversationId, title) {
  return callAsync('HistoryRename', '(ss)', [conversationId, title], 5000);
}

export function historyDelete(conversationId) {
  return callAsync('HistoryDelete', '(s)', [conversationId], 5000);
}

export function historyClear(callback) {
  call('HistoryClear', '()', [], 5000, callback);
}

export function errorMessage(error) {
  const message = String(error?.message ?? error ?? 'GDI could not complete that request.');
  const remotePrefix = `${INTERFACE}.Error.`;
  const remoteIndex = message.indexOf(remotePrefix);
  if (remoteIndex >= 0) {
    const colon = message.indexOf(':', remoteIndex);
    if (colon >= 0)
      return message.slice(colon + 1).trim();
  }
  return 'Intelligence is unavailable. Retry or check AI Settings.';
}

export function learningStats(callback) {
  call('LearningStats', '()', [], 5000, (reply, error) => {
    if (error) { callback(null, error); return; }
    try { callback(JSON.parse(reply[0]), null); } catch (e) { callback(null, e); }
  });
}

export function purgeLearningExamples() { call('PurgeLearningExamples', '()', [], 5000, () => {}); }

/* Phase 4 native actions: the routing model lives in the service; diagnostics
 * and learning signals mirror there with NO_AUTO_START so executing a system
 * action never activates the intelligence service. */
export function routeAction(question, registry, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    call('RouteAction', '(ss)', [question, registry], (timeoutSeconds + 5) * 1000,
      (reply, error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(reply);
      });
  });
}

export function recordActionDiagnostic(record) {
  call('RecordActionDiagnostic', '(s)', [record], 3000, () => {},
    Gio.DBusCallFlags.NO_AUTO_START);
}

export function recordActionUse(action, target) {
  call('RecordActionUse', '(ss)', [action, target], 3000, () => {},
    Gio.DBusCallFlags.NO_AUTO_START);
}

export function actionStats(callback) {
  call('ActionStats', '()', [], 5000, (reply, error) => {
    if (error) { callback(null, error); return; }
    try { callback(JSON.parse(reply[0]), null); } catch (e) { callback(null, e); }
  });
}

/* Developer-only: clears the service's mirrored action diagnostic records. */
export function resetActionDiagnostics() {
  call('ResetActionStats', '()', [], 3000, () => {}, Gio.DBusCallFlags.NO_AUTO_START);
}

/* Ask-mode prewarming: begins loading the assistant model while the user
 * types their question. Never called for the plain launcher, calculator or
 * app launches, so those never touch Ollama. */
export function prewarmModel(role) {
  call('PrewarmModel', '(s)', [role], 5000, () => {});
}

/* Developer diagnostics: model residency state and latency observations. */
export function residencyStatus(callback) {
  call('ResidencyStatus', '()', [], 5000, (reply, error) => {
    if (error) {
      callback(null, error);
      return;
    }
    try {
      callback(JSON.parse(reply[0]), null);
    } catch (parseError) {
      callback(null, parseError);
    }
  }, Gio.DBusCallFlags.NO_AUTO_START);
}

/* Bounded RAM-only request records; used by the stress regression to prove
 * cancellation leaves no stuck requests behind. */
export function requestStats() {
  return callAsync('RequestStats', '()', [], 5000).then(reply => JSON.parse(reply[0]));
}


// Subscribe before dispatch; every terminal path removes the directed signal listener.
export function streamTransform(request, onChunk, callback) {
  let disposed = false, bus = null, subscription = 0;
  const requestId = GLib.uuid_string_random();
  const dispose = () => {
    disposed = true;
    if (subscription) bus.signal_unsubscribe(subscription);
    subscription = 0;
  };
  sessionBus().then(connected => {
    if (disposed) return;
    bus = connected;
    subscription = bus.signal_subscribe(BUS_NAME, INTERFACE, 'ResponseChunk', OBJECT_PATH,
      request.token, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
        const [token, id, delta] = params.deep_unpack();
        if (!disposed && token === request.token && id === requestId) onChunk(delta);
      });
    bus.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'TransformStream', new GLib.Variant('(sssssssssssiiisss)', [request.token, request.action,
      request.selected, request.nearby, request.question, request.provider, request.endpoint,
      request.quickModel, request.intentModel, request.assistantModel, request.reasoningModel,
      request.timeout, request.contextTokens, request.outputTokens, requestId,
      JSON.stringify(request.history ?? []), request.conversationId ?? '']), null, Gio.DBusCallFlags.NONE, (request.timeout + 10) * 1000, null, (connection, result) => {
        if (disposed) return;
        dispose();
        let reply;
        try { reply = connection.call_finish(result).deep_unpack(); }
        catch (error) { callback(null, error); return; }
        callback(reply, null);
      });
  }, error => {
    if (!disposed) callback(null, error);
  });
  return () => {
    if (disposed) return;
    if (subscription) bus.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'CancelRequest',
      new GLib.Variant('(ss)', [request.token, requestId]), null, Gio.DBusCallFlags.NONE,
      3000, null, (connection, result) => { try { connection.call_finish(result); } catch { /* Already gone. */ } });
    dispose();
  };
}
