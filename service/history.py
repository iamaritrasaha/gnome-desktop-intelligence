"""Local Ask Intelligence conversation history.

Entirely local SQLite storage for conversations the user had with Ask
Intelligence. Only user-visible conversation content and minimal metadata are
stored: no internal prompts, no routing metadata, no hidden reasoning, and no
model-provider diagnostics inside message content. Writes happen only while
the save-intelligence-history setting is enabled; existing history is never
deleted implicitly (clearing is an explicit user action).
"""

import os
import secrets
import sqlite3
import time
from contextlib import contextmanager

from gi.repository import GLib

MAX_MESSAGE_CHARS = 20000
MAX_TITLE_CHARS = 60
MAX_PREVIEW_CHARS = 140
KEEP_CONVERSATIONS = 200


class HistoryStore:
    def __init__(self, path=None):
        self._path = path or os.path.join(
            GLib.get_user_data_dir(), 'gnome-desktop-intelligence', 'history.sqlite3')

    @contextmanager
    def connect(self):
        os.makedirs(os.path.dirname(self._path), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(self._path), 0o700)
        db = sqlite3.connect(self._path, timeout=1)
        os.chmod(self._path, 0o600)
        db.executescript('''
          PRAGMA journal_mode=DELETE;
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            model TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS messages_conversation
            ON messages(conversation_id, id);
        ''')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def start_conversation(self, model=''):
        """Create a conversation row. Returns '' when storage fails; the
        caller treats '' as 'not persisted'."""
        conversation_id = secrets.token_urlsafe(12)
        try:
            with self.connect() as db:
                now = int(time.time())
                db.execute('INSERT INTO conversations(id,title,created_at,updated_at,model) VALUES(?,?,?,?,?)',
                           (conversation_id, '', now, now, (model or '')[:128]))
                self._housekeep(db)
            return conversation_id
        except sqlite3.Error:
            return ''

    def add_message(self, conversation_id, role, content):
        """Append a user-visible turn. The first user message also becomes the
        automatic title. Returns True when the message was stored."""
        if role not in ('user', 'assistant') or not conversation_id:
            return False
        text = (content or '')[:MAX_MESSAGE_CHARS]
        if not text.strip():
            return False
        try:
            with self.connect() as db:
                if not db.execute('SELECT 1 FROM conversations WHERE id=?',
                                  (conversation_id,)).fetchone():
                    return False
                now = int(time.time())
                first_user = db.execute(
                    'SELECT 1 FROM messages WHERE conversation_id=? AND role="user" LIMIT 1',
                    (conversation_id,)).fetchone() is None
                db.execute('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)',
                           (conversation_id, role, text, now))
                db.execute('UPDATE conversations SET updated_at=? WHERE id=?',
                           (now, conversation_id))
                if role == 'user' and first_user:
                    db.execute('UPDATE conversations SET title=? WHERE id=? AND title=""',
                               (_title_from(text), conversation_id))
            return True
        except sqlite3.Error:
            return False

    def trim(self, conversation_id, role):
        """Drop trailing messages with the given role (a retried answer)."""
        if role not in ('user', 'assistant') or not conversation_id:
            return
        try:
            with self.connect() as db:
                while True:
                    row = db.execute('SELECT id,role FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1',
                                     (conversation_id,)).fetchone()
                    if not row or row[1] != role:
                        break
                    db.execute('DELETE FROM messages WHERE id=?', (row[0],))
        except sqlite3.Error:
            pass

    def list_conversations(self, limit=100):
        """Newest first, conversations with at least one message only."""
        try:
            with self.connect() as db:
                rows = db.execute('''
                  SELECT c.id,c.title,c.updated_at,
                    (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.role='user'
                     ORDER BY m.id LIMIT 1),
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id)
                  FROM conversations c
                  WHERE EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id)
                  ORDER BY c.updated_at DESC LIMIT ?''', (int(limit),)).fetchall()
            return [{'id': row[0], 'title': row[1] or 'Conversation',
                     'updatedAt': row[2],
                     'preview': (row[3] or '')[:MAX_PREVIEW_CHARS],
                     'messageCount': row[4]} for row in rows]
        except sqlite3.Error:
            return []

    def get_conversation(self, conversation_id):
        try:
            with self.connect() as db:
                row = db.execute('SELECT id,title,created_at,updated_at FROM conversations WHERE id=?',
                                 (conversation_id,)).fetchone()
                if not row:
                    return None
                messages = db.execute('SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id',
                                      (conversation_id,)).fetchall()
            return {'id': row[0], 'title': row[1] or 'Conversation',
                    'createdAt': row[2], 'updatedAt': row[3],
                    'messages': [{'role': m[0], 'content': m[1]} for m in messages]}
        except sqlite3.Error:
            return None

    def rename(self, conversation_id, title):
        title = ' '.join((title or '').split())[:MAX_TITLE_CHARS]
        if not title or not conversation_id:
            return
        try:
            with self.connect() as db:
                db.execute('UPDATE conversations SET title=? WHERE id=?', (title, conversation_id))
        except sqlite3.Error:
            pass

    def delete(self, conversation_id):
        if not conversation_id:
            return False
        try:
            with self.connect() as db:
                db.execute('PRAGMA secure_delete=ON')
                db.execute('DELETE FROM messages WHERE conversation_id=?', (conversation_id,))
                db.execute('DELETE FROM conversations WHERE id=?', (conversation_id,))
            return True
        except sqlite3.Error:
            return False

    def clear(self):
        """Remove every stored conversation; returns True on success."""
        try:
            for suffix in ('', '-journal', '-wal', '-shm'):
                try:
                    os.remove(self._path + suffix)
                except FileNotFoundError:
                    pass
            return True
        except OSError:
            return False

    def _housekeep(self, db):
        """Bound storage: drop messageless rows older than an hour and the
        oldest conversations beyond KEEP_CONVERSATIONS."""
        now = int(time.time())
        db.execute('''DELETE FROM conversations WHERE updated_at < ? AND
                      NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=conversations.id)''',
                   (now - 3600,))
        db.execute('''DELETE FROM messages WHERE conversation_id IN (
                      SELECT id FROM conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?)''',
                   (KEEP_CONVERSATIONS,))
        db.execute('''DELETE FROM conversations WHERE id IN (
                      SELECT id FROM conversations ORDER BY updated_at DESC LIMIT -1 OFFSET ?)''',
                   (KEEP_CONVERSATIONS,))


def _title_from(text):
    title = ' '.join(text.split())
    return title[:MAX_TITLE_CHARS].rstrip(' \t-,;:')
