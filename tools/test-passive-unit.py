#!/usr/bin/python3
"""Content and privacy regressions without accessibility or a model."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'service'))
from quality import candidate, quality
from learning import LearningStore
from selection import SelectionContext
from unittest.mock import patch, MagicMock
from gi.repository import Atspi

def result(source, replacement, reason='grammar'):
    return quality(source, json.dumps(dict(replacement=replacement, reason=reason)))
assert result('This are a useful sentence.', 'This is a useful sentence.')
assert result('Please recieve the report.', 'Please receive the report.', 'spelling')
assert result('We have the the report.', 'We have the report.')
# Same-lemma agreement and verb-form derivations, including the reference
# sentence: pronoun+aux fix, participle after aux, coordinated past tense.
assert result('I has went to the market yesterday and buy some apples.',
              'I went to the market yesterday and bought some apples.')
assert result('I has went to the market yesterday and buy some apples.',
              'I have gone to the market yesterday and bought some apples.')
assert result('She has went to the store.', 'She has gone to the store.')
assert result('He don\'t like it.', 'He doesn\'t like it.')
assert result('I seen him yesterday.', 'I saw him yesterday.')
assert result('We was at the office.', 'We were at the office.')
for before, after in [('We have a good report.', 'We have an excellent report.'),
                      ('I like this report.', 'I like this report very much.'),
                      ('This is a report.', 'This is a report. Explanation: fixed'),
                      ('I have 12 reports.', 'I have 13 reports.'),
                      ('Read /tmp/file now please.', 'Read /tmp/other now please.'),
                      ('This is the report.', 'This  is the report.'),
                      # Wrong-direction agreement is never derivable.
                      ('They have arrived.', 'They has arrived.'),
                      ('She has finished.', 'She have finished.'),
                      # A different lemma is a rewrite, not a correction.
                      ('I went to the bank yesterday.', 'I went to the shore yesterday.'),
                      # Tense changes need local past evidence before the verb.
                      ('I go to the market and buy apples.', 'I go to the market and bought apples.'),
                      ('I will go to the market and buy apples yesterday.',
                       'I will go to the market and bought apples yesterday.'),
                      ('Yesterday I plan to walk and buy apples.',
                       'Yesterday I plan to walk and bought apples.'),
                      # A participle after an auxiliary must stay a participle.
                      ('I have seen him.', 'I have saw him.'),
                      ('I went home.', 'I gone home.')]:
    assert not result(before, after), (before, after)
assert not result('She had had a good day.', 'She had a good day.')
assert not result('I believe that that is correct.', 'I believe that is correct.')
assert not quality('This are a useful sentence.', 'Here is the fixed text: This is a useful sentence.')
assert candidate('This are a useful sentence.', 0)
assert not candidate('This are a useful sentence', 0)
assert not candidate('This is a useful sentence.', 0)
assert not candidate('function(x) { return x; }', 0)
assert candidate('I has went to the market yesterday and buy some apples.', 0)
assert not candidate('I have gone to the market every day for years.', 0)
with tempfile.TemporaryDirectory() as temp:
    store = LearningStore(str(Path(temp) / 'learning.sqlite3'))
    source, fixed = 'This are a useful sentence.', 'This is a useful sentence.'
    pattern = store.pattern('agreement', 'This are', 'This is')
    data = dict(source=source, replacement=fixed, model='fixture', application='editor',
                context_type='multiline', category='agreement', pattern=pattern)
    for _ in range(3): store.outcome(data, 'dismissed')
    assert not store.allows('editor', pattern)
    assert source.encode() not in Path(store._path).read_bytes()
    store.outcome(data, 'accepted_edited', 'This is a very useful sentence.', retain=True)
    assert store.stats()['examples'] == 1
    store.purge_examples()
    assert store.stats()['examples'] == 0
    assert b'very useful' not in Path(store._path).read_bytes()
    assert store.clear() and not Path(store._path).exists()
print('GDI_PASSIVE_UNIT quality, trigger, personalization, opt-in examples and secure purge PASS')

# Privacy attribute checks must precede all text reads; hidden subranges and
# unsupported/ambiguous attribute APIs fail closed.
with patch.object(Atspi.Text, 'get_attribute_run', side_effect=[({'invisible':'false'},0,4),({'invisible':'true'},4,12)]):
    assert not SelectionContext._public_text_range(object(),0,12)
with patch.object(Atspi.Text, 'get_attribute_run', return_value=({'invisible':'false'},0,12)):
    assert SelectionContext._public_text_range(object(),0,12)
with patch.object(Atspi.Text, 'get_attribute_run', return_value=({},0,0)):
    assert not SelectionContext._public_text_range(object(),0,12)
with patch.object(Atspi.Text, 'get_attribute_run', side_effect=RuntimeError('unsupported')):
    assert not SelectionContext._public_text_range(object(),0,12)
print('GDI_PASSIVE_UNIT invisible/unsupported attribute ranges fail closed PASS')

# A read-only masked GTK4 entry is still secret; losing EDITABLE state must
# never make it eligible for explicit read-only selection capture.
entry=MagicMock()
entry.get_role.return_value=Atspi.Role.TEXT
entry.get_interfaces.return_value=['Text','EditableText']
entry.get_state_set().contains.return_value=False
entry.get_application().get_toolkit_name.return_value='GTK'
entry.get_application().get_toolkit_version.return_value='4.14.5'
assert SelectionContext._is_secret(entry)
print('GDI_PASSIVE_UNIT read-only GTK4 entry stays excluded PASS')
