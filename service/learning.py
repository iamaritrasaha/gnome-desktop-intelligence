"""Local opt-in metadata, private optional examples, bounded inspectable SQLite."""
import hashlib
import hmac
import json
import os
import secrets
from contextlib import contextmanager
import sqlite3
from gi.repository import GLib

WEIGHTS = {'accepted_unchanged': 3, 'accepted_edited': 1, 'dismissed': -1,
           'continued_typing': -.25, 'immediate_undo': -4}


class LearningStore:
    def __init__(self, path=None):
        self._path = path or os.path.join(GLib.get_user_data_dir(), 'gnome-desktop-intelligence', 'learning.sqlite3')

    @contextmanager
    def connect(self):
        os.makedirs(os.path.dirname(self._path), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(self._path), 0o700)
        db = sqlite3.connect(self._path, timeout=1)
        os.chmod(self._path, 0o600)
        db.executescript('''
          PRAGMA journal_mode=DELETE;
          PRAGMA user_version=3;
          CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL,
            action TEXT NOT NULL, signal TEXT NOT NULL, application TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outcomes (id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL,
            action TEXT NOT NULL, model TEXT NOT NULL, application TEXT NOT NULL,
            context_type TEXT NOT NULL, category TEXT NOT NULL, pattern TEXT NOT NULL,
            outcome TEXT NOT NULL, weight REAL NOT NULL, verbosity_delta INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS examples (id INTEGER PRIMARY KEY, outcome_id INTEGER NOT NULL,
            consent_version INTEGER NOT NULL, source TEXT NOT NULL, suggestion TEXT NOT NULL,
            final_text TEXT NOT NULL);
        ''')
        db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)', ('pattern_key', secrets.token_hex(32)))
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def record(self, action, signal, application):
        with self.connect() as db:
            db.execute('INSERT INTO signals(recorded_at,action,signal,application) VALUES(datetime("now"),?,?,?)',
                       (action[:64], signal[:64], application[:128]))
            db.execute('DELETE FROM signals WHERE id NOT IN (SELECT id FROM signals ORDER BY id DESC LIMIT 5000)')

    def pattern(self, category, before, after):
        with self.connect() as db:
            key = db.execute('SELECT value FROM metadata WHERE key="pattern_key"').fetchone()[0]
        return hmac.new(bytes.fromhex(key), (category + '\0' + before + '\0' + after).encode(), hashlib.sha256).hexdigest()

    def allows(self, application, pattern=None, category=None):
        if not os.path.exists(self._path):
            return True
        with self.connect() as db:
            if category:
                rows = db.execute('SELECT weight FROM outcomes WHERE application=? AND category=? ORDER BY id DESC LIMIT 12',
                                  (application, category)).fetchall()
                if len(rows) >= 6 and sum(r[0] for r in rows) <= -5:
                    return False
            if pattern:
                rows = db.execute('SELECT weight FROM outcomes WHERE pattern=? ORDER BY id DESC LIMIT 8', (pattern,)).fetchall()
                return not (len(rows) >= 3 and sum(r[0] for r in rows) <= -3)
            rows = db.execute('SELECT weight FROM outcomes WHERE application=? ORDER BY id DESC LIMIT 12', (application,)).fetchall()
            return not (len(rows) >= 8 and sum(r[0] for r in rows) <= -6)

    def outcome(self, data, outcome, final_text=None, retain=False):
        with self.connect() as db:
            result = db.execute('''INSERT INTO outcomes(recorded_at,action,model,application,context_type,
                 category,pattern,outcome,weight,verbosity_delta) VALUES(datetime('now'),?,?,?,?,?,?,?,?,?)''',
                ('passive', data['model'][:128], data['application'][:128], data['context_type'],
                 data['category'], data['pattern'], outcome, WEIGHTS[outcome],
                 len((final_text or data['replacement']).split()) - len(data['source'].split())))
            if retain and outcome == 'accepted_edited' and final_text is not None:
                db.execute('INSERT INTO examples(outcome_id,consent_version,source,suggestion,final_text) VALUES(?,1,?,?,?)',
                           (result.lastrowid, data['source'][:280], data['replacement'][:350], final_text[:350]))
            db.execute('DELETE FROM outcomes WHERE id NOT IN (SELECT id FROM outcomes ORDER BY id DESC LIMIT 5000)')
            db.execute('DELETE FROM examples WHERE outcome_id NOT IN (SELECT id FROM outcomes) OR id NOT IN (SELECT id FROM examples ORDER BY id DESC LIMIT 500)')

    def purge_examples(self):
        if os.path.exists(self._path):
            with self.connect() as db:
                db.execute('PRAGMA secure_delete=ON')
                db.execute('DELETE FROM examples')
            db = sqlite3.connect(self._path); db.execute('VACUUM'); db.close()

    def preferences(self, db):
        # Explicit tone/length choices are stronger evidence than guessing style
        # from private text. Keep them inspectable; passive proofreading never
        # changes tone or expands prose to satisfy a preference.
        rows = dict(db.execute('''SELECT action,sum(CASE signal WHEN 'accepted' THEN 1 WHEN 'immediate_undo' THEN -2 WHEN 'rejected' THEN -0.5 ELSE 0 END) FROM signals
            WHERE action IN ('professional','casual','concise','expand') GROUP BY action'''))
        def preferred(choices):
            ranked = sorted(((rows.get(choice, 0), choice) for choice in choices), reverse=True)
            return ranked[0][1] if ranked[0][0] >= 3 and ranked[0][0] > ranked[1][0] else 'preserve'
        return {'tone': preferred(('professional', 'casual')),
                'verbosity': preferred(('concise', 'expand'))}

    def stats(self):
        if not os.path.exists(self._path):
            return {'outcomes': {}, 'models': {}, 'examples': 0, 'preference': 'preserve wording'}
        with self.connect() as db:
            return {'outcomes': dict(db.execute('SELECT outcome,count(*) FROM outcomes GROUP BY outcome')),
                    'models': dict(db.execute('SELECT model,count(*) FROM outcomes GROUP BY model')),
                    'categories': {row[0]: {'count': row[1], 'score': row[2]} for row in db.execute('SELECT category,count(*),sum(weight) FROM outcomes GROUP BY category')},
                    'examples': db.execute('SELECT count(*) FROM examples').fetchone()[0],
                    'mean_accepted_word_delta': db.execute('SELECT avg(verbosity_delta) FROM outcomes WHERE weight>0').fetchone()[0],
                    'preferences': self.preferences(db),
                    'preference': 'preserve wording; suppress repeatedly rejected patterns'}

    def action_ranking(self, actions=('app.open', 'directory.open'), limit=20):
        """Accepted-launch counts per target for ranking only. Labels only —
        the query text and any file contents never reach this store."""
        if not os.path.exists(self._path):
            return {}
        ranking = {}
        with self.connect() as db:
            for action in actions:
                rows = db.execute(
                    '''SELECT application,count(*) c FROM signals
                       WHERE action=? AND signal='accepted'
                       GROUP BY application ORDER BY c DESC LIMIT ?''',
                    (action, limit)).fetchall()
                ranking[action] = {row[0]: row[1] for row in rows}
        return ranking

    def clear(self):
        try:
            for suffix in ('', '-journal', '-wal', '-shm'):
                try: os.remove(self._path + suffix)
                except FileNotFoundError: pass
            return True
        except OSError:
            return False
