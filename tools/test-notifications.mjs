import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/intelligence/NotificationTools.js', import.meta.url), 'utf8');
const {NOTIFICATION_MAX_ITEMS, NOTIFICATION_MAX_CHARS, notificationsCommandFor,
  isSensitiveNotificationText, assessNotifications, notificationRowData,
  buildNotificationDigest, formatNotificationTime, notificationCapabilities} =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

/* Command parsing: the required launcher commands, case-insensitive, with the
 * same normalization rules as the clipboard and action parsers. */
assert.deepEqual(notificationsCommandFor('notifications'), {kind: 'surface'});
assert.deepEqual(notificationsCommandFor('  Notifications '), {kind: 'surface'});
assert.deepEqual(notificationsCommandFor('NOTIFICATIONS'), {kind: 'surface'});
assert.deepEqual(notificationsCommandFor('notifications?'), {kind: 'surface'});

assert.deepEqual(notificationsCommandFor('summarize notifications'),
  {kind: 'action', actionKey: 'summarize'});
assert.deepEqual(notificationsCommandFor('Summarize   notifications'),
  {kind: 'action', actionKey: 'summarize'});
assert.deepEqual(notificationsCommandFor('summarize notifications.'),
  {kind: 'action', actionKey: 'summarize'});

assert.deepEqual(notificationsCommandFor('ask notifications'),
  {kind: 'action', actionKey: 'ask', question: ''});
assert.deepEqual(notificationsCommandFor('ask notifications what did I miss'),
  {kind: 'action', actionKey: 'ask', question: 'what did I miss'});
// The question is user content: only the command words are routing metadata.
assert.deepEqual(notificationsCommandFor('  ASK   NOTIFICATIONS   EchoFixture:MixedCase7? '),
  {kind: 'action', actionKey: 'ask', question: 'EchoFixture:MixedCase7'});

/* Non-commands keep ordinary launcher routing. */
for (const query of [
  'show notifications', 'notifications settings', 'notification', 'summarize notification',
  'summarize', 'summarize notifications now', 'ask notification', 'ask',
  'ask why', 'clear notifications', 'open notifications', '', null, undefined,
]) {
  assert.equal(notificationsCommandFor(query), null, JSON.stringify(query));
}

/* Conservative secret/OTP gate: obvious evidence hides; ordinary prose and
 * numbers never do. Missing some content is accepted; this is not a secret
 * scanner. */
for (const text of [
  'Your verification code is 555123',
  'Verification code: 123456',
  'OTP 881199',
  'One-time password: 7733',
  'Your login code is 4455',
  'Use password hunter2 to sign in',
  'Password expiry in 3 days',
  'Reset your passphrase here',
  'API key rotated',
  'Your 2FA code is 991',
]) {
  assert.equal(isSensitiveNotificationText(text), true, text);
}
assert.equal(isSensitiveNotificationText('Meeting at 4', 'Bring the weekly report'), false);
assert.equal(isSensitiveNotificationText('Build passed', 'All 214 checks succeeded'), false);
assert.equal(isSensitiveNotificationText('Your order has shipped'), false);
assert.equal(isSensitiveNotificationText('Disk space low', '3% remaining on /'), false);
assert.equal(isSensitiveNotificationText('', '', null, undefined), false);
assert.equal(isSensitiveNotificationText('Weekly report', 'Password reset completed'), true);

/* Assessment: newest first, bounded, sensitive excluded with a count. */
const NOW = 1_800_000_000;
const snap = (refIndex, appName, title, body, epoch) =>
  ({refIndex, appName, title, body, epoch});
const assessed = assessNotifications([
  snap(0, 'Mailer', 'Weekly report', 'Summary ready', NOW - 60),
  snap(1, 'Secrets', 'Sign in', 'Your verification code is 555123', NOW - 30),
  snap(2, 'CI', 'Build passed', 'Green', NOW - 10),
  null, 'junk',
], {now: NOW});
assert.deepEqual(assessed.items.map(item => item.refIndex), [2, 0]);
assert.equal(assessed.total, 2);
assert.equal(assessed.hiddenSensitive, 1);

// The bound keeps the newest; the honest total is preserved.
const many = Array.from({length: NOTIFICATION_MAX_ITEMS + 7}, (_, index) =>
  snap(index, 'App', `Note ${index}`, 'body', NOW - index));
const capped = assessNotifications(many, {now: NOW});
assert.equal(capped.items.length, NOTIFICATION_MAX_ITEMS);
assert.equal(capped.total, NOTIFICATION_MAX_ITEMS + 7);
assert.equal(capped.items[0].refIndex, 0);
assert.equal(NOTIFICATION_MAX_ITEMS, 30);

/* Row data: app/source, title, short preview, timestamp; title falls back to
 * the app name; the app name is not duplicated. */
const row = notificationRowData(
  snap(0, 'Mailer', 'Weekly report', 'Your weekly summary is ready to review.', NOW - 120),
  {now: NOW});
assert.equal(row.title, 'Weekly report');
assert.equal(row.description, 'Mailer — Your weekly summary is ready to review.');
assert.equal(row.timeLabel, '2m');

const noTitle = notificationRowData(snap(1, 'System', '', 'Update available', NOW - 30), {now: NOW});
assert.equal(noTitle.title, 'System');
assert.equal(noTitle.description, 'Update available');

// Long bodies preview truncated with an ellipsis; whitespace collapses.
const longBody = 'x'.repeat(300);
const longRow = notificationRowData(snap(2, 'App', 'Title', `  a\n  ${longBody}  `, NOW), {now: NOW});
assert.ok(longRow.description.startsWith('App — a x'));
assert.ok(longRow.description.endsWith('…'));
assert.ok(longRow.description.length < 160);

// With a title but no body, the required app/source still shows.
assert.equal(notificationRowData(snap(3, 'App', 'Title', '', NOW), {now: NOW}).description, 'App');

/* Time formatting tokens. */
assert.equal(formatNotificationTime(0, NOW), '');
assert.equal(formatNotificationTime(NOW, NOW), 'now');
assert.equal(formatNotificationTime(NOW - 89, NOW), 'now');
assert.equal(formatNotificationTime(NOW - 90, NOW), '1m');
assert.equal(formatNotificationTime(NOW - 3599, NOW), '59m');
const hour = formatNotificationTime(NOW - 7200, NOW);
assert.match(hour, /^\d{2}:\d{2}$/);
// Yesterday and older calendar dates.
const base = new Date(NOW * 1000);
const noon = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0);
const noonEpoch = Math.floor(noon.getTime() / 1000);
assert.ok(/^\d{2}:\d{2}$/.test(formatNotificationTime(noonEpoch, noonEpoch + 3600)));
assert.equal(formatNotificationTime(noonEpoch - 86400, noonEpoch + 3600), 'Yesterday');
const older = formatNotificationTime(noonEpoch - 86400 * 6, noonEpoch + 3600);
assert.match(older, /^\d{1,2}\/\d{1,2}$/);
const lastYear = formatNotificationTime(
  Math.floor(new Date(base.getFullYear() - 1, 0, 5).getTime() / 1000), NOW);
assert.equal(lastYear, `${base.getFullYear() - 1}/1/5`);

/* Digest: header counts, newest-first ordering, repeated same-app/same-title
 * grouping, sensitive content already excluded upstream. */
const digestItems = [
  snap(0, 'CI', 'Build passed', 'All checks succeeded', NOW - 5),
  snap(1, 'CI', 'Build passed', 'Flaky test retried', NOW - 65),
  snap(2, 'CI', 'Build passed', 'Green again', NOW - 125),
  snap(3, 'Mailer', 'Weekly report', 'Your weekly summary is ready to review.', NOW - 300),
];
const digest = buildNotificationDigest(digestItems, {now: NOW});
assert.ok(digest.text.startsWith('Current GNOME notifications (4 from 2 applications, newest first):'));
assert.ok(digest.text.includes('- [CI] Build passed — All checks succeeded (×3)'));
assert.ok(digest.text.includes('- [Mailer] Weekly report — Your weekly summary is ready to review.'));
assert.equal(digest.included, 4);
assert.ok(!digest.text.includes('×1'));
// The newest body of a grouped run is shown once, not the merged three.
assert.equal((digest.text.match(/Build passed —/g) ?? []).length, 1);

// Different titles from one app are not grouped.
const mixed = buildNotificationDigest([
  snap(0, 'CI', 'Build passed', 'ok', NOW - 5),
  snap(1, 'CI', 'Build failed', 'one test red', NOW - 65),
], {now: NOW});
assert.ok(mixed.text.includes('- [CI] Build passed — ok'));
assert.ok(mixed.text.includes('- [CI] Build failed — one test red'));

// Long bodies are clipped per notification, never dropped silently.
const longDigest = buildNotificationDigest(
  [snap(0, 'App', 'Title', 'y'.repeat(4000), NOW)], {now: NOW});
assert.ok(longDigest.text.length < 500);
assert.ok(longDigest.text.endsWith('…'));
assert.equal(longDigest.included, 1);

// The total digest respects the selection-size budget: with 200-char body
// clipping, the 30-item maximum always fits inside 12,000 characters; the
// drop-oldest-groups guard exists for constant changes and reports honestly
// if it ever fires.
const huge = Array.from({length: 30}, (_, index) =>
  snap(index, 'App', `Note ${index}`, 'z'.repeat(700), NOW - index));
const hugeDigest = buildNotificationDigest(huge, {now: NOW});
assert.ok(hugeDigest.text.length <= NOTIFICATION_MAX_CHARS);
assert.equal(NOTIFICATION_MAX_CHARS, 12000);
assert.equal(hugeDigest.included, 30);
assert.ok(!hugeDigest.text.includes('left out of this digest'));

// Empty input produces an empty digest; the caller shows the empty state.
assert.deepEqual(buildNotificationDigest([], {now: NOW}), {text: '', included: 0});
assert.deepEqual(buildNotificationDigest(null, {now: NOW}), {text: '', included: 0});

/* Capabilities: notification content is readable and never replaceable. */
const caps = notificationCapabilities();
assert.equal(caps.canReadSelection, true);
assert.equal(caps.canReplaceSelection, false);
assert.equal(caps.canInsertText, false);
assert.equal(caps.canObserveTyping, false);
assert.equal(caps.hasField, false);
assert.equal(caps.application, 'Notifications');
assert.equal(caps.role, 'notifications');

console.log('test-notifications: PASS');
