/* Session D-Bus client for GDI's separately activated local service. */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.gnome.DesktopIntelligence1';
const OBJECT_PATH = '/org/gnome/DesktopIntelligence1';
const INTERFACE = 'org.gnome.DesktopIntelligence1';

function call(method, signature, args, timeout, callback, flags = Gio.DBusCallFlags.NONE) {
  Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
    let connection;
    try {
      connection = Gio.bus_get_finish(result);
    } catch (error) {
      callback(null, error);
      return;
    }

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
          callback(null, error);
          return;
        }
        callback(value, null);
      },
    );
  });
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

export function acceptPrediction(token, words, callback) {
  call('AcceptPrediction', '(si)', [token, words], 5000, callback);
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


// Subscribe before dispatch; every terminal path removes the directed signal listener.
export function streamTransform(request, onChunk, callback) {
  let disposed = false, bus = null, subscription = 0;
  const requestId = GLib.uuid_string_random();
  const dispose = () => {
    disposed = true;
    if (subscription) bus.signal_unsubscribe(subscription);
    subscription = 0;
  };
  Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
    try { bus = Gio.bus_get_finish(result); } catch (error) { if (!disposed) callback(null, error); return; }
    if (disposed) return;
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
  });
  return () => {
    if (disposed) return;
    if (subscription) bus.call(BUS_NAME, OBJECT_PATH, INTERFACE, 'CancelRequest',
      new GLib.Variant('(ss)', [request.token, requestId]), null, Gio.DBusCallFlags.NONE,
      3000, null, (connection, result) => { try { connection.call_finish(result); } catch { /* Already gone. */ } });
    dispose();
  };
}
