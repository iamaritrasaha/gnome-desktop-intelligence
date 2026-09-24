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
  actionStats,
  cancelTransform,
  captureFocusedContext,
  errorMessage,
  releaseContext,
  recordSignal,
  recordActionUse,
  replaceSelection,
  transform,
  streamTransform,
  undoReplacement,
} from './src/intelligence/ServiceClient.js';

import { askQueryRemainder, isResponse, preferAssistant, selectionIntent, selectionIntentParts } from './src/intelligence/Presentation.js';
import { addDiff, addMarkdown } from './src/intelligence/ResponseView.js';
import { parseActionPlan, parseFileQuery } from './src/actions/parser.js';
import {
  executePlan,
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

const WRITING_ACTIONS = [
  { key: 'proofread', label: 'Fix grammar' },
  { key: 'rewrite', label: 'Improve writing' },
  { key: 'concise', label: 'Make concise' },
  { key: 'expand', label: 'Expand' },
  { key: 'professional', label: 'Professional' },
  { key: 'casual', label: 'Casual' },
  { key: 'explain', label: 'Explain' },
  { key: 'summarize', label: 'Summarize' },
  { key: 'keypoints', label: 'Key points' },
  { key: 'translate', label: 'Translate' },
  { key: 'ask', label: 'Ask about selection' },
];

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
  }

  toggle() {
    if (this._isOpen)
      this.close();
    else
      this.open();
  }

  get isOpen() {
    return this._isOpen;
  }

  open(context = null) {
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
    if (context?.selected) {
      this._writingContext = context;
      this._showWritingActions();
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
    if (this._mode.startsWith('writing-')) {
      const anchor = this._calculatePlacement(monitor, PALETTE_FIXED_HEIGHT, Main.panel.height);
      const available = monitor.y + monitor.height - BOTTOM_GUTTER - anchor.y;
      this._writingControls.vertical = width < 420;
      const controlsHeight = this._writingControls.get_preferred_height(width - 16)[1];
      const cap = Math.max(40, Math.min(310, available - Math.max(64, controlsHeight + (this._followup.visible ? 64 : 16))));
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
    cancelFileSearch();
    const generation = ++this._queryGeneration;
    const query = this._entry.get_text().trim();

    if (!query) {
      if (this._mode === 'writing-actions') {
        this._setResults(WRITING_ACTIONS.map(action => ({type: 'writing-action', name: _(action.label),
          actionKey: action.key, icon: this._intelligenceIcon})), WRITING_ACTIONS.length);
        return;
      }
      this._clearResults();
      this._schedulePosition();
      return;
    }

    this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
      this._searchTimeoutId = 0;
      if (this._isOpen && generation === this._queryGeneration)
        this._search(query, generation);
      return GLib.SOURCE_REMOVE;
    });
  }

  _search(query, generation) {
    if (this._mode === 'writing-actions') {
      // The typed verb selects the action; only the remainder may reach a model.
      const {action, remainder} = selectionIntentParts(query);
      const label = _(WRITING_ACTIONS.find(a => a.key === action)?.label ?? 'Ask about selection');
      this._setResults([{type: 'selection-intent', name: label,
        query: remainder, actionKey: action, promptOnly: action === 'ask' && !remainder,
        icon: this._intelligenceIcon}]);
      return;
    }
    const webMatch = query.match(/^search\s+(.+)$/i);
    if (webMatch) {
      const term = webMatch[1].trim();
      this._setResults([{
        type: 'web',
        name: _('Search the web for “%s”').format(term),
        icon: new Gio.ThemedIcon({ name: 'web-browser-symbolic' }),
        query: term,
      }]);
      return;
    }

    const calculatorValue = calculateExpression(query);
    if (calculatorValue !== null) {
      this._setResults([{
        type: 'calc',
        name: String(calculatorValue),
        icon: new Gio.ThemedIcon({ name: 'accessories-calculator-symbolic' }),
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
      preparePlan(query).then(plan => {
        if (!this._isOpen || generation !== this._queryGeneration)
          return;
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
      }).catch(() => {
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
      // Deterministic parsing found nothing: the small routing model may map
      // the query to one registered action when it plausibly names a desktop
      // capability. Anything else goes to Ask Intelligence verbatim.
      if (!preferAssistant(query, []) && mayNeedModelRouting(query)) {
        this._startActionSuggestion(query, generation);
        return;
      }
      this._setResults([this._askRow(query)]);
      return;
    }

    this._setResults(apps);
    if (term.length < 2 && !fileOptions?.extension && !fileOptions?.modifiedSince)
      return;

    searchFiles(term, files => {
      if (!this._isOpen || generation !== this._queryGeneration)
        return;
      this._setResults([...apps, ...this._rankFiles(files)].slice(0, RESULT_LIMIT));
    }, RESULT_LIMIT, fileOptions ?? {});
  }

  _askRow(query) {
    return {
      type: 'ask', name: _('Ask Intelligence'),
      query,
      promptOnly: query === '',
      icon: this._intelligenceIcon,
    };
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
    if (!this._learningEnabled()) {
      this._actionRanking = null;
      return;
    }
    actionStats((stats, _error) => {
      if (stats)
        this._actionRanking = stats;
    });
  }

  _startActionSuggestion(query, generation) {
    // Bounded model use: one routing-model request per query, guarded by the
    // search generation. Deterministic actions never enter this path.
    this._setResults([{
      type: 'action-searching',
      name: _('Looking for a matching action…'),
      icon: this._intelligenceIcon,
    }]);
    suggestActionFromModel(query, this._settings).then(suggested => {
      if (!this._isOpen || generation !== this._queryGeneration)
        return;
      if (!suggested) {
        this._setResults([this._askRow(query)]);
        return;
      }
      prepareAction(suggested.id, suggested.args).then(plan => {
        if (!this._isOpen || generation !== this._queryGeneration)
          return;
        if (!plan) {
          this._setResults([this._askRow(query)]);
          return;
        }
        this._setResults([{
          type: 'action',
          name: this._actionPlanName(plan),
          plan,
          suggested: true,
          icon: this._actionIcon(plan.steps[0].action.icon),
        }]);
      }).catch(() => {
        if (this._isOpen && generation === this._queryGeneration)
          this._setResults([this._askRow(query)]);
      });
    }).catch(() => {
      if (this._isOpen && generation === this._queryGeneration)
        this._setResults([this._askRow(query)]);
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
    this._mode = 'action-running';
    this._pendingPlan = null;
    this._showActionView({heading: _('Working…'), lines: [], buttons: []});
    executePlan(plan).then(results => this._renderActionResult(results));
  }

  _renderActionResult(results) {
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
    const buttons = [];
    const copyable = single && step.action.risk === 'read-only' && results[0].ok;
    if (copyable)
      buttons.push([_('Copy'), () => this._copyActionText(results[0].message), true]);
    buttons.push([_('Done'), () => this.close(), true]);
    this._mode = 'action-result';
    this._showActionView({heading, lines, buttons});
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
    if (this._streamTimer) GLib.source_remove(this._streamTimer);
    this._streamTimer = 0;
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
    this._conversation = [];
    this._requestHistory = [];
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

  _showWritingActions() {
    if (!this._writingContext?.selected)
      return;
    this._mode = 'writing-actions';
    this._searchRow.show();
    this._writingView.hide();
    this._launcherNote.hide();
    this._entry.hint_text = _('Writing tools for selected text');
    this._searchIcon.gicon = this._intelligenceIcon;
    this._entry.set_text('');
    this._clearResults();
    this._setResults(WRITING_ACTIONS.map(action => ({
      type: 'writing-action',
      name: _(action.label),
      actionKey: action.key,
      icon: this._intelligenceIcon,
    })), WRITING_ACTIONS.length);
    this._schedulePosition();
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

  _selectWritingAction(item) {
    const action = WRITING_ACTIONS.find(candidate => candidate.key === item.actionKey);
    if (!action || !this._writingContext?.selected)
      return;
    this._writingAction = { ...action, label: _(action.label) };
    this._writingQuestion = '';
    recordSignal(this._writingContext.token, action.key, 'action_selected',
      this._learningEnabled());

    if (action.key === 'ask' || action.key === 'translate') {
      this._enterQuestionPrompt(action.key === 'translate'
        ? _('Translate into which language?')
        : _('Ask a question about this selection…'));
      return;
    }

    this._startWritingRequest(action, '');
  }

  _startWritingRequest(action, question) {
    if (!action || (!this._writingContext?.selected && action.key !== 'assistant'))
      return;
    if ((action.key === 'ask' || action.key === 'translate') && !question.trim()) {
      // Never a silent no-op: fall back to the question prompt.
      this._writingAction = action;
      this._enterQuestionPrompt(action.key === 'translate'
        ? _('Translate into which language?')
        : _('Ask a question about this selection…'));
      return;
    }
    if (this._mode === 'writing-loading' && !this._disposeStream) cancelTransform(this._writingContext.token);
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
    this._palette.add_style_class_name('gdi-ai-mode');
    this._writingContent.destroy_all_children();
    this._writingControls.destroy_all_children();
    this._writingScroll.show();
    this._writingView.show();
    this._addWritingHeading(_('Generating…'));
    this._addContextNotice();
    this._streamText = '';
    this._streamLabel = null;
    this._addWritingButton(_('Cancel'), () => {
      cancelTransform(this._writingContext.token);
      this._stopStream();
      this._writingGeneration++;
      this._renderWritingResult('', _('Generation cancelled.'));
    }, true);
    global.stage.set_key_focus(this._writingControls.get_first_child());
    this._positionPalette();

    const request = {
      token: this._writingContext.token,
      action: action.key,
      selected: this._writingContext.selected,
      nearby: this._writingContext.nearby,
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
        this._streamText = (this._streamText + delta).slice(0, 20000);
        if (this._streamTimer) return;
        this._streamTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
          this._streamTimer = 0;
          if (!this._isOpen || generation !== this._writingGeneration) return GLib.SOURCE_REMOVE;
          if (!this._streamLabel) {
            this._streamLabel = new St.Label({style_class: 'gdi-writing-text', x_expand: true});
            this._streamLabel.clutter_text.line_wrap = true;
            this._streamLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            this._streamLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._writingContent.add_child(this._streamLabel);
          }
          this._streamLabel.text = this._streamText;
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
    this._addContextNotice();
    const response = isResponse(this._writingAction.key);
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
      this._addWritingButton(!this._writingContext.selected ? _('Insert at caret') : response ? _('Replace selection') : _('Replace'), () => this._replaceWritingSelection(), response);
    if (suggestion && !response)
      this._addWritingButton(_('Copy'), () => this._copyWritingResult(), true);
    if (error && this._writingContext?.selected) {
      this._addWritingButton(_('Copy original'), () => St.Clipboard.get_default().set_text(
        St.ClipboardType.CLIPBOARD, this._writingContext.selected), true);
    }
    if (!error || !suggestion) this._addWritingButton(_('Retry'), () => {
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
    if (context.selected) { replace(); return; }
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
    case 'writing-action':
      return '';
    default:
      return '';
    }
  }

  _onKeyPress(event) {
    const key = event.get_key_symbol();
    if (this._mode === 'writing-question') {
      if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
        const question = this._entry.get_text().trim();
        if (!question)
          return Clutter.EVENT_STOP;
        this._startWritingRequest(this._writingAction, question);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    }

    if (this._mode !== 'launcher' && this._mode !== 'writing-actions') {
      if (key === Clutter.KEY_Escape) {
        if (this._mode === 'writing-done') {
          this.close();
          return Clutter.EVENT_STOP;
        }
        this.close();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
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
      // From a question prompt with captured text, Escape returns to the
      // writing actions; otherwise it closes and cancels.
      if (this._mode === 'writing-question' && this._writingContext?.selected) {
        this._showWritingActions();
        return Clutter.EVENT_STOP;
      }
      this.close();
      return Clutter.EVENT_STOP;
    }

    if (event.type() === Clutter.EventType.BUTTON_PRESS) {
      const source = event.get_source();
      if (!source || !this._palette.contains(source)) {
        this.close();
        return Clutter.EVENT_STOP;
      }
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
        recordActionUse('app.open', item.name);
        if (!item.appInfo.launch([], context))
          Main.notify(_('Could not launch %s').format(item.name));
      } else if (item.type === 'file') {
        Gio.AppInfo.launch_default_for_uri(item.file.get_uri(), context);
      } else if (item.type === 'web') {
        const encoded = GLib.uri_escape_string(item.query, null, true);
        Gio.AppInfo.launch_default_for_uri(
          `https://www.google.com/search?q=${encoded}`, context);
      } else if (item.type === 'calc') {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.value);
        Main.notify(_('Copied result'), item.value);
      }
    } catch (error) {
      console.error(`GDI action failed: ${error.message}`);
      Main.notify(_('Could not complete action'), error.message);
    }
  }
}
