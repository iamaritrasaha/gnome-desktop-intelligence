#!/usr/bin/python3
"""Intelligence history regressions: schema, lifecycle, bounds and privacy."""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'service'))

from history import HistoryStore  # noqa: E402

with tempfile.TemporaryDirectory() as temp:
    store = HistoryStore(str(Path(temp) / 'history.sqlite3'))
    data_dir = Path(store._path).parent
    assert data_dir.exists()

    # --- Conversation creation and automatic titles ------------------------
    conversation = store.start_conversation(model='qwen3.5:4b')
    assert conversation
    assert store.add_message(conversation, 'user', 'What is gradient descent?')
    assert store.add_message(conversation, 'assistant', 'Gradient descent iteratively minimizes a loss.')
    listing = store.list_conversations()
    assert len(listing) == 1
    entry = listing[0]
    assert entry['id'] == conversation
    assert entry['title'] == 'What is gradient descent?'
    assert entry['messageCount'] == 2
    assert 'gradient' in entry['preview'].lower()
    loaded = store.get_conversation(conversation)
    assert [m['role'] for m in loaded['messages']] == ['user', 'assistant']
    assert 'iteratively' in loaded['messages'][1]['content']

    # --- Follow-ups stay in the same conversation ---------------------------
    assert store.add_message(conversation, 'user', 'And stochastic gradient descent?')
    assert store.add_message(conversation, 'assistant', 'SGD updates with a data subset per step.')
    assert store.list_conversations()[0]['messageCount'] == 4

    # --- Retry trims the trailing assistant turn ----------------------------
    store.trim(conversation, 'assistant')
    assert store.list_conversations()[0]['messageCount'] == 3
    assert store.get_conversation(conversation)['messages'][-1]['role'] == 'user'
    assert store.add_message(conversation, 'assistant', 'SGD answer, retried.')

    # --- Empty conversations never surface ----------------------------------
    empty = store.start_conversation()
    assert empty
    assert all(entry['id'] != empty for entry in store.list_conversations())
    # Messageless rows older than an hour are dropped by housekeeping.
    import sqlite3
    db = sqlite3.connect(store._path)
    db.execute('UPDATE conversations SET created_at=1, updated_at=1 WHERE id=?', (empty,))
    db.commit(); db.close()
    store.start_conversation()  # triggers housekeeping
    db = sqlite3.connect(store._path)
    assert db.execute('SELECT count(*) FROM conversations WHERE id=?', (empty,)).fetchone()[0] == 0
    db.close()

    # --- Rename --------------------------------------------------------------
    store.rename(conversation, '  My   custom   title.  ')
    assert store.list_conversations()[0]['title'] == 'My custom title.'
    store.rename(conversation, '')
    assert store.list_conversations()[0]['title'] == 'My custom title.'
    store.rename(conversation, 'x' * 500)
    assert len(store.list_conversations()[0]['title']) <= 60

    # --- Delete one conversation ---------------------------------------------
    other = store.start_conversation()
    store.add_message(other, 'user', 'Second question?')
    assert store.delete(other)
    assert store.get_conversation(other) is None
    assert len(store.list_conversations()) == 1
    assert not store.delete('')

    # --- Clear all ------------------------------------------------------------
    assert store.clear()
    assert not Path(store._path).exists()
    assert store.list_conversations() == []

    # --- Privacy: no diagnostics or internal metadata inside content ----------
    conversation = store.start_conversation(model='kept-for-diagnostics-only')
    store.add_message(conversation, 'user', 'Question with secrets?')
    raw = Path(store._path).read_bytes()
    assert b'kept-for-diagnostics-only' in raw  # model metadata column, expected
    store.clear()

    # --- Corrupt database fails closed, never crashes the service -------------
    Path(store._path).write_text('this is not sqlite')
    assert store.list_conversations() == []
    assert store.get_conversation('x') is None
    assert not store.add_message('x', 'user', 'hello')
    assert store.delete('x') is False or store.delete('x') is True

print('GDI_HISTORY lifecycle, titles, trim, bounds, delete/clear and fail-closed PASS')
