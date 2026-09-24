/*
 * File search adapted from Rudra by NarkAgni.
 * Copyright (C) 2026 NarkAgni
 * Copyright (C) 2026 GDI contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_DEPTH = 3;
const MAX_DIRECTORIES = 120;
const SEARCH_TIMEOUT_MS = 3000;

let _activeSearch = null;

export function searchFiles(text, callback, limit = 16) {
  cancelFileSearch();

  const query = text.trim().toLowerCase();
  if (query.length < 2) {
    callback([]);
    return;
  }

  const cancellable = new Gio.Cancellable();
  const homePath = GLib.get_home_dir();
  const home = Gio.File.new_for_path(homePath);
  const results = [];
  const openEnumerators = new Set();
  let pending = 0;
  let visitedDirectories = 0;
  let finished = false;
  let timeoutId = 0;

  const finish = (cancelRemaining = false) => {
    if (finished)
      return;
    finished = true;
    if (timeoutId)
      GLib.source_remove(timeoutId);
    timeoutId = 0;
    if (cancelRemaining) {
      cancellable.cancel();
      for (const enumerator of openEnumerators) {
        try {
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch (_error) {
          // The operation may already have closed while cancellation completed.
        }
      }
      openEnumerators.clear();
    }
    if (_activeSearch === cancellable)
      _activeSearch = null;
    results.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      return Number(bName.startsWith(query)) - Number(aName.startsWith(query)) ||
        aName.localeCompare(bName);
    });
    callback(results);
  };

  const maybeFinish = () => {
    if (!finished && pending === 0)
      finish();
  };

  const closeEnumerator = enumerator => {
    if (!openEnumerators.delete(enumerator))
      return;
    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
  };

  const scanDirectory = (directory, depth) => {
    if (finished || cancellable.is_cancelled() || depth > MAX_DEPTH ||
        visitedDirectories >= MAX_DIRECTORIES || results.length >= limit)
      return;

    visitedDirectories++;
    pending++;
    directory.enumerate_children_async(
      'standard::name,standard::icon,standard::type',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      GLib.PRIORITY_DEFAULT_IDLE,
      cancellable,
      (file, result) => {
        let enumerator;
        try {
          enumerator = file.enumerate_children_finish(result);
        } catch (_error) {
          if (!finished) {
            pending--;
            maybeFinish();
          }
          return;
        }
        if (finished) {
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
          return;
        }
        openEnumerators.add(enumerator);
        readBatch(enumerator, directory, depth);
      },
    );
  };

  const readBatch = (enumerator, directory, depth) => {
    if (finished)
      return;
    if (cancellable.is_cancelled() || results.length >= limit ||
        visitedDirectories >= MAX_DIRECTORIES) {
      closeEnumerator(enumerator);
      pending--;
      maybeFinish();
      return;
    }

    enumerator.next_files_async(24, GLib.PRIORITY_DEFAULT_IDLE, cancellable,
      (currentEnumerator, result) => {
        if (finished)
          return;

        let infos;
        try {
          infos = currentEnumerator.next_files_finish(result);
        } catch (_error) {
          closeEnumerator(currentEnumerator);
          pending--;
          maybeFinish();
          return;
        }

        if (infos.length === 0) {
          closeEnumerator(currentEnumerator);
          pending--;
          maybeFinish();
          return;
        }

        for (const info of infos) {
          if (results.length >= limit)
            break;
          const name = info.get_name();
          if (name.startsWith('.'))
            continue;

          const child = directory.get_child(name);
          if (name.toLowerCase().includes(query)) {
            results.push({
              type: 'file',
              name,
              description: child.get_path().replace(homePath, '~'),
              icon: info.get_icon() ?? new Gio.ThemedIcon({ name: 'text-x-generic' }),
              file: child,
            });
          }

          if (info.get_file_type() === Gio.FileType.DIRECTORY &&
              depth < MAX_DEPTH && visitedDirectories < MAX_DIRECTORIES)
            scanDirectory(child, depth + 1);
        }

        if (results.length >= limit) {
          closeEnumerator(currentEnumerator);
          pending--;
          maybeFinish();
        } else {
          readBatch(currentEnumerator, directory, depth);
        }
      },
    );
  };

  timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_TIMEOUT_MS, () => {
    timeoutId = 0;
    finish(true);
    return GLib.SOURCE_REMOVE;
  });
  _activeSearch = cancellable;
  scanDirectory(home, 0);
}

export function cancelFileSearch() {
  if (_activeSearch) {
    _activeSearch.cancel();
    _activeSearch = null;
  }
}
