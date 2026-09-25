/*
 * GNOME Shell command palette adapted from Rudra by NarkAgni.
 * Copyright (C) 2026 NarkAgni
 * Copyright (C) 2026 GDI contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from
  'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { calculateExpression } from './src/search/Calculator.js';
import { searchApps } from './src/search/AppSearch.js';
import { cancelFileSearch, searchFiles } from './src/search/FileSearch.js';
import {
  acceptPrediction,
  actionStats,
  cancelTransform,
  captureCaretContext,
  captureFocusedContext,
  errorMessage,
  historyAdd,
  historyClear,
  historyDelete,
  historyGet,
  historyList,
  historyRename,
  historyStart,
  historyTrim,
  prewarmModel,
  recordSignal,
  recordActionDiagnostic,
  recordActionUse,
  releaseContext,
  replaceSelection,
  resetActionDiagnostics,
  residencyStatus,
  transform,
  streamTransform,
  undoReplacement,
} from './src/intelligence/ServiceClient.js';

import { askQueryRemainder, historyGroups, isResponse, preferAssistant, selectionIntent, selectionIntentParts } from './src/intelligence/Presentation.js';
import { addDiff, addMarkdown, StreamRenderer } from './src/intelligence/ResponseView.js';
import { MORE_ACTIONS, TONE_ACTIONS, writingMenuFor } from './src/intelligence/WritingMenu.js';
import { parseActionPlan, parseFileQuery } from './src/actions/parser.js';
import {
  beginActionTrace,
  clearDiagnostics,
  diagnosticsSummary,
  executePlan,
  finishLauncherTrace,
  finishTrace,
  localDiagnostics,
  mayNeedModelRouting,
  prepareAction,
  preparePlan,
  suggestActionFromModel,
} from './src/actions/engine.js';

const PALETTE_WIDTH = 500;
const RESULT_LIMIT = 4;
const OPEN_CLOSE_DURATION = 120;
const RESULT_FADE_DURATION = 100;
const HORIZONTAL_GUTTER = 32;
const BOTTOM_GUTTER = 24;
const PALETTE_FIXED_HEIGHT = 56;
// Four 48px rows plus result spacing/padding, matching the scroll viewport.
const LAUNCHER_RESULTS_HEIGHT = 194;

const HISTORY_COMMAND = /^history$/i;
const HISTORY_LABELS = ['Today', 'Yesterday', 'Earlier'];
const HISTORY_LIST_LIMIT = 60;
// Deterministic results render on every keystroke; the file scan keeps a
// short debounce and the routing model waits until typing has stabilized.
const FILE_SEARCH_DEBOUNCE_MS = 90;
const MODEL_SUGGESTION_IDLE_MS = 350;
const RANKING_TTL_MS = 30_000;

const WEB_ICON = new Gio.ThemedIcon({name: 'web-browser-symbolic'});
const CALC_ICON = new Gio.ThemedIcon({name: 'accessories-calculator-symbolic'});

/* Developer diagnostics: one line per residency role, e.g.
 * "Quick · warm · 0.8 GB VRAM · expires in 62s". */
function residencyLines(status) {
  if (!status)
    return _('Model residency is unavailable right now.');
  const roles = status.roles ?? {};
  const describe = role => {
    if (!role?.resident)
      return 'cold';
    const seconds = role.expires_in ?? null;
    const gigabytes = role.size_vram ? ` · ${(role.size_vram / 1e9).toFixed(1)} GB VRAM` : '';
    return `warm${gigabytes}${seconds !== null ? ` · expires in ${seconds}s` : ''}`;
  };
  const lines = [`Resource mode: ${status.mode} · active requests: ${status.active_requests ?? 0}`];
  for (const [role, label] of [['quick', 'Quick'], ['intent', 'Routing'], ['assistant', 'Assistant'], ['reasoning', 'Reasoning']]) {
    const entry = roles[role];
    if (entry?.model)
      lines.push(`${label} (${entry.model}) · ${describe(entry)}`);
  }
  if (!(status.resident_models ?? []).length)
    lines.push('No GDI model resident');
  return lines.join('\n');
}

const ACTION_LABELS = {
  proofread: 'Fix grammar', rewrite: 'Improve writing', concise: 'Make concise',
  expand: 'Expand', professional: 'Professional', casual: 'Casual',
  friendly: 'Friendly', direct: 'Direct', continue: 'Continue writing',
  summarize: 'Summarize', keypoints: 'Key points', explain: 'Explain',
  translate: 'Translate', ask: 'Ask Intelligence', assistant: 'Ask Intelligence',
};

export class LauncherPalette {
  constructor(settings, intelligenceIcon, visibilityChanged = () => {}, openSettings = () => {}) {
    this._openSettings = openSettings;
    this._visibilityChanged = visibilityChanged;
    this._settings = settings;
    this._intelligenceIcon = intelligenceIcon;
    this._isOpen = false;
    this._items = [];
    this._selectedIndex = -1;
    this._queryGeneration = 0;
    this._searchTimeoutId = 0;
    this._modelTimeoutId = 0;
    this._focusTimeoutId = 0;
    this._positionTimeoutId = 0;
    this._animationGeneration = 0;
    this._isDestroyed = false;
    this._viewportMode = 'normal';
    this._mode = 'launcher';
    this._writingContext = null;
    this._writingAction = null;
    this._writingQuestion = '';
    this._writingGeneration = 0;
    this._lastTransform = null;
    this._undoAvailable = false;
    this._submenu = null;
    this._conversationId = null;
    this._historyConversation = null;
    this._historyClearArmed = false;
    this._motionSettings = new Gio.Settings({
      schema_id: 'org.gnome.desktop.interface',
    });
    this._animationsEnabled = this._motionSettings.get_boolean('enable-animations');
    this._motionSettingsSignalId = this._motionSettings.connect(
      'changed::enable-animations', () => this._onMotionPreferenceChanged(),
    );
    this._buildUi();
    this._monitorsChangedId = Main.layoutManager.connect(
      'monitors-changed', () => this._schedulePosition());
  }

  _buildUi() {
    this._overlay = new St.Widget({
      name: 'gdi-overlay',
      style_class: 'gdi-overlay',
      reactive: true,
      visible: false,
      // Placement owns this child's allocation; BinLayout propagates child
      // expansion and fills the stage from its fixed x coordinate.
      layout_manager: new Clutter.FixedLayout(),
    });
    this._overlay.add_constraint(new Clutter.BindConstraint({
      source: global.stage,
      coordinate: Clutter.BindCoordinate.ALL,
    }));

    this._palette = new St.BoxLayout({
      name: 'gdi-palette',
      style_class: 'gdi-palette popup-menu-content',
      vertical: true,
      x_expand: false,
      y_expand: false,
      reactive: true,
      can_focus: true,
    });
    this._palette.set_pivot_point(0.5, 0.5);
    if (!this._animationsEnabled)
      this._palette.add_style_class_name('gdi-reduced-motion');

    const searchRow = new St.BoxLayout({
      name: 'gdi-search-row',
      style_class: 'gdi-search-row',
      vertical: false,
      x_expand: true,
    });
    this._searchRow = searchRow;
    this._searchIcon = new St.Icon({
      gicon: this._intelligenceIcon,
      style_class: 'gdi-search-icon',
      icon_size: 18,
    });
    searchRow.add_child(this._searchIcon);
    this._entry = new St.Entry({
      name: 'gdi-search-entry',
      hint_text: _('Ask, search, or open…'),
      style_class: 'gdi-search-entry search-entry',
      can_focus: true,
      x_expand: true,
    });
    this._entry.get_hint_actor().opacity = 190;
    searchRow.add_child(this._entry);

    this._results = new St.BoxLayout({
      style_class: 'gdi-results',
      vertical: true,
      x_expand: true,
    });
    this._scrollView = new St.ScrollView({
      style_class: 'gdi-results-scroll',
      visible: false,
      x_expand: true,
    });
    this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._scrollView.set_child(this._results);
    this._launcherNote = new St.Label({
      style_class: 'gdi-context-note',
      visible: false,
      x_expand: true,
    });
    this._launcherNote.clutter_text.line_wrap = true;
    this._launcherNote.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

    this._writingView = new St.BoxLayout({
      name: 'gdi-writing-view',
      style_class: 'gdi-writing-view',
      vertical: true,
      x_expand: true,
      visible: false,
    });
    this._writingScroll = new St.ScrollView({
      style_class: 'gdi-writing-scroll',
      x_expand: true,
      visible: false,
    });
    this._writingScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._writingContent = new St.BoxLayout({
      style_class: 'gdi-writing-content',
      vertical: true,
      x_expand: true,
    });
    this._writingScroll.set_child(this._writingContent);
    this._writingControls = new St.BoxLayout({
      style_class: 'gdi-writing-controls',
      x_expand: true,
    });
    this._writingView.add_child(this._writingScroll);
    this._writingView.add_child(this._writingControls);
    this._followup = new St.Entry({style_class: 'gdi-followup', hint_text: _('Ask a follow-up…'),
      can_focus: true, x_expand: true, visible: false});
    this._followup.clutter_text.connect('activate', () => {
      const question = this._followup.get_text().trim();
      if (!question || this._mode === 'writing-loading') return;
      this._requestHistory = [...this._conversation];
      this._startWritingRequest({key: this._writingContext?.selected ? 'ask' : 'assistant', label: _('Ask Intelligence')}, question);
    });
    this._writingView.add_child(this._followup);

    this._palette.add_child(searchRow);
    this._palette.add_child(this._launcherNote);
    this._palette.add_child(this._scrollView);
    this._palette.add_child(this._writingView);
    this._overlay.add_child(this._palette);

    Main.uiGroup.add_child(this._overlay);
    Main.uiGroup.set_child_above_sibling(this._overlay, null);
    this._overlay.hide();

    this._entry.clutter_text.connect('text-changed', () => this._onQueryChanged());
    this._entry.clutter_text.connect('key-press-event', (_actor, event) =>
      this._onKeyPress(event));
    this._overlay.connect('captured-event', (_actor, event) =>
      this._onCapturedEvent(event));
    // Outside-click dismissal uses the bubble phase, not captured-event: the
    // modal grab retargets only presses that pick outside this overlay to it,
    // while presses inside the palette reach their real actor first and then
    // bubble here with that actor as the event source. A capture-phase handler
    // on the overlay would instead see every inside press first and risks
    // swallowing events that belong to palette children.
    this._overlay.connect('button-press-event', (_actor, event) =>
      this._onOutsidePress(event));
    this._overlay.connect('touch-event', (_actor, event) =>
      this._onOutsidePress(event));
  }

  toggle() {
    if (this._isOpen)
      this.close();
    else
      this.open();
  }

  openHistory() {
    this.open(null, {history: true});
  }

  get isOpen() {
    return this._isOpen;
  }

  open(context = null, { history = false } = {}) {
    if (this._isOpen || this._isDestroyed)
      return;

    const monitor = Main.layoutManager.currentMonitor;
    this._monitorIndex = monitor?.index;
    if (!monitor)
      return;

    this._animationGeneration++;
    this._palette.remove_all_transitions();
    this._resetWritingState();
    this._refreshActionRanking();
    this._entry.set_text('');
    this._clearResults();
    this._writingContext = context;
    this._targetWindow = global.display.focus_window;
    if (history) {
      this._showHistoryList();
    } else if (context?.selected) {
      this._writingContext = context;
      this._showWritingActions();
    } else if (context?.capabilities?.canReadCaretContext && context?.editable) {
      // No selection, but the focused field exposes caret context: offer the
      // contextual writing surface instead of an empty launcher.
      this._showContextualWritingActions();
    } else {
      this._mode = 'launcher';
      this._searchRow.show();
      this._writingView.hide();
      this._entry.hint_text = _('Ask, search, or open…');
      this._searchIcon.gicon = this._intelligenceIcon;
      this._showCaptureStatus(context);
    }
    this._positionPalette(monitor);

    Main.uiGroup.set_child_above_sibling(this._overlay, null);
    this._overlay.reactive = true;
    this._overlay.show();
    try {
      this._modalGrab = Main.pushModal(this._overlay, {
        actionMode: Shell.ActionMode.ALL,
      });
    } catch (error) {
      this._overlay.reactive = false;
      this._overlay.hide();
      console.warn(`GDI could not acquire palette input: ${error.message}`);
      return;
    }
    if (!this._modalGrab) {
      this._overlay.reactive = false;
      this._overlay.hide();
      console.warn('GDI could not acquire keyboard focus for its palette');
      return;
    }

    this._isOpen = true;
    this._visibilityChanged();
    this._schedulePosition();

    if (this._animationsEnabled) {
      this._palette.opacity = 0;
      this._palette.scale_x = 1;
      this._palette.scale_y = 1;
      this._palette.translation_y = 0;
    } else {
      this._resetPaletteTransform();
    }

    if (this._focusTimeoutId)
      GLib.source_remove(this._focusTimeoutId);
    this._focusTimeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._focusTimeoutId = 0;
      if (this._isOpen)
        global.stage.set_key_focus(this._entry);
      return GLib.SOURCE_REMOVE;
    });

    if (this._animationsEnabled) {
      this._palette.ease({
        opacity: 255,
        scale_x: 1,
        scale_y: 1,
        translation_y: 0,
        duration: OPEN_CLOSE_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT,
      });
    }
  }

  close() {
    if (!this._isOpen)
      return;

    // A dismissed confirmation is a cancelled action, never a pending one:
    // the trace is closed here so no path (button, Escape, outside click)
    // can leave an actionable plan behind.
    if (this._mode === 'action-confirm' && this._pendingPlan?.trace &&
        this._pendingPlan.trace.status === 'open')
      finishTrace(this._pendingPlan.trace, 'cancelled', 'Confirmation dismissed');
    this._pendingPlan = null;

    if (this._mode === 'writing-loading' && this._writingContext)
      cancelTransform(this._writingContext.token);
    if ((this._mode === 'writing-result' || this._mode === 'writing-error') &&
        !this._isDestroyed && this._writingContext && this._writingAction &&
        !this._undoAvailable) {
      recordSignal(this._writingContext.token, this._writingAction.key,
        'rejected', this._learningEnabled());
    }

    this._stopStream();
    if (this._insertFocusTimer) GLib.source_remove(this._insertFocusTimer);
    this._insertFocusTimer = 0;
    this._conversation = [];
    this._requestHistory = [];
    releaseContext(this._writingContext?.token);
    this._isOpen = false;
    this._visibilityChanged();
    this._writingGeneration++;
    this._animationGeneration++;
    this._queryGeneration++;
    cancelFileSearch();
    if (this._searchTimeoutId) {
      GLib.source_remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    if (this._modelTimeoutId) {
      GLib.source_remove(this._modelTimeoutId);
      this._modelTimeoutId = 0;
    }
    if (this._focusTimeoutId) {
      GLib.source_remove(this._focusTimeoutId);
      this._focusTimeoutId = 0;
    }
    if (this._positionTimeoutId) {
      GLib.source_remove(this._positionTimeoutId);
      this._positionTimeoutId = 0;
    }

    const focus = global.stage.get_key_focus();
    if (focus && this._overlay.contains(focus))
      global.stage.set_key_focus(null);

    this._entry.set_text('');
    this._overlay.reactive = false;

    if (this._modalGrab) {
      try {
        Main.popModal(this._modalGrab);
      } catch (error) {
        console.warn(`GDI could not release palette input: ${error.message}`);
      }
      this._modalGrab = null;
    }

    const animationGeneration = this._animationGeneration;
    if (this._animationsEnabled && !this._isDestroyed) {
      this._palette.remove_all_transitions();
      this._palette.ease({
        opacity: 0,
        scale_x: 1,
        scale_y: 1,
        translation_y: 0,
        duration: OPEN_CLOSE_DURATION,
        mode: Clutter.AnimationMode.EASE_IN,
        onComplete: () => {
          if (this._isOpen || animationGeneration !== this._animationGeneration)
            return;
          this._overlay.hide();
          this._resetPaletteTransform();
          this._clearResults();
          this._resetWritingState();
        },
      });
    } else {
      this._palette.remove_all_transitions();
      this._overlay.hide();
      this._resetPaletteTransform();
      this._clearResults();
      this._resetWritingState();
    }
  }

  destroy() {
    this._isDestroyed = true;
    Main.layoutManager.disconnect(this._monitorsChangedId);
    this.close();
    this._animationGeneration++;
    this._palette.remove_all_transitions();
    this._overlay.reactive = false;
    this._overlay.hide();
    this._entry.set_text('');
    this._clearResults();
    cancelFileSearch();
    if (this._motionSettingsSignalId) {
      this._motionSettings.disconnect(this._motionSettingsSignalId);
      this._motionSettingsSignalId = 0;
    }
    this._motionSettings = null;
    if (this._overlay) {
      Main.uiGroup.remove_child(this._overlay);
      this._overlay.destroy();
      this._overlay = null;
    }
  }

  _resetPaletteTransform() {
    this._palette.opacity = 255;
    this._palette.scale_x = 1;
    this._palette.scale_y = 1;
    this._palette.translation_y = 0;
  }

  _onMotionPreferenceChanged() {
    const wasEnabled = this._animationsEnabled;
    this._animationsEnabled = this._motionSettings.get_boolean('enable-animations');
    if (this._animationsEnabled === wasEnabled)
      return;

    if (this._animationsEnabled) {
      this._palette.remove_style_class_name('gdi-reduced-motion');
      return;
    }

    this._palette.add_style_class_name('gdi-reduced-motion');
    this._palette.remove_all_transitions();
    for (const row of this._results.get_children()) {
      row.remove_all_transitions();
      row.opacity = 255;
    }
    if (this._isOpen) {
      this._resetPaletteTransform();
    } else {
      this._overlay.hide();
      this._clearResults();
    }
  }

  _getViewportMode(monitorHeight, panelHeight) {
    const topInset = Math.max(48, panelHeight + 20);
    const availableResultsHeight = monitorHeight - topInset - BOTTOM_GUTTER -
      PALETTE_FIXED_HEIGHT;
    if (availableResultsHeight < 140)
      return 'tiny';
    if (availableResultsHeight < 200)
      return 'short';
    if (availableResultsHeight < 300)
      return 'compact';
    return 'normal';
  }

  _calculatePlacement(monitor, paletteHeight, panelHeight, widthLimit = PALETTE_WIDTH) {
    const width = Math.max(1, Math.min(widthLimit,
      monitor.width - HORIZONTAL_GUTTER));
    const topInset = Math.max(48, panelHeight + 20);
    const height = Math.min(paletteHeight,
      Math.max(1, monitor.height - topInset - BOTTOM_GUTTER));
    const topLimit = monitor.y + topInset;
    const launcher = widthLimit === PALETTE_WIDTH;
    // Anchor the search bar, not the center of the changing result surface.
    // Reserve the full launcher budget when clamping on short monitors, so
    // adding/removing results cannot move its top edge either.
    const reservedHeight = launcher
      ? Math.min(PALETTE_FIXED_HEIGHT + LAUNCHER_RESULTS_HEIGHT,
        Math.max(1, monitor.height - topInset - BOTTOM_GUTTER))
      : height;
    const bottomLimit = monitor.y + monitor.height - BOTTOM_GUTTER - reservedHeight;
    const anchorHeight = launcher ? PALETTE_FIXED_HEIGHT : height;
    const upperMiddle = monitor.y + Math.round(monitor.height * 0.38 - anchorHeight / 2);
    const y = Math.max(topLimit, Math.min(upperMiddle, bottomLimit));
    return {
      x: monitor.x + Math.round((monitor.width - width) / 2),
      y,
      width,
      height: Math.min(height, monitor.y + monitor.height - BOTTOM_GUTTER - y),
    };
  }

  _positionPalette(monitor = Main.layoutManager.monitors[this._monitorIndex] ??
    Main.layoutManager.currentMonitor) {
    if (!monitor)
      return;

    this._viewportMode = this._getViewportMode(monitor.height, Main.panel.height);
    for (const mode of ['normal', 'compact', 'short', 'tiny']) {
      const className = `gdi-results-scroll-${mode}`;
      if (mode === this._viewportMode)
        this._scrollView.add_style_class_name(className);
      else
        this._scrollView.remove_style_class_name(className);
    }

    const availableWidth = Math.max(1, monitor.width - HORIZONTAL_GUTTER);
    const widthLimit = PALETTE_WIDTH;
    const width = Math.min(widthLimit, availableWidth);
    this._palette.set_width(width);
    if (this._mode.startsWith('writing-') || this._mode.startsWith('history-')) {
      const anchor = this._calculatePlacement(monitor, PALETTE_FIXED_HEIGHT, Main.panel.height);
      const available = monitor.y + monitor.height - BOTTOM_GUTTER - anchor.y;
      this._writingControls.vertical = width < 420;
      const controlsHeight = this._writingControls.get_preferred_height(width - 16)[1];
      // Height is dynamic: short answers stay compact, long answers grow to
      // a work-area-relative maximum and then scroll internally. The top
      // edge, horizontal center and the fixed 500px width never move.
      const workAreaMax = Math.min(520, Math.max(220, Math.round(available * 0.6)));
      const cap = Math.max(40, Math.min(workAreaMax,
        available - Math.max(64, controlsHeight + (this._followup.visible ? 64 : 16))));
      const contentHeight = this._writingContent.get_preferred_height(Math.max(1, width - 32))[1];
      this._writingScroll.height = Math.min(cap, Math.max(40, contentHeight));
    }
    const [, naturalHeight] = this._palette.get_preferred_height(width);
    const placement = this._calculatePlacement(
      monitor,
      naturalHeight || this._palette.get_height(),
      Main.panel.height,
      widthLimit,
    );
    this._palette.set_position(placement.x, placement.y);
  }

  _schedulePosition() {
    if (!this._isOpen || this._positionTimeoutId)
      return;

    this._positionTimeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._positionTimeoutId = 0;
      if (this._isOpen)
        this._positionPalette();
      return GLib.SOURCE_REMOVE;
    });
  }

  _onQueryChanged() {
    if (!this._isOpen)
      return;
    if (!['launcher', 'writing-actions'].includes(this._mode))
      return;

    if (this._searchTimeoutId) {
      GLib.source_remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    if (this._modelTimeoutId) {
      GLib.source_remove(this._modelTimeoutId);
      this._modelTimeoutId = 0;
    }
    cancelFileSearch();
    const generation = ++this._queryGeneration;
    const query = this._entry.get_text().trim();

    if (!query) {
      if (this._mode === 'writing-actions') {
        this._renderWritingChips(this._currentMenuItems ?? []);
        return;
      }
      this._clearResults();
      this._schedulePosition();
      return;
    }

    // Stage 1 is entirely in-memory (app cache, calculator, action parser),
    // so it runs on every keystroke without a debounce and deterministic
    // results appear immediately.
    this._search(query, generation);
  }

  _search(query, generation) {
    // With a selection, the typed verb selects the action and only the
    // remainder may reach a model. On the contextual (no-selection) surface
    // typed queries keep plain launcher routing; the caret-scoped chips are
    // the explicit contextual path.
    if (this._mode === 'writing-actions' && this._writingContext?.selected) {
      const {action, remainder} = selectionIntentParts(query);
      const label = _(ACTION_LABELS[action] ?? 'Ask Intelligence');
      this._setResults([{type: 'selection-intent', name: label,
        query: remainder, actionKey: action, promptOnly: action === 'ask' && !remainder,
        icon: this._intelligenceIcon}]);
      return;
    }
    if (HISTORY_COMMAND.test(query.trim())) {
      this._setResults([{
        type: 'history-open', name: _('Intelligence History'),
        icon: this._intelligenceIcon,
      }]);
      return;
    }
    if (/^gdi (?:action )?diagnostics$/i.test(query.trim())) {
      this._showActionDiagnostics();
      return;
    }
    const webMatch = query.match(/^search\s+(.+)$/i);
    if (webMatch) {
      const term = webMatch[1].trim();
      this._setResults([{
        type: 'web',
        name: _('Search the web for “%s”').format(term),
        icon: WEB_ICON,
        query: term,
      }]);
      return;
    }

    const calculatorValue = calculateExpression(query);
    if (calculatorValue !== null) {
      this._setResults([{
        type: 'calc',
        name: String(calculatorValue),
        icon: CALC_ICON,
        value: String(calculatorValue),
      }]);
      return;
    }

    // An explicit Ask command outranks fuzzy app matches, exactly like the
    // 'search' prefix. Bare 'ask' enters the empty prompt; 'ask <question>'
    // submits only the question. Exact app names still win natural questions.
    const askRemainder = askQueryRemainder(query);
    if (askRemainder !== null) {
      this._setResults([this._askRow(askRemainder)]);
      return;
    }

    // Native desktop actions: deterministic parsing first; the routing model
    // is only consulted (below) when nothing here matches.
    if (parseActionPlan(query)) {
      const trace = beginActionTrace({query, source: 'deterministic'});
      preparePlan(query, 'deterministic', trace).then(plan => {
        if (!this._isOpen || generation !== this._queryGeneration) {
          if (plan?.trace)
            finishTrace(plan.trace, 'cancelled', 'Superseded by a newer query');
          return;
        }
        if (plan) {
          this._setResults([{
            type: 'action',
            name: this._actionPlanName(plan),
            plan,
            icon: this._actionIcon(plan.steps[0].action.icon),
          }]);
          return;
        }
        // Validation vetoed the plan (e.g. an untrusted URL form): fall back
        // to the plain launcher interpretation instead of showing nothing.
        this._searchLauncher(query, generation);
      }).catch(error => {
        if (trace.status === 'open')
          finishTrace(trace, 'failed', `Plan preparation failed: ${error?.message ?? error}`);
        if (this._isOpen && generation === this._queryGeneration)
          this._searchLauncher(query, generation);
      });
      return;
    }
    this._searchLauncher(query, generation);
  }

  _searchLauncher(query, generation) {
    let term = query;
    let shouldSearchFiles = false;
    let fileOptions = null;
    const parsedFile = parseFileQuery(query);
    const fileQuery = query.match(/^\.\s*(.+)$/);
    const openQuery = query.match(/^open\s+(.+)$/i);
    if (parsedFile) {
      term = parsedFile.terms;
      shouldSearchFiles = true;
      fileOptions = {
        extension: parsedFile.extension,
        modifiedSince: parsedFile.modifiedToday ? this._localMidnight() : 0,
      };
    } else if (fileQuery) {
      term = fileQuery[1].trim();
      shouldSearchFiles = true;
    } else if (openQuery) {
      term = openQuery[1].trim().replace(/^file\s+/i, '');
      shouldSearchFiles = true;
    }

    const apps = searchApps(term, RESULT_LIMIT, this._actionRanking?.apps ?? {});
    if (!shouldSearchFiles) {
      if (apps.length && !preferAssistant(query, apps.map(app => app.name))) {
        this._setResults(apps);
        return;
      }
      // Deterministic parsing found nothing. Ask Intelligence is shown right
      // away; the small routing model is consulted only after typing has
      // stabilized, and never on every keystroke.
      this._setResults([this._askRow(query)]);
      if (!preferAssistant(query, []) && mayNeedModelRouting(query))
        this._scheduleActionSuggestion(query, generation);
      return;
    }

    // Cached app matches are shown instantly; the file scan stays
    // asynchronous and appends stage-2 results when it completes.
    this._setResults(apps);
    if (term.length < 2 && !fileOptions?.extension && !fileOptions?.modifiedSince)
      return;

    if (this._searchTimeoutId) {
      GLib.source_remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FILE_SEARCH_DEBOUNCE_MS, () => {
      this._searchTimeoutId = 0;
      if (this._isOpen && generation === this._queryGeneration)
        searchFiles(term, files => {
          if (!this._isOpen || generation !== this._queryGeneration)
            return;
          this._setResults([...apps, ...this._rankFiles(files)].slice(0, RESULT_LIMIT));
        }, RESULT_LIMIT, fileOptions ?? {});
      return GLib.SOURCE_REMOVE;
    });
  }

  _askRow(query) {
    return {
      type: 'ask', name: _('Ask Intelligence'),
      query,
      promptOnly: query === '',
      icon: this._intelligenceIcon,
    };
  }

  _prewarmAssistant() {
    // Entering Ask Intelligence is the only launcher surface that may begin
    // loading a model, and it does so while the user still types their
    // question. Plain launcher use, calculator and app launches never touch
    // the model provider.
    try {
      prewarmModel('assistant');
    } catch (_error) {
      // The service starting up just-in-time for the real request is fine.
    }
  }

  _actionPlanName(plan) {
    return plan.steps.map(step => step.action.title(step.args)).join(' + ');
  }

  _actionIcon(name) {
    try {
      return new Gio.ThemedIcon({ name });
    } catch (_error) {
      return this._intelligenceIcon;
    }
  }

  _localMidnight() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  }

  _rankFiles(files) {
    const boosts = this._actionRanking?.dirs ?? {};
    if (!Object.keys(boosts).length)
      return files;
    return [...files].sort((a, b) =>
      (boosts[b.name] ?? 0) - (boosts[a.name] ?? 0));
  }

  _refreshActionRanking() {
    // Rankings change rarely: serve them from a short TTL cache instead of a
    // D-Bus round trip on every palette open.
    if (!this._learningEnabled()) {
      this._actionRanking = null;
      return;
    }
    if (this._actionRanking && this._rankingTime &&
        GLib.get_monotonic_time() / 1000 - this._rankingTime < RANKING_TTL_MS)
      return;
    this._rankingTime = GLib.get_monotonic_time() / 1000;
    actionStats((stats, _error) => {
      if (stats)
        this._actionRanking = stats;
    });
  }

  _scheduleActionSuggestion(query, generation) {
    // Stage 3: consult the routing model only once the query has stopped
    // changing. Continued typing cancels the pending call, so ordinary typing
    // never triggers model work and the launcher never waits on it.
    if (this._modelTimeoutId) {
      GLib.source_remove(this._modelTimeoutId);
      this._modelTimeoutId = 0;
    }
    this._modelTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MODEL_SUGGESTION_IDLE_MS, () => {
      this._modelTimeoutId = 0;
      if (this._isOpen && generation === this._queryGeneration)
        this._startActionSuggestion(query, generation);
      return GLib.SOURCE_REMOVE;
    });
  }

  _startActionSuggestion(query, generation) {
    // Bounded model use: one routing-model request per stabilized query,
    // guarded by the search generation. Deterministic actions never enter
    // this path, and the Ask row already on screen is not displaced while the
    // model answers — a suggestion only replaces it when one actually fits.
    const trace = beginActionTrace({query, source: 'model'});
    suggestActionFromModel(query, this._settings, trace).then(suggested => {
      if (!this._isOpen || generation !== this._queryGeneration) {
        if (trace.status === 'open')
          finishTrace(trace, 'cancelled', 'Superseded by a newer query');
        return;
      }
      if (!suggested) {
        if (trace.status === 'open')
          finishTrace(trace, 'complete', 'No matching action — Ask Intelligence shown');
        return;
      }
      prepareAction(suggested.id, suggested.args, 'model', trace).then(plan => {
        if (!this._isOpen || generation !== this._queryGeneration) {
          if (plan?.trace)
            finishTrace(plan.trace, 'cancelled', 'Superseded by a newer query');
          return;
        }
        if (!plan) {
          if (trace.status === 'open')
            finishTrace(trace, 'invalid-tool-call', 'Rejected by the registry');
          return;
        }
        this._setResults([{
          type: 'action',
          name: this._actionPlanName(plan),
          plan,
          suggested: true,
          icon: this._actionIcon(plan.steps[0].action.icon),
        }]);
      }).catch(error => {
        if (trace.status === 'open')
          finishTrace(trace, 'failed', `Suggested plan failed: ${error?.message ?? error}`);
      });
    }).catch(error => {
      if (trace.status === 'open')
        finishTrace(trace, 'failed', `Routing model unavailable: ${error?.message ?? error}`);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Native action views: confirmation, execution and result.          */
  /* ---------------------------------------------------------------- */

  _showActionView({heading, lines, buttons}) {
    this._searchRow.hide();
    this._clearResults();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._writingScroll.show();
    this._writingView.show();
    this._followup.hide();
    if (heading)
      this._addWritingHeading(heading);
    for (const line of lines) {
      const label = new St.Label({
        style_class: 'gdi-writing-text',
        text: line,
        x_expand: true,
      });
      label.clutter_text.line_wrap = true;
      label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
      this._writingContent.add_child(label);
    }
    for (const [label, callback, flat] of buttons)
      this._addWritingButton(label, callback, flat);
    this._positionPalette();
    const firstButton = this._writingControls.get_first_child();
    if (firstButton)
      global.stage.set_key_focus(firstButton);
  }

  _runActionPlan(plan) {
    if (plan.needsConfirmation) {
      this._pendingPlan = plan;
      const heading = `${this._actionPlanName(plan)}?`;
      const lines = [];
      if (plan.steps.length > 1) {
        plan.steps.forEach((step, index) => {
          lines.push(`${index + 1}. ${step.action.title(step.args)}`);
        });
      }
      for (const step of plan.steps) {
        const note = step.action.confirmNote?.(step.args);
        if (note && !lines.includes(note))
          lines.push(note);
      }
      const confirmStep = plan.steps.find(step => step.action.confirmLabel);
      const confirmLabel = _(confirmStep ? confirmStep.action.confirmLabel(confirmStep.args) : 'Confirm');
      this._mode = 'action-confirm';
      this._showActionView({heading, lines, buttons: [
        [_('Cancel'), () => this.close(), true],
        [confirmLabel, () => this._executeActionPlan(this._pendingPlan), false],
      ]});
      return;
    }
    this._executeActionPlan(plan);
  }

  _executeActionPlan(plan) {
    const trace = plan.trace;
    this._mode = 'action-running';
    this._pendingPlan = null;
    this._showActionView({heading: _('Working…'), lines: [], buttons: []});
    executePlan(plan).then(results => this._renderActionResult(results, trace));
  }

  _renderActionResult(results, trace = null) {
    const lines = [];
    let heading = '';
    const single = results.length === 1;
    const step = results[0].step;
    if (single && step.action.risk === 'read-only') {
      heading = step.action.title(step.args).replace(/^Check /, '');
      lines.push(results[0].message);
    } else {
      for (const result of results)
        lines.push(`${result.ok ? '✓' : '✗'} ${result.message}`);
      if (!single && results.some(result => !result.ok))
        heading = _('Plan stopped at the first failure');
    }
    const allOk = results.every(result => result.ok);
    if (trace && trace.status === 'open')
      finishTrace(trace, allOk ? 'complete' : 'failed', `${heading} — ${lines.join(' | ')}`);
    // The palette may have closed while the action ran: the trace above is
    // still recorded, but no result view may be rendered into a closed or
    // reused palette.
    if (!this._isOpen || this._mode === 'action-confirm')
      return;
    const buttons = [];
    const copyable = single && step.action.risk === 'read-only' && results[0].ok;
    if (copyable)
      buttons.push([_('Copy'), () => this._copyActionText(results[0].message), true]);
    buttons.push([_('Done'), () => this.close(), true]);
    this._mode = 'action-result';
    this._showActionView({heading, lines, buttons});
  }

  /* ---------------------------------------------------------------- */
  /* Developer action diagnostics (hidden command: "gdi diagnostics"). */
  /* ---------------------------------------------------------------- */

  _showActionDiagnostics() {
    this._mode = 'action-result';
    const summary = diagnosticsSummary();
    const traces = localDiagnostics().slice().reverse();
    const lines = [
      `Invocations: ${summary.total} · complete ${summary.complete} · failed ${summary.failed} · cancelled ${summary.cancelled} · invalid model calls ${summary.invalidToolCalls} · model-routed ${summary.modelRouted}`,
      '',
      ...traces.flatMap(trace => {
        const actions = (trace.steps ?? []).map(step =>
          `${step.action}(${Object.entries(step.args ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}) ${step.status}${step.verified === false ? ' UNVERIFIED' : ''} ${step.latencyMs}ms`).join(' + ') || (trace.modelSuggestion ?? '-');
        const line = `${trace.time.slice(11, 19)} [${trace.source}] “${trace.query}” → ${actions} · ${trace.status}${trace.ui ? ` · ${trace.ui}` : ''}${trace.totalMs !== undefined ? ` · ${trace.totalMs}ms` : ''}`;
        return line.length > 240 ? [line.slice(0, 240), '  …'] : [line];
      }).slice(0, 40),
    ];
    if (!traces.length)
      lines.push('No action traces recorded yet in this session.');
    this._showActionView({heading: 'Action Diagnostics', lines, buttons: [
      [_('Copy'), () => {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
          lines.join('\n'));
        this._showActionDiagnostics();
      }, true],
      [_('Reset'), () => {
        clearDiagnostics();
        resetActionDiagnostics();
        this._showActionDiagnostics();
      }, true],
      [_('Close'), () => this.close(), true],
    ]});
    // Model residency is refreshed on demand (diagnostics open), never polled.
    residencyStatus((status, _error) => {
      if (!this._isOpen || this._mode !== 'action-result' ||
          !this._writingContent.get_children().length)
        return;
      const note = new St.Label({
        style_class: 'gdi-context-note', x_expand: true,
        text: residencyLines(status),
      });
      note.clutter_text.line_wrap = true;
      note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      this._writingContent.add_child(note);
      this._schedulePosition();
    });
  }

  _copyActionText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    const copyButton = this._writingControls.get_children().find(button => button.label === _('Copy'));
    if (copyButton)
      copyButton.label = _('Copied');
  }


  _setResults(items, limit = RESULT_LIMIT) {
    this._items = items.slice(0, limit);
    this._selectedIndex = this._items.length > 0 ? 0 : -1;
    this._results.destroy_all_children();

    this._items.forEach((item, index) => {
      const row = new St.Button({
        style_class: 'gdi-result-row popup-menu-item',
        can_focus: false,
        x_expand: true,
      });
      const content = new St.BoxLayout({
        style_class: 'gdi-result-content',
        vertical: false,
        x_expand: true,
      });
      content.add_child(new St.Icon({
        gicon: item.icon ?? new Gio.ThemedIcon({ name: 'application-x-executable' }),
        icon_size: 24,
        style_class: 'gdi-result-icon',
      }));

      const labels = new St.BoxLayout({
        style_class: 'gdi-result-labels',
        vertical: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const title = new St.Label({
        style_class: 'gdi-result-title',
        text: item.name,
        x_expand: true,
      });
      title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      labels.add_child(title);

      const description = item.type === 'file' ? item.description : null;
      if (description) {
        const detail = new St.Label({
          style_class: 'gdi-result-description',
          text: description,
          x_expand: true,
        });
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labels.add_child(detail);
        row.add_style_class_name('gdi-result-row-with-detail');
      }
      content.add_child(labels);

      const typeLabel = new St.Label({
        style_class: 'gdi-result-type',
        text: item.suggested ? _('Suggested') : this._getTypeLabel(item.type),
        y_align: Clutter.ActorAlign.CENTER,
      });
      typeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      content.add_child(typeLabel);

      row.set_child(content);
      row.connect('clicked', () => this._activateItem(index));
      if (this._animationsEnabled)
        row.opacity = 0;
      this._results.add_child(row);
      if (index === this._selectedIndex)
        row.add_style_pseudo_class('focus');
      if (this._animationsEnabled) {
        row.ease({
          opacity: 255,
          duration: RESULT_FADE_DURATION,
          delay: Math.min(index * 10, 40),
          mode: Clutter.AnimationMode.EASE_OUT,
        });
      }
    });

    this._scrollView.visible = this._items.length > 0;
    this._schedulePosition();
  }

  _clearResults() {
    this._items = [];
    this._selectedIndex = -1;
    this._results.destroy_all_children();
    this._scrollView.hide();
  }

  _stopStream() {
    this._disposeStream?.();
    this._disposeStream = null;
    this._streamRenderer?.destroy();
    this._streamRenderer = null;
    this._streamTailLabel = null;
    if (this._streamTimer) GLib.source_remove(this._streamTimer);
    this._streamTimer = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Intelligence processing animation.                                 */
  /* ---------------------------------------------------------------- */

  _startProcessing() {
    this._stopProcessing();
    const processing = new St.BoxLayout({
      style_class: 'gdi-processing', x_expand: true,
    });
    processing.add_child(new St.Icon({
      gicon: this._intelligenceIcon, icon_size: 14, style_class: 'gdi-processing-mark',
    }));
    const dots = ['·', '·', '·'].map(() => {
      const dot = new St.Label({text: '·', style_class: 'gdi-processing-dot'});
      processing.add_child(dot);
      return dot;
    });
    this._writingContent.add_child(processing);
    this._processing = processing;
    if (!this._animationsEnabled) {
      dots.forEach(dot => { dot.opacity = 200; });
      return;
    }
    let phase = 0;
    const pulse = () => {
      if (!this._processing)
        return GLib.SOURCE_REMOVE;
      dots.forEach((dot, index) => {
        dot.opacity = index === phase % 3 ? 255 : 90;
      });
      phase += 1;
      return GLib.SOURCE_CONTINUE;
    };
    dots[0].opacity = 255;
    this._processingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 320, pulse);
  }

  _stopProcessing() {
    if (this._processingTimer) {
      GLib.source_remove(this._processingTimer);
      this._processingTimer = 0;
    }
    this._processing?.destroy();
    this._processing = null;
  }

  _showCaptureStatus(context) {
    // Never silently swallow a capture result: report why selected-text tools
    // are unavailable, while launcher and Ask stay fully usable.
    let note = '';
    if (context?.captureError)
      note = _('GDI intelligence service is unavailable. Search and launch still work.');
    else if (context?.capabilities) {
      const caps = context.capabilities;
      if (caps.reason === 'protected-field')
        note = _('This field is protected; GDI does not read it.');
      else if (caps.reason === 'no-readable-selection' || caps.reason === 'not-editable')
        note = _('Selected text could not be read here. Ask and search still work.');
    }
    this._launcherNote.text = note;
    this._launcherNote.visible = Boolean(note);
    if (note)
      this._schedulePosition();
  }

  _resetWritingState() {
    this._stopStream();
    this._stopProcessing();
    this._conversation = [];
    this._requestHistory = [];
    this._conversationId = null;
    this._submenu = null;
    this._historyConversation = null;
    this._historyClearArmed = false;
    this._followup.hide();
    this._launcherNote.hide();
    this._pendingPlan = null;
    if (this._mode === 'writing-loading' && this._writingContext)
      cancelTransform(this._writingContext.token);
    this._writingGeneration++;
    this._mode = 'launcher';
    this._writingContext = null;
    this._writingAction = null;
    this._writingQuestion = '';
    this._lastTransform = null;
    this._writingSuggestion = '';
    this._undoAvailable = false;
    this._editPending = false;
    this._writingView.hide();
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._searchRow.show();
    this._palette.remove_style_class_name('gdi-ai-mode');
    this._entry.hint_text = _('Ask, search, or open…');
    this._searchIcon.gicon = this._intelligenceIcon;
  }

  /* ---------------------------------------------------------------- */
  /* Compact contextual Writing Tools surface.                          */
  /* ---------------------------------------------------------------- */

  _showWritingActions() {
    if (!this._writingContext?.selected)
      return;
    this._mode = 'writing-actions';
    this._submenu = null;
    this._searchRow.show();
    this._writingView.show();
    this._launcherNote.hide();
    this._entry.hint_text = _('Writing tools for selected text');
    this._searchIcon.gicon = this._intelligenceIcon;
    this._entry.set_text('');
    this._clearResults();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    const preview = this._writingContext.selected.replace(/\s+/g, ' ').trim();
    if (preview) {
      const label = new St.Label({
        style_class: 'gdi-writing-preview', x_expand: true,
        text: preview.slice(0, 160) + (preview.length > 160 ? '…' : ''),
      });
      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      this._writingContent.add_child(label);
    }
    this._renderWritingChips(writingMenuFor({
      selected: true, capabilities: this._writingContext.capabilities,
    }));
    this._schedulePosition();
  }

  _showContextualWritingActions() {
    this._mode = 'writing-actions';
    this._submenu = null;
    this._searchRow.show();
    this._writingView.show();
    this._launcherNote.hide();
    this._entry.hint_text = _('Writing tools for this field');
    this._searchIcon.gicon = this._intelligenceIcon;
    this._entry.set_text('');
    this._clearResults();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    const note = new St.Label({
      text: _('No selection. Actions use the sentence or paragraph at the caret.'),
      style_class: 'gdi-context-note', x_expand: true,
    });
    note.clutter_text.line_wrap = true;
    note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this._writingContent.add_child(note);
    this._renderWritingChips(writingMenuFor({
      selected: false, capabilities: this._writingContext?.capabilities ?? null,
    }));
    this._schedulePosition();
  }

  _renderWritingChips(items) {
    this._currentMenuItems = items;
    this._writingControls.destroy_all_children();
    this._writingControls.vertical = false;
    for (const item of items) {
      const button = new St.Button({
        style_class: 'button flat gdi-writing-chip',
        label: _(item.label),
        can_focus: true,
      });
      button.connect('clicked', () => this._activateWritingMenuItem(item));
      this._writingControls.add_child(button);
    }
    if (this._submenu) {
      const back = new St.Button({
        style_class: 'button flat gdi-writing-chip gdi-writing-chip-back',
        label: _('Back'), can_focus: true,
      });
      back.connect('clicked', () => {
        this._submenu = null;
        this._showWritingMenuRoot();
      });
      this._writingControls.add_child(back);
    }
    this._schedulePosition();
    const first = this._writingControls.get_first_child();
    if (first)
      global.stage.set_key_focus(first);
  }

  _showWritingMenuRoot() {
    const items = writingMenuFor({
      selected: Boolean(this._writingContext?.selected),
      capabilities: this._writingContext?.capabilities ?? null,
    });
    this._writingContent.destroy_all_children();
    if (this._writingContext?.selected) {
      const preview = this._writingContext.selected.replace(/\s+/g, ' ').trim();
      const label = new St.Label({
        style_class: 'gdi-writing-preview', x_expand: true,
        text: preview.slice(0, 160) + (preview.length > 160 ? '…' : ''),
      });
      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      this._writingContent.add_child(label);
    } else {
      const note = new St.Label({
        text: _('No selection. Actions use the sentence or paragraph at the caret.'),
        style_class: 'gdi-context-note', x_expand: true,
      });
      note.clutter_text.line_wrap = true;
      note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      this._writingContent.add_child(note);
    }
    this._renderWritingChips(items);
  }

  _activateWritingMenuItem(item) {
    if (item.key === 'tone' || item.key === 'more') {
      this._submenu = item.key;
      this._renderWritingChips(item.children ?? []);
      return;
    }
    this._submenu = null;
    if (this._writingContext?.selected) {
      this._selectWritingAction({...item, actionLabel: _(item.label)});
      return;
    }
    this._startContextualAction(item);
  }

  _startContextualAction(item) {
    if (!this._writingContext && !this._targetWindow) {
      this._showContextualError(_('No supported editable field was captured. Select text or click into an editor.'));
      return;
    }
    this._writingAction = {key: item.key, label: _(item.label), contextual: true, scope: item.scope ?? 'sentence'};
    // Questions need an answer before any capture happens.
    if (item.key === 'ask' || item.key === 'translate') {
      if (item.key === 'ask')
        this._prewarmAssistant();
      this._enterQuestionPrompt(item.key === 'translate'
        ? _('Translate into which language?')
        : _('Ask about the text at the caret…'));
      return;
    }
    this._captureThenStart(item.key === 'continue' ? 'continue' : item.scope ?? 'sentence', '');
  }

  _captureThenStart(kind, question) {
    const pid = this._targetWindow?.get_pid() ?? 0;
    captureCaretContext(pid, kind, (reply, error) => {
      if (!this._isOpen)
        return;
      if (error || !reply?.[0] || !reply[1]) {
        // Never a silent no-op: explain and stay on the contextual surface.
        this._showContextualError(error
          ? errorMessage(error)
          : _('The text at the caret could not be read here.'));
        return;
      }
      releaseContext(this._writingContext?.token);
      const [token, selected, nearby, application, role, start, end, caret, editable] = reply;
      let capabilities = null;
      try { capabilities = JSON.parse(reply[9] ?? 'null'); } catch { capabilities = null; }
      this._writingContext = {
        token, selected, nearby, application, role, start, end, caret, editable,
        capabilities, insert: kind === 'continue',
      };
      recordSignal(token, this._writingAction?.key ?? 'rewrite', 'action_selected',
        this._learningEnabled());
      this._startWritingRequest(this._writingAction, question);
    });
  }

  _showContextualError(message) {
    this._mode = 'writing-actions';
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    const label = new St.Label({text: message, style_class: 'gdi-writing-error', x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this._writingContent.add_child(label);
    this._renderWritingChips(this._currentMenuItems ?? []);
    this._schedulePosition();
  }

  /* ---------------------------------------------------------------- */
  /* Intelligence history: local, grouped, resumable conversations.     */
  /* ---------------------------------------------------------------- */

  _showHistoryList() {
    releaseContext(this._writingContext?.token);
    this._writingContext = null;
    this._historyConversation = null;
    this._historyClearArmed = false;
    this._mode = 'history-list';
    this._searchRow.hide();
    this._clearResults();
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._followup.hide();
    this._writingView.show();
    this._writingScroll.show();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._addWritingHeading(_('Intelligence History'));
    this._addWritingButton(_('Clear All'), () => this._clearAllHistory(), true);
    this._addWritingButton(_('Close'), () => this.close(), true);
    const loading = new St.Label({text: _('Loading…'), style_class: 'gdi-context-note', x_expand: true});
    this._writingContent.add_child(loading);
    this._schedulePosition();
    historyList().then(conversations => {
      if (!this._isOpen || this._mode !== 'history-list')
        return;
      this._historyItems = (conversations ?? []).slice(0, HISTORY_LIST_LIMIT);
      this._renderHistoryRows();
    }).catch(() => {
      if (!this._isOpen || this._mode !== 'history-list')
        return;
      this._writingContent.destroy_all_children();
      const note = new St.Label({
        text: _('History is unavailable right now.'), style_class: 'gdi-writing-error', x_expand: true,
      });
      note.clutter_text.line_wrap = true;
      note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      this._writingContent.add_child(note);
      this._schedulePosition();
    });
  }

  _renderHistoryRows() {
    this._writingContent.destroy_all_children();
    this._addWritingHeading(_('Intelligence History'));
    const groups = historyGroups(this._historyItems);
    let shown = 0;
    for (const label of HISTORY_LABELS) {
      const conversations = groups[label] ?? [];
      if (!conversations.length)
        continue;
      this._writingContent.add_child(new St.Label({
        text: _(label), style_class: 'gdi-history-group', x_expand: true,
      }));
      for (const conversation of conversations) {
        const row = new St.Button({
          style_class: 'button flat gdi-history-row', can_focus: true, x_expand: true,
        });
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const title = new St.Label({
          text: conversation.title, style_class: 'gdi-history-title', x_expand: true,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const detail = new St.Label({
          text: `${conversation.messageCount} ${conversation.messageCount === 1 ? 'message' : 'messages'} · ${conversation.preview}`,
          style_class: 'gdi-history-detail', x_expand: true,
        });
        detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(title);
        box.add_child(detail);
        row.set_child(box);
        row.connect('clicked', () => this._openHistoryConversation(conversation.id));
        this._writingContent.add_child(row);
        shown += 1;
      }
    }
    if (!shown) {
      this._writingContent.add_child(new St.Label({
        text: _('No saved conversations yet.'), style_class: 'gdi-context-note', x_expand: true,
      }));
    }
    this._schedulePosition();
    const first = this._writingControls.get_first_child();
    if (first)
      global.stage.set_key_focus(first);
  }

  _openHistoryConversation(id) {
    historyGet(id).then(conversation => {
      if (!this._isOpen || !conversation?.id)
        return;
      this._mode = 'history-conversation';
      this._historyConversation = conversation;
      this._writingContent.destroy_all_children();
      this._writingControls.destroy_all_children();
      this._addWritingHeading(conversation.title || _('Conversation'));
      for (const message of conversation.messages ?? []) {
        if (message.role === 'user') {
          const label = new St.Label({
            style_class: 'gdi-ask-question', x_expand: true, text: message.content,
          });
          label.clutter_text.line_wrap = true;
          label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
          label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
          this._writingContent.add_child(label);
        } else {
          addMarkdown(this._writingContent, message.content);
        }
      }
      // Continuing resumes the same persisted conversation; the loaded turns
      // also become the bounded RAM context for the next model request.
      this._conversation = (conversation.messages ?? [])
        .map(message => ({role: message.role, content: String(message.content).slice(0, 4000)}));
      while (this._conversation.length > 6 ||
             this._conversation.reduce((n, turn) => n + turn.content.length, 0) > 6000)
        this._conversation.shift();
      this._conversationId = conversation.id;
      this._addWritingButton(_('Continue'), () => {
        this._followup.show();
        global.stage.set_key_focus(this._followup);
        this._schedulePosition();
      }, false);
      this._addWritingButton(_('Rename'), () => this._startHistoryRename(), true);
      this._addWritingButton(_('Delete'), () => {
        historyDelete(id).then(() => {
          if (this._isOpen && (this._mode === 'history-conversation' || this._mode === 'history-list'))
            this._showHistoryList();
        }).catch(() => {
          if (this._isOpen)
            this._showHistoryList();
        });
      }, true);
      this._addWritingButton(_('Back'), () => this._showHistoryList(), true);
      this._followup.show();
      this._schedulePosition();
      const first = this._writingControls.get_first_child();
      if (first)
        global.stage.set_key_focus(first);
    }).catch(() => {
      if (this._isOpen && this._mode === 'history-conversation')
        this._showHistoryList();
    });
  }

  _startHistoryRename() {
    if (!this._historyConversation)
      return;
    this._mode = 'history-rename';
    this._entry.hint_text = _('New title…');
    this._entry.set_text(this._historyConversation.title ?? '');
    this._clearResults();
    global.stage.set_key_focus(this._entry);
    this._schedulePosition();
  }

  _clearAllHistory() {
    if (!this._historyClearArmed) {
      this._historyClearArmed = true;
      const button = this._writingControls.get_children().find(child => child.label === _('Clear All'));
      if (button)
        button.label = _('Really clear all?');
      return;
    }
    this._historyClearArmed = false;
    historyClear((_reply, _error) => {
      if (this._isOpen && this._mode === 'history-list') {
        this._historyItems = [];
        this._renderHistoryRows();
      }
    });
    const button = this._writingControls.get_children().find(child => child.label === _('Really clear all?'));
    if (button)
      button.label = _('Clear All');
  }

  _selectWritingAction(item) {
    if (!this._writingContext?.selected)
      return;
    this._writingAction = {key: item.key, label: item.actionLabel ?? _(item.label)};
    this._writingQuestion = '';
    recordSignal(this._writingContext.token, item.key, 'action_selected',
      this._learningEnabled());

    if (item.key === 'ask' || item.key === 'translate') {
      if (item.key === 'ask')
        this._prewarmAssistant();
      this._enterQuestionPrompt(item.key === 'translate'
        ? _('Translate into which language?')
        : _('Ask a question about this selection…'));
      return;
    }

    this._startWritingRequest(this._writingAction, '');
  }

  _enterQuestionPrompt(hint) {
    this._mode = 'writing-question';
    this._entry.hint_text = hint;
    this._entry.set_text('');
    this._clearResults();
    this._writingView.hide();
    this._searchRow.show();
    global.stage.set_key_focus(this._entry);
    this._schedulePosition();
  }

  _startWritingRequest(action, question) {
    // Async body errors must surface as a visible failed state, never as a
    // rejected promise nobody awaits.
    return this._runWritingRequest(action, question).catch(error => {
      console.warn(`GDI writing request failed: ${error.message}\n${error.stack}`);
      this._renderWritingResult('', errorMessage(error));
    });
  }

  async _runWritingRequest(action, question) {
    if (!action || (!this._writingContext?.selected && !(this._writingContext?.start >= 0) &&
        action.key !== 'assistant'))
      return;
    if ((action.key === 'ask' || action.key === 'translate') && !question.trim()) {
      // Never a silent no-op: fall back to the question prompt.
      this._writingAction = action;
      this._enterQuestionPrompt(action.key === 'translate'
        ? _('Translate into which language?')
        : _('Ask a question about this selection…'));
      return;
    }
    if (this._mode === 'writing-loading' && !this._disposeStream) cancelTransform(this._writingContext?.token);
    this._stopStream();
    this._followup.hide();
    this._followup.set_text('');
    this._writingAction = action;

    this._mode = 'writing-loading';
    this._writingQuestion = question.trim();
    this._lastTransform = { action, question: this._writingQuestion };
    this._writingGeneration++;
    const generation = this._writingGeneration;
    this._searchRow.hide();
    this._clearResults();
    this._submenu = null;
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._writingScroll.show();
    this._writingView.show();
    this._addWritingHeading(action.actionLabel ?? _(action.label));
    this._addContextNotice();
    // No raw Markdown or "Generating…" text while waiting: a small native
    // processing animation holds the surface until real content arrives.
    this._startProcessing();
    this._addWritingButton(_('Cancel'), () => {
      cancelTransform(this._writingContext?.token);
      this._stopStream();
      this._stopProcessing();
      this._writingGeneration++;
      this._renderWritingResult('', _('Generation cancelled.'));
    }, true);
    global.stage.set_key_focus(this._writingControls.get_first_child());
    this._positionPalette();
    this._streamText = '';

    // Every Ask interaction belongs to a conversation. The user turn is
    // stored when the question is submitted; the service stores the answer
    // on completion. History stays local, and a failure never blocks the
    // request — it only means the turn is not persisted.
    let conversationId = '';
    if (isResponse(action.key) && this._historyEnabled()) {
      try {
        if (!this._conversationId)
          this._conversationId = await historyStart(this._settings.get_string('model-assistant'));
        conversationId = this._conversationId ?? '';
        if (conversationId && this._writingQuestion) {
          historyAdd(conversationId, 'user', this._writingQuestion).catch(() =>
            recordActionDiagnostic({kind: 'history', conversation: conversationId,
              role: 'user', status: 'failed'}));
        }
      } catch {
        this._conversationId = null;
        conversationId = '';
      }
    }
    if (!this._isOpen || generation !== this._writingGeneration)
      return;

    const request = {
      token: this._writingContext?.token ?? GLib.uuid_string_random(),
      action: action.key,
      selected: this._writingContext?.selected ?? '',
      nearby: this._writingContext?.nearby ?? '',
      question: this._writingQuestion,
      provider: this._settings.get_string('model-provider'),
      endpoint: this._settings.get_string('model-endpoint'),
      quickModel: this._settings.get_string('model-quick-writing'),
      intentModel: this._settings.get_string('model-intent-routing'),
      assistantModel: this._settings.get_string('model-assistant'),
      reasoningModel: this._settings.get_string('model-reasoning'),
      timeout: this._settings.get_int('request-timeout'),
      contextTokens: this._settings.get_int('context-tokens'),
      outputTokens: this._settings.get_int('output-tokens'),
      history: isResponse(action.key) ? this._requestHistory ?? [] : [],
      conversationId,
    };
    const completed = (reply, error) => {
      if (!this._isOpen || generation !== this._writingGeneration)
        return;
      if (error) {
        this._renderWritingResult('', errorMessage(error));
        return;
      }
      this._writingSuggestion = reply[0];
      if (isResponse(action.key)) {
        this._conversation = [...request.history, {role: 'user', content: question || action.label},
          {role: 'assistant', content: reply[0].slice(0, 4000)}];
        while (this._conversation.length > 6 || this._conversation.reduce((n, t) => n + t.content.length, 0) > 6000)
          this._conversation.shift();
      }
      this._renderWritingResult(this._writingSuggestion, '');
    };
    if (isResponse(action.key)) {
      this._disposeStream = streamTransform(request, delta => {
        if (!this._isOpen || generation !== this._writingGeneration) return;
        // First real content arrived: leave the processing animation.
        this._stopProcessing();
        this._streamText = (this._streamText + delta).slice(0, 20000);
        if (this._streamTimer) return;
        this._streamTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
          this._streamTimer = 0;
          if (!this._isOpen || generation !== this._writingGeneration) return GLib.SOURCE_REMOVE;
          if (!this._streamRenderer)
            this._streamRenderer = new StreamRenderer(this._writingContent);
          this._streamRenderer.update(this._streamText);
          this._schedulePosition();
          return GLib.SOURCE_REMOVE;
        });
      }, completed);
    } else transform(request, completed);
  }

  _addContextNotice() {
    if (this._writingContext?.selected)
      this._writingContent.add_child(new St.Label({text: _('Using selected text and nearby context'), style_class: 'gdi-context-note'}));
    if (!this._writingContext?.selected && this._writingContext?.editable && this._writingContext.start >= 0)
      this._writingContent.add_child(new St.Label({text: _('Insert available at the original caret · text stays local'), style_class: 'gdi-context-note'}));
    if (this._writingContext && !this._writingContext.selected && isResponse(this._writingAction.key) &&
        this._writingAction.key === 'ask')
      this._writingContent.add_child(new St.Label({text: _('No selected text was readable here; answering from general knowledge'), style_class: 'gdi-context-note'}));
    if (this._requestHistory?.length)
      this._writingContent.add_child(new St.Label({text: _('Using this temporary conversation'), style_class: 'gdi-context-note'}));
  }

  _renderWritingResult(suggestion, error) {
    this._stopStream();
    this._stopProcessing();
    this._followup.hide();
    this._mode = error ? 'writing-error' : 'writing-result';
    this._searchRow.hide();
    this._clearResults();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._writingView.show();
    this._writingScroll.show();

    this._addWritingHeading(error ? _('Intelligence') : _(this._writingAction.label));
    if (error) {
      const message = new St.Label({
        style_class: 'gdi-writing-error',
        text: error,
        x_expand: true,
      });
      message.clutter_text.line_wrap = true;
      message.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      this._writingContent.add_child(message);
    }
    const response = isResponse(this._writingAction.key);
    if (response && this._writingQuestion) {
      // The user's own question stays visible but subdued above the answer.
      const asked = new St.Label({
        style_class: 'gdi-ask-question', x_expand: true,
        text: this._writingQuestion.replace(/\s+/g, ' ').slice(0, 200),
      });
      asked.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      this._writingContent.add_child(asked);
    }
    this._addContextNotice();
    if (suggestion) {
      if (response) addMarkdown(this._writingContent, suggestion);
      else addDiff(this._writingContent, this._writingContext.selected, suggestion);
    }
    const capabilityNote = this._capabilityNotice();
    if (capabilityNote)
      this._writingContent.add_child(new St.Label({text: capabilityNote, style_class: 'gdi-context-note'}));
    if (suggestion && response)
      this._addWritingButton(_('Copy'), () => this._copyWritingResult(), true);
    if (suggestion && !error && this._isReplaceable(this._writingAction.key))
      this._addWritingButton(!this._writingContext.selected || this._writingContext.insert
        ? _('Insert at caret')
        : response ? _('Replace selection') : _('Replace'), () => this._replaceWritingSelection(), response);
    if (suggestion && !response)
      this._addWritingButton(_('Copy'), () => this._copyWritingResult(), true);
    if (error && this._writingContext?.selected) {
      this._addWritingButton(_('Copy original'), () => St.Clipboard.get_default().set_text(
        St.ClipboardType.CLIPBOARD, this._writingContext.selected), true);
    }
    if (!error || !suggestion) this._addWritingButton(_('Retry'), () => {
      if (response && this._conversationId)
        historyTrim(this._conversationId, 'assistant').catch(() => {});
      this._startWritingRequest(this._writingAction, this._writingQuestion);
    }, true);
    if (error && !suggestion && error !== _('Generation cancelled.')) this._addWritingButton(_('AI Settings'), () => { this.close(); this._openSettings(); }, true);
    this._addWritingButton(response ? _('Clear') : _('Cancel'), () => {
      if (!response) { this.close(); return; }
      releaseContext(this._writingContext?.token);
      this._resetWritingState();
      this._clearResults();
      this._entry.set_text('');
      global.stage.set_key_focus(this._entry);
      this._positionPalette();
    }, true);
    if (response && suggestion && !error) this._followup.show();
    this._positionPalette();
    const firstButton = this._writingControls.get_first_child();
    if (firstButton)
      global.stage.set_key_focus(firstButton);
  }

  _addWritingHeading(text) {
    const heading = new St.BoxLayout({ style_class: 'gdi-writing-header', x_expand: true });
    heading.add_child(new St.Icon({ gicon: this._intelligenceIcon, icon_size: 18 }));
    const label = new St.Label({
      style_class: 'gdi-writing-heading', text, x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    heading.add_child(label);
    this._writingContent.add_child(heading);
  }

  _addPreviewSection(title, text, original = false) {
    const section = new St.BoxLayout({
      style_class: original ? 'gdi-writing-section gdi-writing-original' : 'gdi-writing-section',
      vertical: true,
      x_expand: true,
    });
    section.add_child(new St.Label({
      style_class: 'gdi-writing-section-title',
      text: title,
    }));
    const label = new St.Label({
      style_class: 'gdi-writing-text',
      text,
      opacity: original ? 190 : 255,
      x_expand: true,
    });
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    section.add_child(label);
    this._writingContent.add_child(section);
  }

  _addWritingButton(label, action, flat = false) {
    const button = new St.Button({
      style_class: flat ? 'button flat gdi-writing-button' : 'button default gdi-writing-button',
      label,
      can_focus: true,
      x_expand: false,
    });
    button.connect('clicked', action);
    this._writingControls.add_child(button);
  }

  _isReplaceable(action) {
    // The service's capability snapshot decides; a false editable flag there
    // can only be a stale or unsupported target, never a silent no-op.
    return this._writingContext?.editable === true && (Boolean(this._writingContext?.selected) || this._writingContext?.start >= 0);
  }

  _historyEnabled() {
    try {
      return this._settings.get_boolean('save-intelligence-history');
    } catch (_error) {
      return false;
    }
  }

  _capabilityNotice() {
    const caps = this._writingContext?.capabilities;
    if (!caps)
      return '';
    if (caps.canReplaceSelection)
      return '';
    if (caps.canReadSelection && this._writingContext?.selected)
      return _('This text can be read but not replaced here. Use Copy to paste it yourself.');
    return '';
  }

  _replaceWritingSelection(retried = false) {
    if (!this._writingContext || !this._writingSuggestion || this._editPending)
      return;
    this._editPending = true;
    const context = this._writingContext;
    const generation = this._writingGeneration;
    this._writingControls.reactive = false;
    const replace = () => replaceSelection(context.token, this._writingSuggestion, this._learningEnabled(),
      (reply, error) => {
        if (!this._isOpen || generation !== this._writingGeneration)
          return;
        if (!this._modalGrab) {
          try { this._modalGrab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.ALL}); }
          catch { this.close(); return; }
          if (!this._modalGrab) { this.close(); return; }
        }
        this._editPending = false;
        this._writingControls.reactive = true;
        if (error) {
          // A vanished/failed service mid-request is harmless to retry once via
          // a fresh capture; only a still-valid refusal becomes a visible error.
          if (!retried && this._targetWindow) {
            const pid = this._targetWindow.get_pid();
            captureFocusedContext(pid, (fresh, captureError) => {
              if (!this._isOpen || generation !== this._writingGeneration)
                return;
              if (captureError || !fresh?.[0] || fresh[1] !== this._writingSuggestion && fresh[1] !== context.selected) {
                this._renderWritingResult(this._writingSuggestion, errorMessage(error));
                return;
              }
              this._writingContext = {
                ...context, token: fresh[0], selected: fresh[1], nearby: fresh[2],
                application: fresh[3], role: fresh[4], start: fresh[5], end: fresh[6],
                caret: fresh[7], editable: fresh[8],
              };
              this._replaceWritingSelection(true);
            });
            return;
          }
          this._renderWritingResult(this._writingSuggestion, errorMessage(error));
          return;
        }
        if (!reply[0]) {
          this._renderWritingResult(this._writingSuggestion, reply[1]);
          return;
        }
        this._undoAvailable = true;
        this._renderReplacementComplete(reply[1]);
      });
    if (context.selected && !context.insert) { replace(); return; }
    // A Shell modal grab temporarily removes Wayland keyboard focus from the
    // editor. Release it before insertion so AT-SPI can verify the focused field.
    // Never activate a different window or synthesize a key to restore focus.
    if (!this._targetWindow || (global.display.focus_window && global.display.focus_window !== this._targetWindow)) {
      this._editPending = false;
      this._renderWritingResult(this._writingSuggestion, _('The focused application changed. Nothing was inserted.'));
      return;
    }
    if (this._modalGrab) { Main.popModal(this._modalGrab); this._modalGrab = null; }
    this._insertFocusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 75, () => {
      this._insertFocusTimer = 0;
      if (!this._isOpen || generation !== this._writingGeneration) return GLib.SOURCE_REMOVE;
      if (global.display.focus_window !== this._targetWindow) { this.close(); return GLib.SOURCE_REMOVE; }
      replace();
      return GLib.SOURCE_REMOVE;
    });
  }

  _renderReplacementComplete(message) {
    this._mode = 'writing-done';
    this._searchRow.hide();
    this._clearResults();
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._writingScroll.show();
    this._writingView.show();
    this._followup.hide();
    this._addWritingHeading(this._writingContext?.selected ? _('Text replaced') : _('Text inserted'));
    const note = new St.Label({
      style_class: 'gdi-writing-text',
      text: message,
      x_expand: true,
    });
    note.clutter_text.line_wrap = true;
    note.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    this._writingContent.add_child(note);
    if (this._undoAvailable)
      this._addWritingButton(_('Undo'), () => this._undoWritingReplacement(), false);
    this._addWritingButton(_('Copy'), () => this._copyWritingResult(), true);
    this._addWritingButton(_('Done'), () => this.close(), true);
    this._positionPalette();
    global.stage.set_key_focus(this._writingControls.get_first_child());
  }

  _undoWritingReplacement() {
    if (!this._writingContext || this._editPending)
      return;
    this._editPending = true;
    const generation = this._writingGeneration;
    undoReplacement(this._writingContext.token, (reply, error) => {
      if (!this._isOpen || generation !== this._writingGeneration)
        return;
      this._editPending = false;
      if (error || !reply[0]) {
        this._undoAvailable = false;
        this._renderReplacementComplete(error
          ? errorMessage(error) : reply[1]);
        return;
      }
      this._undoAvailable = false;
      this._renderReplacementComplete(reply[1]);
    });
  }

  _copyWritingResult() {
    if (!this._writingSuggestion)
      return;
    St.Clipboard.get_default().set_text(
      St.ClipboardType.CLIPBOARD, this._writingSuggestion);
    const copyButton = this._writingControls.get_children().find(button => button.label === _('Copy'));
    if (copyButton)
      copyButton.label = _('Copied');
  }

  _learningEnabled() {
    try {
      return this._settings.get_boolean('enable-learning');
    } catch (_error) {
      return false;
    }
  }

  _getTypeLabel(type) {
    switch (type) {
    case 'app':
      return _('Application');
    case 'file':
      return _('File');
    case 'web':
      return _('Web');
    case 'calc':
      return _('Calculator');
    case 'action':
      return _('Action');
    case 'action-searching':
      return '';
    case 'history-open':
      return '';
    default:
      return '';
    }
  }

  _onKeyPress(event) {
    const key = event.get_key_symbol();
    if (this._mode === 'history-rename') {
      if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
        const title = this._entry.get_text().trim();
        const id = this._historyConversation?.id;
        if (id && title) {
          historyRename(id, title).then(() => {
            if (!this._isOpen)
              return;
            if (this._historyConversation)
              this._historyConversation.title = title;
            this._openHistoryConversation(id);
          }).catch(() => {});
        }
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }
    if (this._mode === 'writing-question') {
      if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
        const question = this._entry.get_text().trim();
        if (!question)
          return Clutter.EVENT_STOP;
        if (this._writingAction?.contextual && !this._writingContext?.token) {
          this._captureThenStart(this._writingAction.key === 'continue' ? 'continue'
            : this._writingAction.scope ?? 'sentence', question);
          return Clutter.EVENT_STOP;
        }
        this._startWritingRequest(this._writingAction, question);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (this._mode !== 'launcher' && this._mode !== 'writing-actions') {
      if (key === Clutter.KEY_Escape) {
        this.close();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (this._mode === 'writing-actions') {
      // Chip rows: arrows move within the row, Enter activates focus.
      if (key === Clutter.KEY_Left || key === Clutter.KEY_Right) {
        const buttons = this._writingControls.get_children();
        const focus = global.stage.get_key_focus();
        const index = buttons.findIndex(button => button === focus);
        if (buttons.length && index >= 0) {
          const next = (index + (key === Clutter.KEY_Right ? 1 : -1) + buttons.length) % buttons.length;
          global.stage.set_key_focus(buttons[next]);
        }
        return Clutter.EVENT_STOP;
      }
      if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
        const focus = global.stage.get_key_focus();
        if (focus && this._writingControls.contains(focus))
          return Clutter.EVENT_PROPAGATE;
      }
    }

    if (key === Clutter.KEY_Down) {
      this._moveSelection(1);
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Up) {
      this._moveSelection(-1);
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Tab && this._mode === 'launcher' &&
        this._completeSelectedApp())
      return Clutter.EVENT_STOP;
    if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
      if (this._selectedIndex >= 0)
        this._activateItem(this._selectedIndex);
      return Clutter.EVENT_STOP;
    }
    if (key === Clutter.KEY_Escape) {
      this.close();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  _completeSelectedApp() {
    const item = this._items[this._selectedIndex];
    if (item?.type !== 'app')
      return false;

    this._entry.set_text(item.name);
    this._entry.clutter_text.set_cursor_position(-1);
    return true;
  }

  _onOutsidePress(event) {
    if (!this._isOpen)
      return Clutter.EVENT_PROPAGATE;
    // During a modal grab GNOME 46 does not preserve the picked actor on the
    // event (get_source() returns null), so inside/outside is decided from
    // the event's own stage coordinates against the palette's rect. Row and
    // chip buttons never get here: their presses stay on the button actor,
    // and only presses the grab retargets to this overlay — or bubbles from
    // a non-interactive palette area — reach this handler.
    const [x, y] = event.get_coords();
    const [px, py] = this._palette.get_transformed_position();
    const [width, height] = this._palette.get_transformed_size();
    if (x < px || x > px + width || y < py || y > py + height) {
      this.close();
      return Clutter.EVENT_STOP;
    }
    return Clutter.EVENT_PROPAGATE;
  }

  _onCapturedEvent(event) {
    if (!this._isOpen)
      return Clutter.EVENT_PROPAGATE;

    if (event.type() === Clutter.EventType.KEY_PRESS && this._writingView.visible &&
        [Clutter.KEY_Page_Down, Clutter.KEY_Page_Up].includes(event.get_key_symbol())) {
      const adjustment = this._writingScroll.vadjustment;
      adjustment.value = Math.max(adjustment.lower, Math.min(adjustment.upper - adjustment.page_size,
        adjustment.value + (event.get_key_symbol() === Clutter.KEY_Page_Down ? 1 : -1) * adjustment.page_size));
      return Clutter.EVENT_STOP;
    }

    if (event.type() === Clutter.EventType.KEY_PRESS &&
        this._writingView.visible &&
        [Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab].includes(event.get_key_symbol())) {
      const buttons = [...this._writingControls.get_children(),
        ...this._writingContent.get_children().filter(child => child.can_focus),
        ...(this._followup.visible ? [this._followup] : [])];
      if (buttons.length) {
        const focus = global.stage.get_key_focus();
        const current = buttons.findIndex(button => button === focus ||
          (focus && button.contains(focus)));
        const backwards = event.get_key_symbol() === Clutter.KEY_ISO_Left_Tab ||
          (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const next = current < 0 ? (backwards ? buttons.length - 1 : 0)
          : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length;
        global.stage.set_key_focus(buttons[next]);
      }
      return Clutter.EVENT_STOP;
    }

    if (event.type() === Clutter.EventType.KEY_PRESS &&
        event.get_key_symbol() === Clutter.KEY_Escape) {
      // Escape unwinds progressively: submenu → root actions, rename → the
      // conversation, a question prompt → the writing actions, otherwise the
      // palette closes and cancels.
      if (this._mode === 'writing-actions' && this._submenu) {
        this._submenu = null;
        this._showWritingMenuRoot();
        return Clutter.EVENT_STOP;
      }
      if (this._mode === 'history-rename') {
        if (this._historyConversation)
          this._openHistoryConversation(this._historyConversation.id);
        else
          this._showHistoryList();
        return Clutter.EVENT_STOP;
      }
      if (this._mode === 'writing-question' && this._writingContext?.selected) {
        this._showWritingActions();
        return Clutter.EVENT_STOP;
      }
      if (this._mode === 'writing-question' && this._writingAction?.contextual) {
        this._showContextualWritingActions();
        return Clutter.EVENT_STOP;
      }
      this.close();
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _moveSelection(step) {
    if (this._items.length === 0)
      return;
    if (this._selectedIndex < 0)
      this._selectedIndex = 0;
    else
      this._selectedIndex = (this._selectedIndex + step + this._items.length) %
        this._items.length;

    this._results.get_children().forEach((child, index) => {
      if (index === this._selectedIndex) {
        child.add_style_pseudo_class('focus');
        const adjustment = this._scrollView.vadjustment;
        const box = child.get_allocation_box();
        if (box.y1 < adjustment.value)
          adjustment.value = box.y1;
        else if (box.y2 > adjustment.value + adjustment.page_size)
          adjustment.value = box.y2 - adjustment.page_size;
      }
      else
        child.remove_style_pseudo_class('focus');
    });
  }

  _activateItem(index) {
    const item = this._items[index];
    if (!item)
      return;

    if (item.type === 'action-searching')
      return;
    if (item.type === 'history-open') {
      this._showHistoryList();
      return;
    }
    if (item.type === 'action') {
      this._runActionPlan(item.plan);
      return;
    }
    if (item.type === 'selection-intent') {
      if (item.promptOnly) {
        this._writingAction = {key: item.actionKey, label: item.name};
        this._enterQuestionPrompt(_('Ask a question about this selection…'));
        return;
      }
      this._startWritingRequest({key: item.actionKey, label: item.name}, item.query);
      return;
    }
    if (item.type === 'ask') {
      if (!this._writingContext)
        this._writingContext = { token: GLib.uuid_string_random(), selected: '', nearby: '', application: '', role: '', start: -1, end: -1, caret: -1, editable: false };
      if (item.promptOnly) {
        this._writingAction = { key: 'assistant', label: _('Ask Intelligence') };
        this._prewarmAssistant();
        this._enterQuestionPrompt(_('Ask Intelligence…'));
        return;
      }
      this._startWritingRequest({ key: 'assistant', label: _('Ask Intelligence') }, item.query);
      return;
    }

    if (item.type === 'writing-action') {
      this._selectWritingAction(item);
      return;
    }

    this.close();
    const context = global.create_app_launch_context(0, -1);
    try {
      if (item.type === 'app') {
        const trace = beginActionTrace({query: item.name, source: 'launcher-app'});
        const started = GLib.get_monotonic_time();
        recordActionUse('app.open', item.name);
        let launched = false;
        let failure = '';
        try {
          launched = item.appInfo.launch([], context);
          if (!launched)
            failure = `${item.name} could not be launched`;
        } catch (error) {
          failure = error.message;
        }
        finishLauncherTrace(trace, {
          action: 'app.open', target: item.name,
          status: launched ? 'complete' : 'failed',
          message: launched ? `${item.name} launched` : failure,
          latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
        });
        if (!launched)
          Main.notify(_('Could not launch %s').format(item.name));
      } else if (item.type === 'file') {
        const trace = beginActionTrace({query: item.name, source: 'launcher-file'});
        const started = GLib.get_monotonic_time();
        try {
          Gio.AppInfo.launch_default_for_uri(item.file.get_uri(), context);
          finishLauncherTrace(trace, {
            action: 'file.open', target: item.name, status: 'complete',
            message: `${item.name} opened`,
            latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
          });
        } catch (error) {
          finishLauncherTrace(trace, {
            action: 'file.open', target: item.name, status: 'failed',
            message: error.message,
            latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
          });
          Main.notify(_('Could not open %s').format(item.name));
        }
      } else if (item.type === 'web') {
        const trace = beginActionTrace({query: item.query, source: 'launcher-web'});
        const started = GLib.get_monotonic_time();
        const encoded = GLib.uri_escape_string(item.query, null, true);
        try {
          Gio.AppInfo.launch_default_for_uri(
            `https://www.google.com/search?q=${encoded}`, context);
          finishLauncherTrace(trace, {
            action: 'web.search', target: item.query.slice(0, 100), status: 'complete',
            message: 'Web search opened',
            latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
          });
        } catch (error) {
          finishLauncherTrace(trace, {
            action: 'web.search', target: item.query.slice(0, 100), status: 'failed',
            message: error.message,
            latencyMs: Math.round((GLib.get_monotonic_time() - started) / 1000),
          });
          Main.notify(_('Could not open the web search'));
        }
      } else if (item.type === 'calc') {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.value);
        Main.notify(_('Copied result'), item.value);
        const trace = beginActionTrace({query: item.name, source: 'launcher-calc'});
        finishLauncherTrace(trace, {
          action: 'calc.copy', target: item.value.slice(0, 100), status: 'complete',
          message: `Copied ${item.value}`, latencyMs: 0,
        });
      }
    } catch (error) {
      console.error(`GDI action failed: ${error.message}`);
      Main.notify(_('Could not complete action'), error.message);
    }
  }
}
