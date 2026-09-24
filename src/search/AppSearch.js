/*
 * App search adapted from Rudra by NarkAgni.
 * Copyright (C) 2026 NarkAgni
 * Copyright (C) 2026 GDI contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';

import { fuzzyMatchScore } from './FuzzySearch.js';

const _state = {
  apps: [],
  monitor: null,
  monitorId: 0,
};

function _buildAppCache() {
  _state.apps = [];
  for (const appInfo of Gio.AppInfo.get_all()) {
    const id = appInfo.get_id();
    if (!id)
      continue;

    const isSettingsApp = id.includes('gnome-control-center') ||
      id.includes('org.gnome.settings');
    if (!appInfo.should_show() && !isSettingsApp)
      continue;

    const name = appInfo.get_name() ?? id;
    _state.apps.push({
      type: 'app',
      name,
      searchName: name.toLowerCase(),
      searchId: id.toLowerCase(),
      description: appInfo.get_description() ?? '',
      id,
      icon: appInfo.get_icon(),
      appInfo,
    });
  }
}

function _ensureAppCache() {
  if (_state.monitor)
    return;

  _state.monitor = Gio.AppInfoMonitor.get();
  _state.monitorId = _state.monitor.connect('changed', _buildAppCache);
  _buildAppCache();
}

export function searchApps(text, limit = 8, boosts = {}) {
  _ensureAppCache();
  const query = text.trim().toLowerCase();
  if (!query)
    return [];

  const matches = [];
  for (const app of _state.apps) {
    let score = -1;
    if (app.searchName === query)
      score = 5000;
    else if (app.searchName.startsWith(query))
      score = 3000;
    else if (app.searchName.includes(query))
      score = 2000;
    else if (app.searchId.includes(query))
      score = 1000;
    else if (query.length >= 2)
      score = fuzzyMatchScore(query, app.searchName);

    if (score < 0)
      continue;
    // Opt-in usage learning may reorder within a score tier but can never
    // outrank a stronger deterministic match class.
    const learned = Math.min(Number(boosts[app.id] ?? 0), 8) * 60;
    matches.push({ app, score: score + learned });
  }

  matches.sort((a, b) => b.score - a.score ||
    a.app.searchName.localeCompare(b.app.searchName));
  return matches.slice(0, limit).map(({ app }) => app);
}

export function cleanupAppSearch() {
  if (_state.monitor && _state.monitorId)
    _state.monitor.disconnect(_state.monitorId);
  _state.monitor = null;
  _state.monitorId = 0;
  _state.apps = [];
}
