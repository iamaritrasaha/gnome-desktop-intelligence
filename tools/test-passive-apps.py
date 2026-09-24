#!/usr/bin/python3
"""Disposable real applications, private nested bus, synthetic text only."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi, Gio, GLib
root=Path(sys.argv[1]); project=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'service'))
from selection import SelectionContext
Atspi.init(); Atspi.set_timeout(250,500)
bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
keyboard=runpy.run_path(str(project/'tools/native-input.py'))['Keyboard'](bus)
schema=Gio.SettingsSchemaSource.new_from_directory(str(root/'schemas'),None,False)
settings=Gio.Settings.new_full(schema.lookup('org.gnome.shell.extensions.gdi',False),None,None)
def call(method,sig='()',args=()):
    return bus.call_sync('org.gnome.DesktopIntelligence1','/org/gnome/DesktopIntelligence1','org.gnome.DesktopIntelligence1',method,GLib.Variant(sig,args),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
def probe(method='Snapshot',sig='()',args=()):
    value=bus.call_sync('org.gnome.Shell','/org/gnome/GdiSettingsTest','org.gnome.GdiSettingsTest',method,GLib.Variant(sig,args),None,Gio.DBusCallFlags.NONE,5000,None).unpack()
    return json.loads(value[0]) if value else None
def wait(predicate,timeout=15):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=predicate()
        if value: return value
        time.sleep(.1)
    return None
def screenshot(name): probe('Visual','(s)',(json.dumps({'state':'capture','name':'phase3-'+name}),))
def read(node): return Atspi.Text.get_text(node,0,Atspi.Text.get_character_count(node))
settings.set_boolean('enable-passive-writing',True)
settings.set_boolean('enable-learning',False)
settings.set_boolean('passive-tab-accept',True)
settings.set_string('model-endpoint','http://127.0.0.1:'+os.environ['GDI_MOCK_PORT'])
Gio.Settings.sync()
work=Path(os.environ['HOME'])/'app-fixtures'; work.mkdir(exist_ok=True)
reports=[]

def check_field(label,pid):
    time.sleep(5.1)
    probe('Focus','(i)',(pid,))
    node=wait(lambda: SelectionContext()._focused_editable(pid)[0],5)
    if not node:
        print('APPS',[(a.get_process_id(),a.get_name(),a.get_child_count()) for a in Atspi.get_desktop(0)],flush=True)
        screenshot(label+'-unsupported')
        reports.append(dict(app=label,supported=False,reason='No focused accessible editable field'))
        return False
    print('FIELD',label,node.get_role_name(),node.get_interfaces(),node.get_application().get_toolkit_name(),flush=True)
    keyboard.chord(ord('a'),(0xffe3,)); keyboard.chord(0xff08)
    sentence = 'This are a different useful sentence.' if 'light' in label else 'This are a useful sentence.'
    corrected = sentence.replace('This are','This is')
    keyboard.text(sentence)
    if not label.startswith('firefox') and read(node) != sentence:
        print('TYPING-MISDELIVERY',label,repr(read(node)[:60]),
              'focused=',node.get_state_set().contains(Atspi.StateType.FOCUSED),flush=True)
    if label.startswith('firefox'):
        time.sleep(1.3)
        assert not probe()['passiveVisible'], 'Gecko must not offer unverified range editing'
        assert read(node)==sentence
        # A synthetic, disposable probe documents the backend limitation only.
        # No such trial edit is performed by production GDI.
        acknowledged=Atspi.EditableText.delete_text(node,0,4)
        time.sleep(.5)
        unchanged=read(node)==sentence
        screenshot(label+'-compatibility')
        reports.append(dict(app=label,supported=False,accessible=True,
            reason='Gecko range replacement is not verified; passive suppressed',
            delete_acknowledged=acknowledged, unchanged_after_delete=unchanged))
        print('GDI_PASSIVE_APP',label,'UNSUPPORTED: EditableText delete acknowledged=',acknowledged,'unchanged=',unchanged,flush=True)
        return False
    visible=wait(lambda: probe()['passiveVisible'],5)
    if not visible:
        print('NO OFFER',label,call('PassiveStats'),probe(),read(node),flush=True)
        screenshot(label+'-unsupported')
        reports.append(dict(app=label,supported=False,reason='No reliable passive suggestion',stats=json.loads(call('PassiveStats')[0])))
        return False
    if label.startswith('firefox'): assert 'passive-tab-key' not in probe()['passiveBindings']
    screenshot(label)
    # Safe shortcut stays available even with Tab opted in.
    key=0xff09 if 'passive-tab-key' in probe()['passiveBindings'] else 0xff0d
    keyboard.chord(key,() if key==0xff09 else (0xffe3,0xffe9))
    if not wait(lambda: read(node)==corrected,3):
        print('EDIT DEBUG',label,Atspi.EditableText.delete_text(node,0,4),read(node),flush=True)
        time.sleep(.5); print('EDIT AFTER',read(node),flush=True)
        reports.append(dict(app=label,supported=False,reason='EditableText exact edit was refused'))
        return False
    time.sleep(.2)
    keyboard.chord(ord('z'),(0xffe3,0xffe9))
    assert wait(lambda: read(node)==sentence,3), (label,'undo',read(node))
    reports.append(dict(app=label,supported=True,replace=True,gdi_undo=True))
    print('GDI_PASSIVE_APP',label,'PASS',flush=True)
    return True

def check_reference_sentence(label,pid):
    """Requirement reference: aux deletion + irregular verb correction must be
    offered, accepted and undone on the real nested editor surface."""
    time.sleep(5.1)
    probe('Focus','(i)',(pid,))
    node=wait(lambda: SelectionContext()._focused_editable(pid)[0],5)
    if not node:
        reports.append(dict(app=label+'-reference',supported=False,reason='No focused accessible editable field')); return
    keyboard.chord(ord('a'),(0xffe3,)); keyboard.chord(0xff08)
    sentence='I has went to the market yesterday and buy some apples.'
    corrected='I went to the market yesterday and bought some apples.'
    keyboard.text(sentence)
    visible=wait(lambda: probe()['passiveVisible'],8)
    screenshot('reference-sentence')
    if not visible:
        # Nested sessions under load can drop the final keystroke (leaving an
        # incomplete sentence the preflight correctly suppresses) or stall the
        # service loop. Retype once before reporting a failure.
        keyboard.chord(ord('a'),(0xffe3,)); keyboard.chord(0xff08)
        keyboard.text(sentence)
        visible=wait(lambda: probe()['passiveVisible'],8)
    if not visible:
        try:
            stats=json.loads(call('PassiveStats')[0])
            detail=json.dumps(stats.get('recent',[])[-6:])
        except GLib.Error:
            stats, detail = {}, 'PassiveStats timed out (service loop stalled)'
        print('GDI_PASSIVE_APP reference NO OFFER stats=',detail,flush=True)
        reports.append(dict(app=label+'-reference',supported=False,reason='No passive suggestion for reference sentence',stats=stats))
        return
    key=0xff09 if 'passive-tab-key' in probe()['passiveBindings'] else 0xff0d
    keyboard.chord(key,() if key==0xff09 else (0xffe3,0xffe9))
    if not wait(lambda: read(node)==corrected,3):
        reports.append(dict(app=label+'-reference',supported=False,reason='Guarded replacement refused')); return
    time.sleep(.2)
    keyboard.chord(ord('z'),(0xffe3,0xffe9))
    assert wait(lambda: read(node)==sentence,3), (label,'reference-undo',read(node))
    reports.append(dict(app=label+'-reference',supported=True,replace=True,gdi_undo=True))
    print('GDI_PASSIVE_APP',label,'reference sentence PASS',flush=True)

def app(label,argv,fields=1):
    log=project/'build/validation'/f'phase3-{label}.log'
    with log.open('w') as output:
        process=subprocess.Popen(argv,env={**os.environ,'MOZ_ENABLE_WAYLAND':'1','MOZ_ACCESSIBILITY_ATSPI_ENABLED':'1'},stdout=output,stderr=output)
        try:
            window=wait(lambda: next((w for w in probe()['windows'] if w['pid']==process.pid or label in (w['app'] or '').lower()),None),25)
            if not window:
                reports.append(dict(app=label,supported=False,reason='No app window')); return
            pid=window['pid']; probe('Focus','(i)',(pid,)); time.sleep(1)
            if label=='firefox':
                # The fixture autofocus is deliberate; no address-bar typing.
                for suffix in ('textarea','input','contenteditable'):
                    check_field(label+'-'+suffix,pid)
                    keyboard.chord(0xff09); time.sleep(.3)
            else:
                check_field(label,pid)
                if label == 'gnome-text-editor':
                    check_reference_sentence(label,pid)
                    probe('Visual','(s)',(json.dumps({'state':'capture','theme':'light','scale':1.1,'name':'phase3-light-theme'}),))
                    check_field(label+'-light-110',pid)
                    probe('Visual','(s)',(json.dumps({'state':'capture','theme':'dark','scale':1.0,'name':'phase3-dark-theme'}),))
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
try:
    (work/'sample.txt').write_text('')
    app('gnome-text-editor',['gnome-text-editor','--standalone',str(work/'sample.txt')])
    app('zenity',['zenity','--text-info','--editable','--title=GDI synthetic editor','--width=760','--height=480'])
    profile=work/'firefox-profile';profile.mkdir(exist_ok=True)
    (profile/'user.js').write_text('user_pref("accessibility.force_disabled", -1);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);\nuser_pref("datareporting.healthreport.uploadEnabled", false);\nuser_pref("toolkit.telemetry.enabled", false);\nuser_pref("browser.tabs.warnOnClose", false);\n')
    page=work/'editor.html'
    page.write_text('<!doctype html><meta charset="utf-8"><title>GDI writing fixture</title><style>body{padding:40px;font:18px sans-serif}textarea,input,[contenteditable]{display:block;width:650px;margin:15px;height:120px;border:1px solid #aaa}input{height:40px}</style><label>Textarea<textarea autofocus></textarea></label><label>Input<input></label><label>Rich text<div contenteditable="true" role="textbox" aria-label="Rich text"></div></label>')
    app('firefox',['firefox','--no-remote','--profile',str(profile),page.as_uri()],3)
finally:
    settings.set_boolean('enable-passive-writing',False);Gio.Settings.sync();keyboard.close()
    (project/'build/validation/phase3-apps.json').write_text(json.dumps(reports,indent=2))
    print('APPS REPORT',json.dumps(reports),flush=True)
    assert all(row['supported'] for row in reports if not row['app'].startswith('firefox')), reports
