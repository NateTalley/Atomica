# Sidebar File Menu, Tabs, and List Tag Edit Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move folder add/rescan into a top-left File menu, collapse the left column into Mapping / Type / Playlists tabs, and let users manually correct one-shot/loop, instrument, and genre in list mode.

**Architecture:** Keep the Electron IPC + renderer split. File is an in-app dropdown (native menu bar stays hidden — Atomica already calls `win.setMenuBarVisibility(false)` for the custom chrome). Sidebar content becomes three tab panels. Classification corrections are path-keyed overrides stored on each library entry, applied in `buildDataset()` so they survive rescan/reclassify.

**Tech Stack:** Electron 33, vanilla `src/renderer/{index.html,style.css,app.js}`, `src/main/main.js` + `preload.cjs`. No test runner in `package.json` — do not add one. Verify with `npm run smoke` plus the manual checks listed per task.

---

## Current context / assumptions

Left column today (`src/renderer/index.html`):

1. Brand logo
2. **Folders** — `#addFolder`, `#rescanBtn`, `#folderList`, `#useEmb`
3. **Mapping** — Similarity / Axes inner tabs
4. **Display** — color/size, search, tag filter chips (Type / Instrument / Genre), volume
5. **Playlists**

Classifications are computed, not stored:

- Kind + BPM live on `library.get(path).f.kind` / `f.bpm` (`src/main/analysis/dsp.js` + `fillRhythm`)
- Instrument + genre are recomputed every `buildDataset()` by `classifyTags(e)` (`src/main/main.js:330-347`) from path hints + CLAP text embeds
- There is **no override field** and no IPC to edit tags

Assumptions (decide these, do not expand):

- File menu is **in-app**, top-left of the window (sidebar header), not the OS menu bar.
- Folder list + Remove + AI checkbox move **into the File dropdown** with Add folder / Rescan (they are file operations).
- **Mapping tab** = current Mapping + Display (color, size, search, volume). Search stays here so it is available while browsing.
- **Type tab** = one-shot/loop, instrument, genre **filter chips** (what the user named Type).
- **Playlists tab** = current playlist section.
- List edit corrects **kind**, **instrument**, **genre**. BPM is not a free-form field unless kind is Loop (keep auto BPM; clearing kind to one-shot zeros BPM as analysis already does).
- Overrides win over the model forever until the user changes them again. File-mtime rescan must **not** wipe overrides.
- Allowed instrument/genre values = existing `INSTRUMENTS` / `GENRES` labels plus `—` (clear) and keep any current custom string if already present.

---

## Proposed approach

```
┌ File ▾  ATOMICA logo ─────────────────────────────┐
│ Mapping │ Type │ Playlists                        │
│ (one panel visible)                               │
└───────────────────────────────────────────────────┘
```

File dropdown contents:

- Add folder
- Rescan
- divider
- folder rows with ✕
- divider
- AI similarity (CLAP) checkbox + existing hint

List mode: add an **Edit** toggle on `#viewBar` next to Map / List. When Edit is on:

- Type cell → `<select>` (One-shot / Loop)
- Tags cells → two `<select>`s (instrument, genre)
- Pointer handler must ignore those controls (no play / no DAW drag)
- Each change calls `api.setSampleTags(path, { kind, instrument, genre })`
- Main writes `e.override`, saves cache, patches in-memory dataset (or `sendDataset()`)

---

## Files likely to change

- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/app.js`
- Modify: `src/main/main.js`
- Modify: `src/main/preload.cjs`
- Modify: `README.md` (File menu + list edit; first-launch copy currently says click **+ Add folder**)

Do **not** bump `CACHE_VERSION` unless load/save of the new `override` field cannot be backward-compatible. Prefer adding optional `e.override` on cache entries at current `CACHE_VERSION = 2`.

---

### Task 1: File menu markup and styles (no behavior yet)

**Objective:** Replace the always-visible Add folder / Rescan row with a File dropdown shell in the sidebar header.

**Files:**
- Modify: `src/renderer/index.html:10-26`
- Modify: `src/renderer/style.css` (after `#brand` / `#sidebar` rules)

**Step 1:** In `index.html`, replace the first `<section>` (add folder / rescan / folder list / AI checkbox) with:

```html
<div id="sidebarHead">
  <div id="fileMenuWrap">
    <button id="fileMenuBtn" type="button" aria-haspopup="true" aria-expanded="false">File</button>
    <div id="fileMenu" hidden>
      <button type="button" id="addFolder">Add folder…</button>
      <button type="button" id="rescanBtn" title="Rescan folders for new or changed samples">Rescan</button>
      <div class="menu-sep"></div>
      <ul id="folderList"></ul>
      <div class="menu-sep"></div>
      <label class="check">
        <input type="checkbox" id="useEmb" />
        <span>AI similarity (CLAP)</span>
      </label>
      <div class="hint">Downloads a ~90 MB model on first analysis. Clusters by how samples <i>sound</i>, not just their stats.</div>
    </div>
  </div>
</div>
```

Keep `#brand` immediately under `#sidebarHead` (logo stays; File sits top-left of it).

Keep existing IDs `#addFolder`, `#rescanBtn`, `#folderList`, `#useEmb` so Task 2 can reuse the current listeners.

**Step 2:** Add CSS (match existing tokens `--panel`, `--panel-edge`, `--accent`):

```css
#sidebarHead {
  display: flex;
  align-items: center;
  gap: 8px;
}
#fileMenuWrap { position: relative; z-index: 20; }
#fileMenuBtn {
  padding: 4px 10px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
#fileMenuBtn.open { border-color: var(--accent); }
#fileMenu {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 260px;
  max-width: 320px;
  max-height: min(70vh, 520px);
  overflow-y: auto;
  margin-top: 4px;
  padding: 6px;
  background: rgba(18, 12, 8, 0.98);
  border: 1px solid var(--panel-edge);
  border-radius: 7px;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
#fileMenu button { width: 100%; text-align: left; }
#fileMenu .menu-sep { height: 1px; background: var(--panel-edge); margin: 4px 0; }
#fileMenu #folderList { margin-top: 0; }
#fileMenu .check, #fileMenu .hint { margin-top: 6px; }
```

Remove leftover `#folderList { margin-top: 8px; }` if it now lives only in the menu (keep the `li` rules).

**Step 3:** Visual check only — IDs still exist so `app.js` listeners do not throw. Do not wire open/close yet if you prefer Task 2 to own that; **prefer wiring open/close in Task 2**.

**Step 4:** Commit

```bash
git add src/renderer/index.html src/renderer/style.css
git commit -m "feat: add File dropdown shell for folder actions"
```

---

### Task 2: File menu open / close / outside click

**Objective:** File button toggles the dropdown; click-outside and Escape close it.

**Files:**
- Modify: `src/renderer/app.js` (`buildControls`, ~184-186)

**Step 1:** Add `bindFileMenu()` and call it from `buildControls()` next to the existing addFolder/rescan listeners (those stay):

```javascript
function bindFileMenu() {
  const btn = $('fileMenuBtn');
  const menu = $('fileMenu');
  const wrap = $('fileMenuWrap');
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false);
  });
}
```

Keep `$('addFolder')` / `$('rescanBtn')` / `$('useEmb')` listeners unchanged.

**Step 2:** Manual verify: File opens, outside click closes, Add folder / Rescan still work, folder ✕ still works.

**Step 3:** Commit

```bash
git add src/renderer/app.js
git commit -m "feat: toggle File menu with outside click and Escape"
```

---

### Task 3: Sidebar 3-tab chrome (Mapping / Type / Playlists)

**Objective:** One tab strip; only one of the three panels is visible.

**Files:**
- Modify: `src/renderer/index.html:28-91`
- Modify: `src/renderer/style.css` (`.tabs` / new `#sideTabs`)
- Modify: `src/renderer/app.js` (`buildControls`)

**Step 1:** Wrap remaining sidebar body (everything after brand/file, except `#progressWrap`) as:

```html
<div id="sideTabs" class="tabs">
  <button id="sideTabMap" class="tab active" type="button">Mapping</button>
  <button id="sideTabType" class="tab" type="button">Type</button>
  <button id="sideTabPl" class="tab" type="button">Playlists</button>
</div>

<div id="panelMap">
  <!-- existing Mapping <section> WITHOUT the <h2>Mapping</h2> (tab is the title) -->
  <!-- existing Display <section> WITHOUT the <h2>Display</h2> or keep a small h3 -->
  <!-- MOVE #tagFilters OUT of here into panelType -->
</div>

<div id="panelType" hidden>
  <!-- #tagFilters: filterKind, filterInstr, filterGenre, clearFilters -->
  <!-- Un-hide the h3 labels (remove hidden on Type / Instrument / Genre headings in HTML;
       fillChipRow still toggles heading.hidden when a row is empty) -->
</div>

<div id="panelPl" hidden>
  <!-- existing #playlistSection contents without outer h2 or keep h2 off -->
</div>
```

`#progressWrap` stays a sibling at the bottom of `#sidebar` (`margin-top: auto`).

**Step 2:** CSS: `#sideTabs` sticky-ish at top of scroll (`flex-shrink: 0`). Panels `flex: 1; min-height: 0; overflow-y: auto` so long Mapping sliders still scroll. Reuse `.tab` / `.tab.active`.

**Step 3:** JS:

```javascript
function setSideTab(id) {
  const tabs = [
    ['sideTabMap', 'panelMap'],
    ['sideTabType', 'panelType'],
    ['sideTabPl', 'panelPl'],
  ];
  for (const [tab, panel] of tabs) {
    $(tab).classList.toggle('active', tab === id);
    $(panel).hidden = tab !== id;
  }
}
```

Bind clicks in `buildControls()`. Do not persist the side tab (YAGNI).

**Step 4:** Confirm `bindTagFilters`, `renderTagFilters`, `bindPlaylistControls` still find their IDs.

**Step 5:** Commit

```bash
git add src/renderer/index.html src/renderer/style.css src/renderer/app.js
git commit -m "feat: split sidebar into Mapping, Type, and Playlists tabs"
```

---

### Task 4: Persist sample tag overrides in main process

**Objective:** Store `{ kind, instrument, genre }` per path; apply in `buildDataset`; IPC to set them.

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.cjs`

**Step 1:** On cache load (`loadCache`, ~169) and analysis write (`library.set` ~563), preserve `override` from `prev` if present:

```javascript
override: (e.override && typeof e.override === 'object') ? e.override : (prev && prev.override) || null,
```

In `saveCache` entries, add `override: e.override || null`.

When analysis replaces an entry, copy `prev.override` so a re-analyze does not drop corrections.

**Step 2:** Apply overrides in `classifyTags` / `buildDataset` (`main.js:609-620`):

```javascript
function applyOverride(e, tags) {
  const o = e.override;
  if (!o) return tags;
  if (o.instrument != null) tags.instrument = o.instrument;
  if (o.genre != null) tags.genre = o.genre;
  return tags;
}
```

In the `buildDataset` loop:

```javascript
const tags = applyOverride(e, classifyTags(e));
ds.categories[i] = tags.instrument;
ds.genres[i] = tags.genre;
const kind = (e.override && e.override.kind) || (e.f && e.f.kind) || null;
ds.kinds[i] = kind;
ds.bpms[i] = kind === 'loop' ? (e.f && e.f.bpm != null ? e.f.bpm : null) : null;
```

Do **not** write override into `e.f.kind` unless you also want `fillRhythm` to skip forever (it already skips `e.f.kind == null` only). Prefer overlay at dataset-build time so auto kind remains available if the user clears the override.

**Step 3:** IPC + preload. Also expose label lists so the renderer does not duplicate vocab:

```javascript
ipcMain.handle('tags:vocab', () => ({
  instruments: INSTRUMENTS.map((x) => x.label),
  genres: GENRES.map((x) => x.label),
  kinds: ['oneshot', 'loop'],
}));

ipcMain.handle('sample:setTags', async (_e, samplePath, patch) => {
  const entry = library.get(samplePath);
  if (!entry) throw new Error('unknown sample');
  const next = { ...(entry.override || {}) };
  if (patch.kind !== undefined) {
    if (patch.kind === null || patch.kind === '') delete next.kind;
    else next.kind = patch.kind === 'loop' ? 'loop' : 'oneshot';
  }
  if (patch.instrument !== undefined) {
    if (!patch.instrument || patch.instrument === '—') delete next.instrument;
    else next.instrument = String(patch.instrument);
  }
  if (patch.genre !== undefined) {
    if (!patch.genre || patch.genre === '—') delete next.genre;
    else next.genre = String(patch.genre);
  }
  entry.override = Object.keys(next).length ? next : null;
  await saveCache();
  sendDataset();
  return true;
});
```

`preload.cjs`:

```javascript
tagsVocab: () => ipcRenderer.invoke('tags:vocab'),
setSampleTags: (path, patch) => ipcRenderer.invoke('sample:setTags', path, patch),
```

**Step 4:** Verify mentally / with a one-off node REPL if desired: override beats `classifyTags`; missing override unchanged; `saveCache` round-trips the field.

**Step 5:** Commit

```bash
git add src/main/main.js src/main/preload.cjs
git commit -m "feat: persist manual sample tag overrides across rescan"
```

---

### Task 5: List-mode Edit toggle and inline editors

**Objective:** In List view, Edit mode turns Type / Tags into selects that call `setSampleTags`.

**Files:**
- Modify: `src/renderer/index.html` (`#viewBar`)
- Modify: `src/renderer/style.css` (list grid may need a bit more room; select styles)
- Modify: `src/renderer/app.js` (`makeListRow`, `paintListRow`, `bindListPointer`, `init`/`buildControls`)

**Step 1:** Add `<button id="viewEdit" class="tab" type="button" hidden>Edit</button>` to `#viewBar`. Show it only when `params.view === 'list'` (`setView`). Widen `#viewBar` from `168px` so three controls fit (e.g. `240px`).

`let listEdit = false;`
`let tagVocab = { instruments: [], genres: [], kinds: ['oneshot', 'loop'] };`

In `init()`, `tagVocab = await api.tagsVocab();`

**Step 2:** `makeListRow` — keep structure, but Type and Tags will be rebuilt in `paintListRow` when `listEdit` is true.

When `listEdit`:

- `.list-kind` contains `<select class="list-edit-kind">` with One-shot / Loop
- `.list-tags` contains two selects: instrument (`['—', ...tagVocab.instruments]`), genre (`['—', ...tagVocab.genres]`). If current value is not in the list, prepend it so the correction is visible.

On `change` of a select (bind once in `makeListRow`, read `row.dataset.idx`):

```javascript
async function commitRowTags(row) {
  const idx = parseInt(row.dataset.idx, 10);
  const kind = row.querySelector('.list-edit-kind').value;
  const instrument = row.querySelector('.list-edit-instr').value;
  const genre = row.querySelector('.list-edit-genre').value;
  dataset.kinds[idx] = kind;
  dataset.categories[idx] = instrument === '—' ? '—' : instrument;
  dataset.genres[idx] = genre === '—' ? '—' : genre;
  if (kind !== 'loop') dataset.bpms[idx] = null;
  await api.setSampleTags(dataset.paths[idx], { kind, instrument, genre });
  renderTagFilters();
  restyle();
  refreshList(false);
}
```

`onDataset` will refresh from main after `sendDataset()` — that is the source of truth. Optimistic local patch avoids flicker; `applyDataset` must not wipe `listEdit`.

**Step 3:** `bindListPointer`: if `e.target.closest('select')` (or `.list-edit-kind`), return early — no play, no drag.

**Step 4:** `viewEdit` click toggles `listEdit`, button `.active`, `renderListWindow()`. Turning Edit off restores chips.

**Step 5:** CSS for compact selects in the 36px row (`font-size: 11px; padding: 2px 4px;`).

**Step 6:** Manual: List → Edit → change Type and tags → leave list → come back → values stick after rescan.

**Step 7:** Commit

```bash
git add src/renderer/index.html src/renderer/style.css src/renderer/app.js
git commit -m "feat: edit kind, instrument, and genre from list view"
```

---

### Task 6: README + empty-state copy

**Objective:** First-run instructions no longer say click **+ Add folder**.

**Files:**
- Modify: `README.md:19-21` and add a short List edit / File menu note
- Modify: empty state in `index.html` (`Add a sample folder…`) — optional: `File → Add folder`

**Step 1:** Replace first-launch sentence with File → Add folder. Document list Edit.

**Step 2:** Commit

```bash
git add README.md src/renderer/index.html
git commit -m "docs: point first launch at File menu and list tag edit"
```

---

### Task 7: Smoke + visual pass

**Objective:** App still boots; no missing-ID throws.

**Files:** none expected

**Step 1:** Run:

```bash
npm run smoke
```

Expected: process exits after smoke timeout; no renderer `Cannot read properties of null` for `$('addFolder')` / `$('rescanBtn')` / `$('filterKind')` / `$('newPlaylist')`.

**Step 2:** Manual checklist:

- [ ] File top-left opens/closes
- [ ] Add folder and Rescan work from the menu
- [ ] Folder remove still works
- [ ] Mapping tab: Similarity/Axes, weights, color/size, search, volume
- [ ] Type tab: one-shot/loop, instrument, genre chips filter map + list
- [ ] Playlists tab unchanged
- [ ] List Edit corrects tags and survives rescan
- [ ] Clicking a select does not audition the sample

---

## Risks, tradeoffs, open questions

| Risk | Mitigation |
| --- | --- |
| Native OS File menu vs in-app | In-app chosen because menu bar is hidden. Switch only if you want a real Windows menu bar. |
| `sendDataset()` after every edit is heavy on large libraries | Accept for v1 (same path as folder remove). If janky, add a `dataset-patch` channel later (YAGNI). |
| Virtualized list + `<select>` open while scrolling | Closing/reusing rows will destroy an open dropdown — acceptable; do not try to pin the select. |
| Override vs `fillRhythm` rewriting `e.f.kind` | Overlay at `buildDataset`; do not clobber `e.f`. |
| Display (color/size) living under Mapping | Intentional. Type tab is filters only. |

No new dependencies. No test framework.

---

## Execution handoff

Plan complete and saved. Ready to execute using subagent-driven-development — I'll dispatch a fresh subagent per task with two-stage review (spec compliance then code quality). Shall I proceed?
