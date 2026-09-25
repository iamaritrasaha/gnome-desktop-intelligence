#!/usr/bin/python3
"""Real typing/accessibility/Shell pipeline in the isolated GNOME 46 runner."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
root = Path(sys.argv[1]); project = Path(__file__).resolve().parent.parent
Keyboard = runpy.run_path(str(project/'tools/native-input.py'))['Keyboard']
keyboard = Keyboard(bus)
source = Gio.SettingsSchemaSource.new_from_directory(str(root/'schemas'), None, False)
settings = Gio.Settings.new_full(source.lookup('org.gnome.shell.extensions.gdi',False),None,None)
mock = Path(os.environ['GDI_MOCK_ROOT'])

def call(method, sig='()', args=()):
    return bus.call_sync('org.gnome.DesktopIntelligence1','/org/gnome/DesktopIntelligence1','org.gnome.DesktopIntelligence1',method,GLib.Variant(sig,args),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
def probe(method='Snapshot', sig='()', args=()):
    reply=bus.call_sync('org.gnome.Shell','/org/gnome/GdiSettingsTest','org.gnome.GdiSettingsTest',method,GLib.Variant(sig,args),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
    return json.loads(reply[0]) if reply else None
def fixture(method, sig='()', args=()):
    return bus.call_sync('org.gnome.GdiPassiveFixture','/org/gnome/GdiPassiveFixture','org.gnome.GdiPassiveFixture',method,GLib.Variant(sig,args),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
def stats(): return json.loads(call('PassiveStats')[0])
def wait(predicate, label, timeout=10):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            result=predicate()
            if result: return result
        except GLib.Error: pass
        time.sleep(.05)

def chord_until(chord_args, predicate, label, timeout=10, attempts=3):
    # Nested-session key events are occasionally lost under load; the
    # established runner retransmits the stimulus and requires the designed
    # outcome. A consumed offer refuses retransmitted chords, so this can
    # never double-apply an acceptance.
    for attempt in range(attempts):
        keyboard.chord(*chord_args)
        try:
            wait(predicate, label, timeout)
            return
        except AssertionError:
            if attempt == attempts - 1: raise
    sys.path.insert(0,str(root/'service'))
    from selection import SelectionContext
    Atspi.init()
    node=SelectionContext()._focused_editable(process.pid)[0]
    if node:
        print('FIELD',node.get_interfaces(),node.get_toolkit_name(),node.get_state_set().get_states(),
              Atspi.Text.get_caret_offset(node),Atspi.Text.get_n_selections(node),fixture('Read'),flush=True)
        for coord in (Atspi.CoordType.WINDOW, Atspi.CoordType.SCREEN):
            try:
                rect=Atspi.Text.get_character_extents(node,Atspi.Text.get_caret_offset(node)-1,coord)
                print('RECT',coord,rect.x,rect.y,rect.width,rect.height,flush=True)
            except Exception as e: print('RECT ERROR',coord,str(e),flush=True)
        print('APP TOOLKIT',node.get_application().get_toolkit_name(),flush=True)
    raise AssertionError(f'{label}: {stats()} Shell: {probe()}')
def report(label): print('GDI_PASSIVE '+label+'=PASS',flush=True)
def calls(): return [json.loads(line) for line in (mock/'calls.jsonl').read_text().splitlines()] if (mock/'calls.jsonl').exists() else []
def reset(kind='textview'):
    call('ClearLearning')
    # Production rate limit is intentionally five seconds, even across fields.
    time.sleep(5.1)
    fixture('Reset','(s)',(kind,)); probe('Focus','(i)',(process.pid,)); time.sleep(.25)
def type_sentence(text='This are a useful sentence.'):
    wait(lambda: stats()['enabled'], 'passive enabled')
    keyboard.text(text)

settings.set_string('model-endpoint','http://127.0.0.1:'+os.environ['GDI_MOCK_PORT'])
settings.set_boolean('enable-learning',True)
settings.set_boolean('enable-passive-writing',True)
Gio.Settings.sync()
process=subprocess.Popen([sys.executable,str(project/'tools/passive-fixture.py')])
try:
    wait(lambda: fixture('Read') is not None,'fixture registered')
    probe('Focus','(i)',(process.pid,)); time.sleep(.4)
    print('INITIAL',stats(),probe(),flush=True)
    before=len(calls())
    keyboard.text('This are a useful sentence',.01)
    time.sleep(1)
    assert len(calls())==before
    report('no-model-call-for-typing-or-incomplete-sentence')
    keyboard.text('.')
    completed_at=time.time()
    time.sleep(.35)
    assert len(calls())==before, ('early', len(calls()), before)
    report('debounce-no-early-request')
    wait(lambda: probe()['passiveVisible'],'suggestion after pause')
    assert len(calls())==before+1, ('offer-without-single-call', len(calls()), before, stats())
    debounce_ms=round((calls()[before]['time']-completed_at)*1000)
    assert 700 <= debounce_ms <= 1800, debounce_ms
    print('GDI_PASSIVE measured_debounce_ms='+str(debounce_ms),flush=True)
    print('OFFER',stats(),probe(),flush=True)
    probe('Visual','(s)',(json.dumps({'state':'capture','name':'phase3-gtk-correction'}),))
    chord_until((0xff0d, (0xffe3, 0xffe9)),
                lambda: fixture('Read')[0]=='This is a useful sentence.','native acceptance')
    wait(lambda: probe()['passiveUndo'],'undo surface')
    report('safe-shortcut-and-exact-replacement')
    chord_until((ord('z'), (0xffe3, 0xffe9)),
                lambda: fixture('Read')[0]=='This are a useful sentence.','GDI undo')
    report('safe-undo')
    reset()
    type_sentence('This is a useful sentence.')
    before=len(calls()); time.sleep(1.2)
    assert len(calls())==before
    report('clean-sentence-no-inference')
    reset('password'); before=len(calls())
    keyboard.text('This are a useful sentence.'); time.sleep(1.2)
    assert len(calls())==before and not probe()['passiveVisible']
    report('password-no-inference')
    for kind in ('hidden', 'sensitive', 'tag-hidden'):
        reset(kind); before=len(calls()); print('PRIVACY BEFORE',kind,probe(),flush=True); keyboard.text('This are a useful sentence.')
        time.sleep(1.2)
        if len(calls())!=before or probe()['passiveVisible']:
            sys.path.insert(0,str(root/'service'))
            from selection import SelectionContext
            node=SelectionContext()._focused_editable(process.pid)[0]
            print('PRIVACY AFTER',kind,stats(),probe(),flush=True)
            while node:
                print('NODE',node.get_role_name(),node.get_attributes(),node.get_state_set().get_states(),flush=True)
                if 'Text' in node.get_interfaces():
                    try: print('TEXT ATTRS',Atspi.Text.get_default_attributes(node),flush=True)
                    except Exception: pass
                node=node.get_parent()
        assert len(calls())==before and not probe()['passiveVisible']
        report(kind+'-field-no-inference')

    reset(); type_sentence(); wait(lambda: probe()['passiveVisible'],'Esc offer')
    token=probe()['passiveToken']
    chord_until((0xff1b,), lambda: not probe()['passiveVisible'],'Esc dismiss')
    assert not probe('Passive','(ss)',('AcceptPassive',token))[0], \
        (stats(), probe())
    assert fixture('Read')[0]=='This are a useful sentence.'
    assert json.loads(call('LearningStats')[0])['outcomes'].get('dismissed')==1, \
        json.loads(call('LearningStats')[0])
    report('escape-stale-refusal-and-rejection-learning')

    reset(); type_sentence(); wait(lambda: probe()['passiveVisible'],'typing offer')
    keyboard.text(' More')
    wait(lambda: not probe()['passiveVisible'],'typing dismiss')
    assert not probe()['passiveBindings']
    assert json.loads(call('LearningStats')[0])['outcomes'].get('continued_typing')==1
    report('continued-typing-dismiss-and-weak-negative')

    reset(); (mock/'control.json').write_text(json.dumps({'delay':2}))
    type_sentence(); wait(lambda: stats()['active_request'],'slow generation')
    cancelled=stats().get('cancelled',0); keyboard.text(' More')
    wait(lambda: not stats()['active_request'],'cancel obsolete')
    assert stats()['cancelled']==cancelled+1
    time.sleep(2.2); assert not probe()['passiveVisible']
    (mock/'control.json').write_text('{}')
    report('inflight-cancellation-no-stale-offer')

    reset(); type_sentence(); wait(lambda: probe()['passiveVisible'],'caret offer')
    token=probe()['passiveToken']
    chord_until((0xff51,), lambda: not probe()['passiveVisible'],'caret dismiss')
    assert not probe('Passive','(ss)',('AcceptPassive',token))[0]
    report('caret-move-invalidates-replacement')

    settings.set_boolean('passive-tab-accept',True); Gio.Settings.sync()
    reset(); type_sentence(); wait(lambda: probe()['passiveVisible'],'Tab offer')
    assert 'passive-tab-key' in probe()['passiveBindings']
    chord_until((0xff09,), lambda: fixture('Read')[0]=='This is a useful sentence.','Tab accept')
    wait(lambda: json.loads(call('LearningStats')[0])['outcomes'].get('accepted_unchanged')==1,'positive learning',12)
    report('opt-in-tab-and-accepted-learning')
    reset('entry'); before=len(calls()); type_sentence(); time.sleep(1.3)
    assert not probe()['passiveVisible'] and len(calls())==before
    assert not probe()['passiveBindings']
    report('gtk4-single-line-excluded-and-Tab-preserved')

    settings.set_boolean('passive-tab-accept',False)
    settings.set_boolean('retain-learning-examples',True); Gio.Settings.sync()
    reset(); type_sentence('Context stays.\nThis are a useful sentence.')
    wait(lambda: probe()['passiveVisible'],'bounded range offer')
    chord_until((0xff0d, (0xffe3, 0xffe9)),
                lambda: fixture('Read')[0]=='Context stays.\nThis is a useful sentence.','preserve surrounding paragraph')
    time.sleep(.2); keyboard.chord(0xff08); keyboard.text(' today.')
    wait(lambda: json.loads(call('LearningStats')[0])['outcomes'].get('accepted_edited')==1,'edited learning',12)
    assert json.loads(call('LearningStats')[0])['examples']==1, (stats(),json.loads(call('LearningStats')[0]))
    settings.set_boolean('retain-learning-examples',False); Gio.Settings.sync()
    wait(lambda: json.loads(call('LearningStats')[0])['examples']==0,'example consent revoked')
    report('surrounding-text-edited-learning-consent-and-purge')

    reset(); (mock/'control.json').write_text(json.dumps({'status':503}))
    errors=stats().get('provider_errors',0); type_sentence()
    wait(lambda: stats().get('provider_errors',0)>errors,'provider failure')
    assert not probe()['passiveVisible']
    before=len(calls()); keyboard.text(' This are another useful sentence.')
    time.sleep(1.2); assert len(calls())==before
    (mock/'control.json').write_text('{}'); time.sleep(14.5)
    keyboard.text(' This are a recovered sentence.')
    wait(lambda: probe()['passiveVisible'],'provider recovery')
    keyboard.chord(0xff1b)
    report('provider-failure-backoff-and-recovery')

    # --- Predictive writing: pause → ghost text → Tab/Right/Esc ------------
    settings.set_boolean('enable-predictive-writing', True); Gio.Settings.sync()
    wait(lambda: stats().get('prediction_enabled'), 'prediction enabled', 8)

    time.sleep(5.2)  # clear the prediction pacing interval
    reset()
    wait(lambda: stats()['enabled'], 'passive enabled again')
    before_predictions = stats().get('prediction_requests', 0)
    keyboard.text('The main reason I prefer this architecture is', .01)
    # No per-keystroke model calls: the whole typing burst is one request.
    time.sleep(1.2)
    assert stats().get('prediction_requests', 0) == before_predictions + 1, stats()
    report('prediction-one-request-per-pause')
    wait(lambda: probe()['passiveVisible'], 'ghost surface', 10)
    report('prediction-ghost-shown')
    probe('Visual','(s)',(json.dumps({'state':'capture','name':'phase5-prediction-ghost'}),))
    assert fixture('Read')[0] == 'The main reason I prefer this architecture is'
    chord_until((0xff09,), lambda: fixture('Read')[0] == 'The main reason I prefer this architecture is'
                ' that it keeps the model layer separate from the desktop integration.',
                'Tab accepted full prediction')
    report('prediction-tab-accepts-full')
    # The guarded undo watch lives eight seconds; keep each retry inside it.
    chord_until((ord('z'), (0xffe3, 0xffe9)),
                lambda: fixture('Read')[0] == 'The main reason I prefer this architecture is',
                'prediction undo', timeout=4)
    report('prediction-undo-restores')

    time.sleep(5.2)
    keyboard.text('Predictive writing keeps the desktop', .01)
    wait(lambda: probe()['passiveVisible'], 'ghost again', 10)
    chord_until((0xff53,), lambda: fixture('Read')[0].endswith('desktop that'),
                'one word accepted', 10)  # Right accepts exactly one word
    report('prediction-right-accepts-word')
    wait(lambda: probe()['passiveVisible'], 'remaining ghost re-anchored', 10)
    report('prediction-remainder-reshown')
    chord_until((0xff1b,), lambda: not probe()['passiveVisible'], 'Esc dismissed ghost')
    assert not probe()['passiveBindings']
    report('prediction-escape-dismisses')

    # Stale prediction: continued typing during generation cancels and the
    # late result never surfaces.
    time.sleep(5.2)
    (mock/'control.json').write_text(json.dumps({'prediction_delay': 1.5}))
    before_cancel = stats().get('prediction_cancelled', 0)
    keyboard.text('Late predictions are', .01)
    wait(lambda: stats().get('prediction_active'), 'slow prediction in flight', 8)
    keyboard.text(' never shown', .01)
    wait(lambda: stats().get('prediction_cancelled', 0) == before_cancel + 1, 'in-flight cancelled', 8)
    time.sleep(2.5)
    assert not probe()['passiveVisible']
    assert fixture('Read')[0].endswith('never shown')
    (mock/'control.json').write_text('{}')
    report('prediction-typing-cancels-stale')

    settings.set_boolean('enable-predictive-writing', False); Gio.Settings.sync()
    time.sleep(2.8)
    disabled_before = stats().get('prediction_requests', 0)
    keyboard.text('No prediction after disable')
    time.sleep(1.5)
    assert stats().get('prediction_requests', 0) == disabled_before
    assert not probe()['passiveVisible']
    report('prediction-disable-stops-requests')

    # Idle CPU is process CPU time, not wall time; no periodic accessibility scans.
    owner=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus',
        'GetConnectionUnixProcessID',GLib.Variant('(s)',('org.gnome.DesktopIntelligence1',)),None,Gio.DBusCallFlags.NONE,5000,None).unpack()[0]
    def ticks():
        parts=Path(f'/proc/{owner}/stat').read_text().split(); return int(parts[13])+int(parts[14])
    time.sleep(1); before=len(calls()); cpu=ticks(); started=time.monotonic(); time.sleep(10)
    cpu_percent=100*(ticks()-cpu)/os.sysconf('SC_CLK_TCK')/(time.monotonic()-started)
    assert len(calls())==before and not stats()['active_request']
    assert cpu_percent<1
    print('GDI_PASSIVE idle_seconds=10 cpu_percent='+str(round(cpu_percent,3)),flush=True)
    report('no-idle-model-traffic')
    subprocess.run(['gnome-extensions','disable','gdi@gnome.desktop.intelligence'],check=True)
    wait(lambda: stats()['listeners']==0 and stats()['timers']==0,'disable cleanup')
    assert not probe()['passiveBindings']
    subprocess.run(['gnome-extensions','enable','gdi@gnome.desktop.intelligence'],check=True)
    wait(lambda: stats()['listeners']==4 and probe()['bound'],'reenable listeners')
    assert not probe()['errors']
    reset(); type_sentence(); wait(lambda: probe()['passiveVisible'],'offer after reenable')
    keyboard.chord(0xff1b)
    report('disable-reenable-no-leaked-listeners-timers-bindings')
    # The residency policy owns keep_alive now: quick-model requests must
    # carry a real warm window (extended to 180s while writing is active),
    # never the retired keep_alive=0 contract. Exact per-mode values are
    # unit-covered by tools/test-residency.py.
    assert all(row['body']['keep_alive'] in (90, 180) and
               row['body']['model'] == settings.get_string('model-quick-writing')
               for row in calls())
    print('FINAL',stats(),flush=True)
    (project/'build/validation/phase3-metrics.json').write_text(json.dumps(dict(stats(), idle_cpu_percent=cpu_percent, model_calls=len(calls()), measured_debounce_ms=debounce_ms),indent=2))
finally:
    settings.set_boolean('enable-passive-writing',False); Gio.Settings.sync()
    settings.set_boolean('enable-predictive-writing',False); Gio.Settings.sync()
    keyboard.close(); process.terminate(); process.wait(timeout=5)
