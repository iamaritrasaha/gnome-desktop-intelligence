#!/usr/bin/python3
"""Deferred completions must honor cancellation and revoked learning consent."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'service'))
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
from passive import PassiveWriting
from scheduler import RequestScheduler

text='This are a useful sentence.'
for scenario in ('disabled-learning','cleared-learning','cancelled','unwritable-store'):
    settings=MagicMock()
    values={'enable-learning':True,'retain-learning-examples':False,'enable-passive-writing':True}
    settings.get_boolean.side_effect=lambda key: values[key]
    settings.get_string.return_value='fixture-model'
    service=MagicMock()
    service._contexts={}
    # A real scheduler: submit() must invoke the request start immediately so
    # the mocked router call happens exactly as it does in production.
    service._scheduler=RequestScheduler(1)
    service._watch_context.side_effect=lambda context: context.update(ready=True)
    service._release_context.side_effect=lambda token: service._contexts.pop(token,None)
    service._learning.allows.return_value=True
    source=MagicMock()
    source.get_application().get_name.return_value='Fixture'
    source.get_application().get_toolkit_name.return_value='GTK'
    source.get_role.return_value=Atspi.Role.TEXT
    events=[]
    passive=PassiveWriting(service,settings,lambda name,data: events.append(name))
    passive.enabled=True; passive.owner='fixture-owner'; passive.source=source
    passive.geometry={'width':640,'height':480}
    passive._eligible=lambda _: True
    with patch.object(Atspi.Text,'get_caret_offset',return_value=len(text)), \
         patch.object(Atspi.Text,'get_character_count',return_value=len(text)), \
         patch.object(Atspi.Text,'get_text',side_effect=lambda _,start,end:text[start:end]), \
         patch.object(Atspi.Text,'get_character_extents',return_value=SimpleNamespace(x=10,y=10,height=18)):
        passive._trigger()
        assert service._router.run_passive.call_count==1
        complete=service._router.run_passive.call_args.args[-1]
        if scenario=='disabled-learning':
            values['enable-learning']=False
            passive._settings_changed(settings,'enable-learning')
        elif scenario=='cleared-learning': passive.forget_learning()
        elif scenario=='cancelled': passive.dismiss('continued_typing')
        else: service._learning.pattern.side_effect=OSError('read-only fixture')
        complete(json.dumps({'replacement':'This is a useful sentence.','reason':'grammar'}),None)
        if scenario=='cancelled': assert 'PassiveSuggestion' not in events
        else: assert 'PassiveSuggestion' in events
        if scenario!='unwritable-store': service._learning.pattern.assert_not_called()
        else:
            assert passive.metrics['learning_errors']==1
            assert not passive.offer['learn']
        passive.stop()
        assert not service._contexts and not passive.timer and not passive.expiry and not passive.post_timer
        service._learning.outcome.assert_not_called()
    print('GDI_PASSIVE_LIFECYCLE',scenario,'PASS')
