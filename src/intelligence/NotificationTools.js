/* Notification Intelligence structure: pure, node-testable data and rules.
 * The palette renders the surface and owns every GJS message-tray read;
 * nothing here touches GObject/St/Main.
 *
 * Privacy model: notifications are read from GNOME Shell's message tray only
 * while the Notification Intelligence surface is open or a notifications
 * command runs — never in the background, never monitored, never stored.
 * Detected-sensitive content is excluded entirely. What an explicit
 * summarize/ask action sends is one bounded digest of the currently listed
 * notifications, registered as an ordinary RAM-only service context with the
 * same lifetime as a selection snapshot. */

export const NOTIFICATION_MAX_ITEMS = 30;
export const NOTIFICATION_MAX_CHARS = 12000;
export const NOTIFICATION_LIST_PREVIEW_CHARS = 120;
export const NOTIFICATION_DIGEST_PREVIEW_CHARS = 200;
export const NOTIFICATION_TITLE_CHARS = 100;

/* Typed launcher commands. `notifications` opens the surface;
 * `summarize notifications` proposes the explicit AI action;
 * `ask notifications` asks for the question first, `ask notifications
 * <question>` proposes Ask with the current notifications as context.
 * Anything else is not a notifications command (null) and keeps ordinary
 * launcher routing. Command words are routing metadata and case-insensitive;
 * the question remainder keeps the user's original casing. */
export function notificationsCommandFor(query) {
  const raw = String(query ?? '').trim()
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ');
  const normalized = raw.toLowerCase();
  if (normalized === 'notifications')
    return {kind: 'surface'};
  if (normalized === 'summarize notifications')
    return {kind: 'action', actionKey: 'summarize'};
  const ask = raw.match(/^ask notifications(?:\s+(.+))?$/i);
  if (ask)
    return {kind: 'action', actionKey: 'ask', question: (ask[1] ?? '').trim()};
  return null;
}

/* Conservative secret/OTP detection: only obvious, explicit evidence hides a
 * notification. Misses are possible by design (this is not a secret scanner);
 * false positives only cost a notification GDI does not show or send. */
const SENSITIVE_PATTERNS = [
  /\b(?:otp|one[-\s]?time\s+(?:code|password|pin)|verification\s+code|security\s+code|authentication\s+code|auth(?:entication)?\s+code|login\s+code|confirmation\s+code|reset\s+code|access\s+code|passcode|two[-\s]?factor\s+code|2fa\s+code)\b/i,
  /\b(?:password|passwd|passphrase|api[-\s]?key|private\s+key|secret\s+key)\b/i,
];

export function isSensitiveNotificationText(...parts) {
  const text = parts.filter(part => typeof part === 'string' && part).join(' ');
  if (!text)
    return false;
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(text));
}

/* Classify the currently listed notifications without retaining anything:
 * newest first, obvious secrets excluded, bounded to the digest budget.
 * Snapshots are plain objects {appName, title, body, epoch, refIndex} that
 * the palette extracted from the tray. */
export function assessNotifications(snapshots, {now = Date.now() / 1000} = {}) {
  const usable = [];
  let hiddenSensitive = 0;
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    if (!snapshot || typeof snapshot !== 'object')
      continue;
    if (isSensitiveNotificationText(snapshot.title, snapshot.body)) {
      hiddenSensitive += 1;
      continue;
    }
    usable.push(snapshot);
  }
  usable.sort((a, b) => (Number(b.epoch ?? 0) || 0) - (Number(a.epoch ?? 0) || 0));
  return {items: usable.slice(0, NOTIFICATION_MAX_ITEMS), hiddenSensitive, total: usable.length};
}

/* Compact "3m" / "14:32" style relative label for the result-row slot. The
 * palette translates the two word tokens; everything else is numeric. */
export function formatNotificationTime(epoch, now = Date.now() / 1000) {
  const seconds = Number(epoch ?? 0) || 0;
  if (!seconds)
    return '';
  const diff = now - seconds;
  if (diff < 90)
    return 'now';
  if (diff < 3600)
    return `${Math.max(1, Math.floor(diff / 60))}m`;
  const then = new Date(seconds * 1000);
  const reference = new Date(now * 1000);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(then, reference)) {
    return `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(reference);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(then, yesterday))
    return 'Yesterday';
  if (then.getFullYear() === reference.getFullYear())
    return `${then.getMonth() + 1}/${then.getDate()}`;
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()}`;
}

/* Row presentation data: app/source, title, short body preview, timestamp.
 * A missing title falls back to the app name so every row has a headline. */
export function notificationRowData(snapshot, {now = Date.now() / 1000} = {}) {
  const appName = String(snapshot?.appName ?? '').trim();
  const title = String(snapshot?.title ?? '').replace(/\s+/g, ' ').trim();
  const preview = String(snapshot?.body ?? '').replace(/\s+/g, ' ').trim();
  const headline = title || appName;
  const body = preview.slice(0, NOTIFICATION_LIST_PREVIEW_CHARS) +
    (preview.length > NOTIFICATION_LIST_PREVIEW_CHARS ? '…' : '');
  const description = [headline === appName ? '' : appName, body]
    .filter(Boolean).join(' — ');
  return {title: headline, description, timeLabel: formatNotificationTime(snapshot?.epoch, now)};
}

/* Bounded model context for the explicit summarize/ask actions: the currently
 * listed notifications only, newest first, repeated same-app/same-title runs
 * grouped. Never includes excluded-sensitive content and never exceeds the
 * selection-size budget. */
export function buildNotificationDigest(items, {now = Date.now() / 1000} = {}) {
  const source = Array.isArray(items) ? items : [];
  const clipped = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const groups = [];
  for (const item of source) {
    const appName = clipped(item?.appName).slice(0, NOTIFICATION_TITLE_CHARS);
    const title = clipped(item?.title).slice(0, NOTIFICATION_TITLE_CHARS);
    const key = `${appName}\u0000${title.toLowerCase()}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      continue;
    }
    groups.push({key, appName, title, body: clipped(item?.body), count: 1});
  }
  const render = () => groups.map(group => {
    const title = group.title || '(no title)';
    const body = group.body.slice(0, NOTIFICATION_DIGEST_PREVIEW_CHARS) +
      (group.body.length > NOTIFICATION_DIGEST_PREVIEW_CHARS ? '…' : '');
    const repeated = group.count > 1 ? ` (×${group.count})` : '';
    return `- [${group.appName}] ${title} — ${body}${repeated}`;
  });
  let shown = [];
  let text = '';
  const header = count => {
    const appCount = new Set(groups.slice(0, count).map(g => g.appName || 'Unknown')).size;
    const included = groups.slice(0, count).reduce((n, group) => n + group.count, 0);
    const scope = included < source.length
      ? `showing ${included} of ${source.length} from ${appCount}`
      : `${included} from ${appCount}`;
    return `Current GNOME notifications (${scope} ` +
      `${appCount === 1 ? 'application' : 'applications'}, newest first):`;
  };
  // Bound the digest to the selection-size budget by dropping the oldest
  // groups first; the header states the honest included count.
  for (let count = groups.length; count > 0; count--) {
    shown = groups.slice(0, count);
    text = [header(count), ...render().slice(0, count)].join('\n');
    if (text.length <= NOTIFICATION_MAX_CHARS)
      break;
  }
  const shownCount = shown.reduce((n, group) => n + group.count, 0);
  const lines = [text];
  if (groups.length > 0 && source.length > shownCount)
    lines.push('Some older notifications were left out of this digest.');
  return {text: lines.filter(Boolean).join('\n'), included: shownCount};
}

/* Capability snapshot for a notifications context: readable and never
 * replaceable — GDI cannot modify the application that raised the
 * notification, so results are read/copy only. */
export function notificationCapabilities() {
  return {
    hasField: false,
    application: 'Notifications',
    role: 'notifications',
    canReadText: true,
    canReadSelection: true,
    canGetCaret: false,
    canReplaceSelection: false,
    canInsertText: false,
    canObserveTyping: false,
    canPassiveAssist: false,
    canReadCaretContext: false,
    reason: 'not-editable',
  };
}
