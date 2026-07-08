// ── Notepad ──────────────────────────────────────────────────────────────────
// Firestore ops live in app.js (window.notepadFs*) where db is in scope.
// localStorage is a per-user cache — shown instantly on open, then merged.

const NOTEPAD_CACHE_PREFIX = 'alipante_notepad_v2_';
let _notes = [];            // working set
let _activeId = null;
let _activeOwner = null;    // owner of the active note — id alone is not unique across users
let _autoSaveTimer = null;
let _handlersReady = false;
let _dirty = false;         // true when editor has unsaved changes
let _selectMode = false;    // bulk-select mode for "My Notes" list
let _selectedIds = new Set(); // ids of selected own notes (owner is always current user)

// ── Username ──────────────────────────────────────────────────────────────────
function _user() { return window._notepadUsername || null; }

// ── Cache ─────────────────────────────────────────────────────────────────────
function _cacheKey() { return NOTEPAD_CACHE_PREFIX + (_user() || 'guest'); }
function _saveCache()  { try { localStorage.setItem(_cacheKey(), JSON.stringify(_notes)); } catch(_){} }
function _loadCache()  { try { return JSON.parse(localStorage.getItem(_cacheKey()) || '[]'); } catch(_){ return []; } }

// ── Firestore via app.js helpers ──────────────────────────────────────────────
async function _fsLoad()         { return window.notepadFsLoad  ? window.notepadFsLoad(_user())         : null; }
async function _fsSave(note)     { return window.notepadFsSave  ? window.notepadFsSave(_user(), note)   : false; }
async function _fsDelete(noteId) { return window.notepadFsDelete? window.notepadFsDelete(_user(), noteId): null; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function _isMine(note) { return note.owner === _user(); }
function _myNotes()     { return _notes.filter(n => _isMine(n)).sort((a, b) => (b.updatedAt||0) - (a.updatedAt||0)); }
function _sharedNotes()  { return _notes.filter(n => n.visibility === 'shared' && !_isMine(n)).sort((a, b) => (b.updatedAt||0) - (a.updatedAt||0)); }
function _sorted() { return _myNotes(); } // legacy alias used by restore/new/delete flows

function _activeNote() { return _notes.find(n => n.id === _activeId && n.owner === _activeOwner); }

function _setDirty(val) {
  _dirty = val;
  const active = _activeNote();
  const btn = document.getElementById('notepad-save-btn');
  if (btn) btn.disabled = !val || (active && !_isMine(active));
}

// Merge remote array into local: newest updatedAt wins per (owner, id)
function _merge(remote) {
  const key = n => (n.owner || _user()) + '::' + n.id;
  const map = new Map(_notes.map(n => [key(n), { ...n }]));
  for (const r of remote) {
    const local = map.get(key(r));
    if (!local || r.updatedAt > (local.updatedAt || 0)) map.set(key(r), r);
  }
  return [...map.values()];
}

function _setStatus(msg) {
  const el = document.getElementById('notepad-save-status');
  if (el) el.textContent = msg;
}

function _renderVisibilityBtn(note) {
  const privateRadio = document.getElementById('notepad-visibility-private');
  const sharedRadio  = document.getElementById('notepad-visibility-shared');
  const group        = document.getElementById('notepad-visibility-group');
  if (!privateRadio || !sharedRadio) return;
  const mine = !note || _isMine(note);
  const shared = !!(note && note.visibility === 'shared');
  privateRadio.checked = !shared;
  sharedRadio.checked  = shared;
  privateRadio.disabled = !mine;
  sharedRadio.disabled  = !mine;
  if (group) group.classList.toggle('is-disabled', !mine);
}

function _renderReadonlyState(note) {
  const banner   = document.getElementById('notepad-readonly-banner');
  const ownerEl  = document.getElementById('notepad-readonly-owner');
  const titleEl  = document.getElementById('notepad-title');
  const bodyEl   = document.getElementById('notepad-body');
  const saveBtn  = document.getElementById('notepad-save-btn');
  const delBtn   = document.getElementById('notepad-delete-btn');
  const readonly = note && !_isMine(note);
  if (banner) banner.style.display = readonly ? '' : 'none';
  if (ownerEl && readonly) ownerEl.textContent = note.owner || 'another user';
  if (titleEl) titleEl.disabled = !!readonly;
  if (bodyEl) bodyEl.disabled = !!readonly;
  if (delBtn) delBtn.disabled = !!readonly;
  if (saveBtn) saveBtn.disabled = !!readonly || !_dirty;
}

// ── Icons (inline SVG — no emoji) ────────────────────────────────────────────
const ICON_GLOBE = '<svg class="notepad-icon notepad-icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9s1.3-6.4 3.8-9z"/></svg>';

// ── Render lists ──────────────────────────────────────────────────────────────
function _renderOneList(listEl, notes, emptyMsg, opts) {
  opts = opts || {};
  if (!listEl) return;
  if (notes.length === 0) {
    listEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:4px 0">' + emptyMsg + '</div>';
    return;
  }
  listEl.innerHTML = '';
  notes.forEach(note => {
    const row = document.createElement('div');
    row.className = 'notepad-list-row';

    if (opts.selectable) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'notepad-select-cb';
      cb.setAttribute('aria-label', 'Select note: ' + (note.title || 'Untitled'));
      cb.checked = _selectedIds.has(note.id);
      cb.addEventListener('change', () => _onToggleSelect(note.id, cb.checked));
      row.appendChild(cb);
    }

    const item = document.createElement('button');
    item.type = 'button';
    const isActive = note.id === _activeId && note.owner === _activeOwner;
    item.className = 'notepad-list-item' + (isActive ? ' active' : '');
    item.setAttribute('aria-label', 'Open note: ' + (note.title || 'Untitled'));
    item.setAttribute('aria-pressed', String(isActive));

    const t = document.createElement('span'); t.className = 'notepad-list-title';
    t.innerHTML = '';
    t.append(document.createTextNode(note.title || 'Untitled'));
    if (note.visibility === 'shared') t.insertAdjacentHTML('beforeend', ' ' + ICON_GLOBE);

    const p = document.createElement('span'); p.className = 'notepad-list-preview';
    p.textContent = (note.body || '').replace(/\n/g, ' ').slice(0, 60) || '—';

    const d = document.createElement('span'); d.className = 'notepad-list-date';
    const dateStr = note.updatedAt
      ? new Date(note.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    d.textContent = _isMine(note) ? dateStr : [dateStr, note.owner].filter(Boolean).join(' · ');

    item.append(t, p, d);
    item.onclick = () => _openNote(note.id, note.owner);
    row.appendChild(item);
    listEl.appendChild(row);
  });
}

function _renderList() {
  _renderOneList(document.getElementById('notepad-list'), _myNotes(), 'No notes yet. Click + New to create one.', { selectable: _selectMode });
  _renderOneList(document.getElementById('notepad-shared-list'), _sharedNotes(), 'No shared notes from other users yet.');
  _renderBulkBar();
}

// ── Bulk select / delete ──────────────────────────────────────────────────────
function _renderBulkBar() {
  const bar     = document.getElementById('notepad-bulk-bar');
  const allCb   = document.getElementById('notepad-select-all-cb');
  const delBtn  = document.getElementById('notepad-bulk-delete-btn');
  const countEl = document.getElementById('notepad-bulk-count');
  const selBtn  = document.getElementById('notepad-select-btn');
  if (bar) bar.style.display = _selectMode ? '' : 'none';
  if (selBtn) {
    selBtn.setAttribute('aria-pressed', String(_selectMode));
    selBtn.classList.toggle('active', _selectMode);
    selBtn.textContent = _selectMode ? 'Cancel' : 'Select';
  }
  if (!_selectMode) return;
  const mine = _myNotes();
  const selectedCount = mine.filter(n => _selectedIds.has(n.id)).length;
  if (countEl) countEl.textContent = String(selectedCount);
  if (delBtn) delBtn.disabled = selectedCount === 0;
  if (allCb) {
    allCb.checked = mine.length > 0 && selectedCount === mine.length;
    allCb.indeterminate = selectedCount > 0 && selectedCount < mine.length;
  }
}

function _onToggleSelect(id, checked) {
  if (checked) _selectedIds.add(id); else _selectedIds.delete(id);
  _renderBulkBar();
}

function _onToggleSelectMode() {
  _selectMode = !_selectMode;
  if (!_selectMode) _selectedIds.clear();
  _renderList();
}

function _onSelectAll(checked) {
  const mine = _myNotes();
  if (checked) mine.forEach(n => _selectedIds.add(n.id));
  else _selectedIds.clear();
  _renderList();
}

async function _onBulkDelete() {
  const mine = _myNotes().filter(n => _selectedIds.has(n.id));
  if (!mine.length) return;
  if (!confirm('Delete ' + mine.length + ' selected note' + (mine.length > 1 ? 's' : '') + '? This cannot be undone.')) return;
  const deletedIds = new Set(mine.map(n => n.id));
  const activeWasDeleted = _activeId && deletedIds.has(_activeId) && _activeOwner === _user();
  if (activeWasDeleted) {
    // The active note is being deleted — no point saving it, just stop autosave.
    clearTimeout(_autoSaveTimer); _autoSaveTimer = null;
  } else if (_dirty) {
    // Preserve unsaved edits on the still-active note before deleting others.
    clearTimeout(_autoSaveTimer); _autoSaveTimer = null;
    await _doSave();
  }
  _setStatus('Deleting…');
  await Promise.all(mine.map(n => _fsDelete(n.id)));
  _notes = _notes.filter(n => !(n.owner === _user() && deletedIds.has(n.id)));
  _selectedIds.clear();
  _saveCache();
  if (activeWasDeleted) {
    const sorted = _myNotes();
    if (sorted.length) _openNote(sorted[0].id, sorted[0].owner);
    else _clearEditor();
  } else {
    _renderList();
  }
  _setStatus('');
}

// ── Open / clear editor ───────────────────────────────────────────────────────
function _openNote(id, owner) {
  const resolvedOwner = owner != null ? owner : _user();
  const note = _notes.find(n => n.id === id && n.owner === resolvedOwner);
  if (!note) return;
  _activeId = id;
  _activeOwner = resolvedOwner;
  const titleEl = document.getElementById('notepad-title');
  const bodyEl  = document.getElementById('notepad-body');
  if (titleEl) titleEl.value = note.title || '';
  if (bodyEl)  bodyEl.value  = note.body  || '';
  _setDirty(false);
  _setStatus('');
  _renderVisibilityBtn(note);
  _renderReadonlyState(note);
  _renderList();
}

function _clearEditor() {
  _activeId = null;
  _activeOwner = null;
  const titleEl = document.getElementById('notepad-title');
  const bodyEl  = document.getElementById('notepad-body');
  if (titleEl) titleEl.value = '';
  if (bodyEl)  bodyEl.value  = '';
  _setDirty(false);
  _setStatus('');
  _renderVisibilityBtn(null);
  _renderReadonlyState(null);
  _renderList();
}

function _restoreActive() {
  const sorted = _myNotes();
  if (!sorted.length) { _clearEditor(); return; }
  const still = _activeId && _notes.find(n => n.id === _activeId && n.owner === _activeOwner && _isMine(n));
  _openNote(still ? _activeId : sorted[0].id, still ? _activeOwner : sorted[0].owner);
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function notepadLoad() {
  // Flush any pending auto-save first so unsaved edits are not discarded
  if (_autoSaveTimer) {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = null;
    if (_dirty) await _doSave();
  }

  // Show cache instantly
  _notes = _loadCache();
  _renderList();
  _restoreActive();

  if (!_user()) { _setStatus('Not logged in'); return; }

  _setStatus('Syncing…');
  const remote = await _fsLoad();
  if (remote !== null) {
    _notes = _merge(remote);
    _saveCache();
    _renderList();
    // Refresh editor if content changed from remote
    const active = _activeId && _activeNote();
    if (active && !_dirty) _openNote(active.id, active.owner);
    else if (!active) _restoreActive();
    _setStatus(_notes.length ? '' : '');
  } else {
    _setStatus('Offline — showing cached notes');
  }
}

// ── Save (manual + auto) ──────────────────────────────────────────────────────
async function _doSave() {
  if (!_activeId) return;
  const note = _activeNote();
  if (!note || !_isMine(note)) return; // shared notes from others are read-only
  const titleEl = document.getElementById('notepad-title');
  const bodyEl  = document.getElementById('notepad-body');
  note.title     = titleEl ? titleEl.value : note.title;
  note.body      = bodyEl  ? bodyEl.value  : note.body;
  note.updatedAt = Date.now();
  _saveCache();
  _renderList();
  _setStatus('Saving…');
  const btn = document.getElementById('notepad-save-btn');
  if (btn) btn.disabled = true;
  const ok = await _fsSave(note);
  _setDirty(false);
  _setStatus(ok ? 'Saved to cloud' : 'Saved locally (sync failed)');
  // Clear status after 3 s
  setTimeout(() => { if (!_dirty) _setStatus(''); }, 3000);
}

// ── Event handlers ────────────────────────────────────────────────────────────
function _onInput() {
  const active = _activeNote();
  if (active && !_isMine(active)) return; // read-only shared note
  _setDirty(true);
  _setStatus('Unsaved changes');
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(_doSave, 3000); // auto-save after 3 s idle
}

async function _onVisibilityChange(e) {
  const note = _activeNote();
  if (!note || !_isMine(note)) return;
  const next = e.target.value === 'shared' ? 'shared' : 'private';
  if (note.visibility === next) return;
  note.visibility = next;
  note.updatedAt = Date.now();
  _saveCache();
  _renderVisibilityBtn(note);
  _renderList();
  _setStatus('Saving…');
  const ok = await _fsSave(note);
  _setStatus(ok ? (next === 'shared' ? 'Made public — everyone can see this' : 'Made private') : 'Saved locally (sync failed)');
  setTimeout(() => { if (!_dirty) _setStatus(''); }, 3000);
}

async function _onNew() {
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
  if (_dirty) await _doSave();
  const id = 'note_' + Date.now();
  const note = { id, owner: _user(), title: '', body: '', visibility: 'private', updatedAt: Date.now() };
  _notes.unshift(note);
  _saveCache();
  _renderList();
  _openNote(id, note.owner);
  _fsSave(note); // fire-and-forget for new blank note
  const titleEl = document.getElementById('notepad-title');
  if (titleEl) titleEl.focus();
}

async function _onDelete() {
  if (!_activeId) return;
  const note = _activeNote();
  if (!note || !_isMine(note)) return; // can only delete your own notes
  if (!confirm('Delete this note? This cannot be undone.')) return;
  clearTimeout(_autoSaveTimer); _autoSaveTimer = null;
  const deletedId = _activeId;
  const deletedOwner = _activeOwner;
  _notes = _notes.filter(n => !(n.id === deletedId && n.owner === deletedOwner));
  _saveCache();
  _setStatus('Deleting…');
  await _fsDelete(deletedId);
  const sorted = _myNotes();
  if (sorted.length) { _openNote(sorted[0].id, sorted[0].owner); _setStatus(''); }
  else _clearEditor();
}

// ── Init (idempotent) ─────────────────────────────────────────────────────────
function initNotepad() {
  if (!_handlersReady) {
    document.getElementById('notepad-new-btn')       ?.addEventListener('click', _onNew);
    document.getElementById('notepad-delete-btn')    ?.addEventListener('click', _onDelete);
    document.getElementById('notepad-save-btn')      ?.addEventListener('click', _doSave);
    document.getElementById('notepad-visibility-private')?.addEventListener('change', _onVisibilityChange);
    document.getElementById('notepad-visibility-shared') ?.addEventListener('change', _onVisibilityChange);
    document.getElementById('notepad-title')         ?.addEventListener('input', _onInput);
    document.getElementById('notepad-body')          ?.addEventListener('input', _onInput);
    document.getElementById('notepad-select-btn')      ?.addEventListener('click', _onToggleSelectMode);
    document.getElementById('notepad-select-all-cb')   ?.addEventListener('change', e => _onSelectAll(e.target.checked));
    document.getElementById('notepad-bulk-delete-btn') ?.addEventListener('click', _onBulkDelete);
    _handlersReady = true;
  }
  notepadLoad();
}
