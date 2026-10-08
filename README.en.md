# Default Workspace · dsh-bundle-default-workspace

A [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-default-workspace) (DSH) plugin that gives
**the small miscellaneous stuff — the things that don't deserve a project — one fixed place to live.**

A one-off calculation. A throwaway debug script. Some notes from reading docs. A single question you
just want answered. None of these justify creating a workspace, but dumping them into whatever project
you happen to have open makes a mess.

This plugin provides **one** default workspace: created automatically, registered automatically, and
configurable from a card in **Settings → Plugins**.

> English · [简体中文](README.md)

---

## Why

Every session in DSH has to live in some workspace. That is natural when you are actually building
something, but a large part of daily work is **one-off**:

- **Create a new workspace** — name it, pick a directory, decide which project it belongs to. Too much
  ceremony for a five-minute task.
- **Reuse the project you have open** — the project directory fills up with scratch files, and two days
  later you can't tell which of them are junk.

So you end up choosing between two bad options. This plugin takes the position that **a whole class of
work is "do it and move on"**, and gives it a dedicated place that is explicitly labelled *not a project*.

The key mechanism is an `AGENTS.md` seeded into the directory that **tells the agent, in plain language,
that this is not a project**: don't scaffold `src/`, `tests/` or `package.json`, don't `git init`,
keep the root tidy, migrate anything valuable and delete the rest. That stops the agent from quietly
turning your scratch area into a half-finished project.

## Features

- **One default workspace** — defaults to `<your Documents folder>/deepseek-harness/default-workspace`,
  created and registered with DSH automatically, titled "默认工作区" (Default Workspace).
- **`AGENTS.md` seed** — the most important rule in it is **"do not put files directly in the top
  level"**: no temp files, scratch drafts, verification scripts, dependency directories or build
  output at the root. It names designated homes (`_scratch/`, `notes/`, `scripts/`) and ends with
  "if you think you must, stop and ask first", so the agent cannot wreck your one clean landing spot.
  It also calls out that **`_trash/` is the recycle bin and must be left alone** — otherwise an agent
  sees it and treats it as litter to tidy up. **Never overwrites** an existing file by default.
- **`default_workspace` agent tool** — ask "where is my default workspace" or "is it set up yet", or
  have the agent `ensure` it into existence.
- **Visual configuration** — change the directory, title, purpose and seed text from the Plugins page.
  Changes take effect **immediately, with no restart**.
- **Recoverable clear / reset** — when the scratch pad has piled up, zero it out from the panel.
  Deletion is **never a direct delete**: files and directories are moved into `_trash/<timestamp>/`
  inside the workspace first, so you can always take them back. And you have to **type the directory
  name** to go ahead — this action empties the whole workspace in one shot, so it deserves three seconds.
- **Three-level directory fallback** — custom parent → system Documents folder → `~/.dsh/workspaces`.
  A failed detection still lands somewhere sane.
- **Read-only panel polling** — `GET /state` has strictly no side effects; it will never create a
  directory behind your back.
- **Zero build, zero runtime dependencies** — plain hand-written JS using only `node:` builtins, so a
  git install just works.

## Installation

DSH must be **restarted** after installing for the plugin to load (the installer says
"loaded on next start").

### Option 1: Plugin manager (recommended)

1. Open **Settings → Plugins**
2. Click **Add plugin** in the top-right corner
3. In the "Package or address" field, enter this repository:

   ```
   https://github.com/OraSkyC/dsh-bundle-default-workspace
   ```

4. Click **Install**, then restart DSH

> That field accepts three forms: an **npm package name**, a **GitHub repository URL**, or a
> **local directory path**. When you use a GitHub URL your machine needs direct access to
> github.com — it does not go through an npm mirror.

### Option 2: Command line

```bash
dsh plugin --profile desktop add https://github.com/OraSkyC/dsh-bundle-default-workspace
```

### Option 3: Local directory (for development)

If you have already cloned the repo, link the directory into your profile:

```bash
dsh plugin --profile desktop add /path/to/dsh-bundle-default-workspace
```

On Windows the equivalent manual steps are:

1. Add `"dsh-bundle-default-workspace": "link:D:/path/to/dsh-bundle-default-workspace"` to
   `dependencies` in `%USERPROFILE%\.dsh\profiles\desktop\package.json`
2. Add `"dsh-bundle-default-workspace"` to the `dsh.profile.bundles` array in the same file
3. Create a directory junction:
   `mklink /J node_modules\dsh-bundle-default-workspace D:\path\to\dsh-bundle-default-workspace`

### Upgrading

The plugin manager does **not** support automatic updates yet. Uninstall, install the new version the
same way, then restart.

## Configuration

Two layers, lowest priority first:

| Layer | Location | Takes effect |
| --- | --- | --- |
| Deploy defaults | [`cordis.patch.yml`](./cordis.patch.yml) in this package | after a **DSH restart** |
| User overrides | `%USERPROFILE%\.dsh\state\dsh-bundle-default-workspace\settings.json` | **immediately** |

The user layer is **sparse**: it only stores fields you actually changed in the panel. "Reset" **deletes**
that key rather than writing the default value back, so the field falls through to the deploy defaults
again.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | When off: no directory, no registration, no tool, read-only panel. |
| `directoryName` | `default-workspace` | Leaf directory name. Matches DSH's own first-use workspace, so the default config wraps core behaviour. Letters, digits, dot, underscore, hyphen only. |
| `parentDirectory` | `""` | Parent directory. Empty triggers the resolution below; an **absolute path** is used as-is. |
| `documentsDirectory` | `""` | Documents-folder override, **only used when `parentDirectory` is empty**. Empty means auto-detect. |
| `title` | `""` | Display title. Empty derives it from the directory name (`default-workspace` → "默认工作区"). Changing it calls `workspaceRegistry.setTitle`. |
| `description` | `""` | Purpose text, shown in the panel and in `AGENTS.md`. Empty uses the built-in text. |
| `autoCreate` | `true` | Create and register the workspace on first use instead of waiting for a manual "Ensure". |
| `seedAgentsMd` | `true` | Write `AGENTS.md` on creation. |
| `overwriteSeed` | `false` | Rewrite an existing `AGENTS.md`. Off by default so your edits survive. |
| `instructions` | `""` | Non-empty **replaces the whole** built-in seed body. |
| `pollSeconds` | `30` | Panel refresh interval, clamped to 5–600. |
| `trashKeep` | `5` | Recycle-bin batches to keep, clamped to 0–100. Only the **oldest** batches beyond this count are really deleted; `0` disables automatic cleanup. Only batches this plugin created are affected. |
| `allowedHosts` | `[]` | Extra trusted host names, **added to** `localhost` / `127.0.0.1` / `::1` (not a replacement). |

### How the directory is resolved

```
1. parentDirectory non-empty?     → use it as-is                     source = config
2. documentsDirectory non-empty?  → <it>/deepseek-harness            source = documents
3. auto-detect Documents folder?  → <Documents>/deepseek-harness     source = documents
4. all of the above failed        → ~/.dsh/workspaces/deepseek-harness   source = fallback

final directory = <parent> / <directoryName>
```

Detection matches DSH core: `[Environment]::GetFolderPath` on Windows, `osascript` on macOS,
`xdg-user-dir` on Linux, with a 10-second timeout.

**Which source won is shown in the panel** — "where did my workspace actually go" is the most common
question.

## Agent tool

One tool, `default_workspace`:

| action | Behaviour |
| --- | --- |
| `status` (default) | Directory, whether it exists, whether it is registered, title and session count, `AGENTS.md` state. **Read-only.** |
| `ensure` | Create the directory, register the workspace, write `AGENTS.md`. **Idempotent.** |
| `path` | Just the directory path and its source. |
| `describe` | The purpose text configured in the panel. |

The tool description explicitly instructs the agent: **to change the directory, ask the user to change
`parentDirectory` in settings** — the agent must not move the workspace on its own.

It also states that **clearing and resetting are panel-only, user-only actions**, with deliberately no
tool entry point. Same reasoning as above, only more so — those actions empty the entire workspace.

## Clear and reset

Over time this spot fills up with drafts that have outlived their purpose. The last panel section,
"清理与重置", offers two actions:

| Action | Moves away | Keeps |
| --- | --- | --- |
| **Clear the workspace** | Everything at the top level, including subdirectories | `AGENTS.md`, `_trash/` |
| **Reset the workspace** | The contents **and** `AGENTS.md` | Then regenerates `AGENTS.md` from the current settings and confirms the workspace is still registered |

Reset really is "back to a fresh start": afterwards the directory is in the same state as the day you
first used this plugin.

### Deletion is recoverable

Neither action deletes anything outright. Each top-level entry gets a single `rename` into a recycle
bin inside the workspace:

```
<workspace>/
├── AGENTS.md
└── _trash/
    ├── 20261009-010132-341/      ← one batch per operation
    │   ├── tmp.txt
    │   ├── _scratch/
    │   └── notes/
    └── 20261008-231500-123/
```

To get something back, just take it out of `_trash/<batch>/`; when you are sure you do not want it,
delete the batch directory. The "current contents" row shows how many items and how many bytes are
about to move, and the "recycle bin" row shows how many batches have accumulated.

### Two guard rails

1. **Typed confirmation.** The confirm panel lists the entries that will move and requires you to
   **type the workspace directory name** (by default `default-workspace`) before the confirm button
   becomes clickable. It is not an OK/Cancel dialog, because that does not stop a mis-click — a text
   field does. It also forces you to confirm *which* directory you are wiping, since both the
   directory name and its parent are configurable.
2. **`_trash` is never touched.** Clear keeps it and reset excludes it too. If `reset` treated the
   recycle bin as cleanable, it would try to move `_trash` into `_trash/<batch>/_trash` — moving itself
   into itself. That bug really happened and the tests caught it (`EPERM` on Windows).

### The recycle bin cannot grow forever

`trashKeep` (default `5`) is how many batches to keep. Beyond that, the **oldest batches** are really
deleted.

The boundary for automatic cleanup is that a directory name must match `YYYYMMDD-HHmmss-SSS` exactly.
It can therefore only ever delete batches this plugin created; anything you put into `_trash` yourself
— even if it happens to be called `trash`, `backup` or `2026` — is never touched. A name constrained
to that format cannot contain a path separator either, so the joined path cannot escape `_trash`.

## HTTP endpoints

Used by the panel. Available only from **loopback** (`localhost` / `127.0.0.1` / `::1`) plus the
`allowedHosts` allow-list; anything else gets `403`. Only the `Host` header is checked — these endpoints
run on the host's own loopback web server, so a cross-origin request cannot reach them, making `Host`
the only trustworthy signal on the path.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/dsh-bundle-default-workspace/state` | State snapshot. **Strictly no side effects.** |
| `POST` | `/api/dsh-bundle-default-workspace/settings` | Body `{ "field": "<key>", "value": <v\|null> }`; `null` deletes the override. |
| `POST` | `/api/dsh-bundle-default-workspace/ensure` | Create / register / seed. Idempotent. |
| `POST` | `/api/dsh-bundle-default-workspace/clear` | Body `{ "confirm": "<directory name>" }`. `{"dryRun": true}` previews only. |
| `POST` | `/api/dsh-bundle-default-workspace/reset` | Same, but `AGENTS.md` moves too and is then regenerated. |

The validation order for `/clear` and `/reset` is: origin → method → JSON body → plugin enabled →
`dryRun` → confirmation token. The token must match the workspace directory name **exactly**, otherwise
you get a `400` whose message tells you what to type. When the plugin is disabled both endpoints refuse
outright — the panel is read-only, and so is the API.

## How it works

### Read-only and side-effecting paths are kept strictly apart

| Function | Behaviour |
| --- | --- |
| `describeWorkspace` | Only probes via `resolveByPath`; **creates nothing** |
| `ensureRegistered` | Reuses a hit, otherwise `mkdir` + `create`, then applies the title |
| `buildState` | Only `stat` + probe — read-only |
| `writeSeed` | Skips when the file exists and `overwriteSeed` is off |
| `listClearable` | Only `readdir` + `lstat` to summarise — read-only, and it does not create a missing directory either |

So the `GET /state` the panel polls every 30 seconds will **not** create anything. Creation only happens
through `/ensure` or the tool's `ensure`.

### Why cleanup uses rename instead of recursive delete

`moveToTrash` performs exactly **one `rename`** per top-level entry and never recurses into
subdirectories. Three things follow:

- **It is fast.** Emptying a directory holding thousands of files is one system call, not thousands.
- **It cannot delete outside the workspace.** The classic hazard of deleting a tree is symlinks and
  Windows junctions: a recursive delete follows the link into `C:\` or a network share. `rename` moves
  **the link itself**; the target is untouched. This is not just reasoning on paper — the test suite
  actually creates a junction pointing outside the workspace and asserts that afterwards the target
  directory and its files are completely intact.
- **It is recoverable.** That is the whole premise of the recycle bin.

The size summary (`measureTree`) does have to recurse, so it uses `lstat` rather than `stat` (it does
not follow symlinks) and is hard-capped: at most 2000 entries and 8 levels deep. Hitting a cap sets
`truncated` and honestly reports "N+ items" to the panel.

One detail only measurement revealed: checking `isSymbolicLink()` on the **children** is not enough,
because `readdir` follows a link passed in as the **root**. So `measureTree` also inspects itself on
entry and returns 0 bytes / 0 entries when the root is a link. A link's own metadata size is likewise
excluded from the total — that is not content the user is about to move.

One more boundary: if the top level holds more than 5000 entries, `moveToTrash` **refuses** and says
why. Better to make the user tidy up by hand than to move part of it and report success — that kind of
"clear" is worse than no clear at all.

### One idempotent refresh function, three callers

```
apply(ctx, config)
  ├─ new FileStore($DSH_HOME/state/<name>/settings.json)
  ├─ registerRoutes()                 sync; mounts five routes
  ├─ registerTool()                   async; returns null when there is no tools service
  ├─ void refreshFromSettings()       first pass
  ├─ setInterval(refresh, pollSeconds).unref()
  └─ ctx.effect(() => () => stop())   teardown hook

refreshFromSettings(wiring)     ← first pass / poll fallback / right after a panel write
  ├─ disposed / refreshing guards
  ├─ read override layer → resolveSettings → write back to wiring
  ├─ !enabled || !autoCreate ? return early
  ├─ resolveParent → mkdir
  ├─ ensureRegistered
  └─ writeSeed
```

The `refreshing` boolean guard is not decoration: without it, clicking "Ensure workspace" while the poll
fires would race `mkdir` + `create` and could register two workspaces.

### `apply()` never throws

No `tools` service means no tool; no `workspaceRegistry` means the directory is created but not
registered. Both only log a warning. The reasoning is practical: a plugin that fails to mount takes DSH
startup down with it, and an optional plugin is not worth that.

There is a **counter-intuitive trap** here, and it is one this plugin actually hit. Cordis's `ctx` is a
**restricted proxy**: reading a property that was not declared in `inject` **throws** rather than
returning `undefined`:

```
cannot get property "webServer" without inject
```

That means graceful degradation **cannot** be written as `ctx.webServer ?? fallback` — the throw happens
while evaluating `ctx.webServer`, so `??` never runs. The result is a failed `apply()`, the plugin shown
as "error" in the panel, and all three routes returning 404.

The correct approach is to separate the two kinds of service:

- Services that **always exist**, like `webServer` → declare them in `inject`.
- **Optional** services, like `tools` and `workspaceRegistry` → read them with `ctx.get()` inside `try`.

## Compatibility

| Item | Requirement |
| --- | --- |
| DSH | a `web` profile (uses `webServer` and `slots`) |
| Node | `>= 22.19.0` |
| Runtime dependencies | **none** (only `node:` builtins) |
| Build step | **none** (plain JS; a git install runs as-is) |

`peerDependencies` declares only `@deepseek-ai/cordis`, as a **range** rather than an exact version:

```json
"peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0 <5.0.0" }
```

Two deliberate choices:

1. **No static import of any `@deepseek-ai/*` package.** The host half uses only `node:` builtins; the
   browser half receives React at runtime from the loader (`loaderRequire("react")`). The plugin cannot
   break because an internal DSH package moved.
2. **Peer versions use ranges.** DSH's peer compatibility check only covers packages named
   `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`; `@deepseek-ai/cordis` is not in that set. Even so, an
   exact version is dangerous — the plugin manager will refuse the installation on a peer mismatch.

## Development

```bash
node --check lib/index.js     # syntax
node --check client.js

node test-e2e.mjs             # host half (64 assertion groups)
node test-client.mjs          # browser half (38 assertion groups)

npm test                      # both
```

Each test uses its own temporary `DSH_HOME` and cleans up afterwards, so **your real configuration is
never touched**.

### ⚠️ You must restart DSH after a code change

**Refreshing the page is not enough.** The host reads the client bundle into memory at **activation**
(`initialBundleSnapshot` → `readFileSync` in `@deepseek-ai/dsh-client-modules`) and keeps serving that
snapshot; the revision is derived from the `mtimeMs / ctimeMs / size` captured at that moment.

The `sourceKey` that decides whether to rescan is only `baseUrl + loaderName` and contains **no file
metadata**, so the host returns early when it is unchanged — it neither re-stats nor re-reads the file.
On top of that, `cache-control` is `public, max-age=31536000, immutable`, so a refresh just hits the old
URL.

To tell whether a new build actually loaded, look at the **version chip next to the panel title**
(e.g. `v0.1.2`). It is read from `package.json` at module load, so it cannot drift.

### Layout

```
dsh-bundle-default-workspace/
├── package.json         # manifest: dsh.bundle.patch / dsh.client.inject / peerDependencies
├── cordis.patch.yml     # deploy defaults (the patch layer)
├── lib/index.js         # host half: config, directory resolution, FileStore, routes, tool, polling
├── client.js            # browser half: settings card (React injected by the loader)
├── icon.svg
├── locale/zh.json       # meta.title / meta.description
├── locale/en.json
├── README.md            # Chinese
├── README.en.md         # this file
├── CHANGELOG.md
├── LICENSE
├── test-e2e.mjs         # host-half tests
└── test-client.mjs      # browser-half tests
```

## FAQ

**The panel says "load failed: HTTP 404" and the plugin shows as "error"**
The host `apply()` failed and no routes were mounted. The usual cause is a missing `webServer` in
`inject` in `lib/index.js` (see "apply() never throws" above).

**It created the workspace somewhere unexpected**
Look at the "parent source" row in the panel. To pin it down, set `parentDirectory` to an absolute path.

**Settings changes do nothing**
Panel changes take effect immediately (they go through the state override layer). Changes to
`cordis.patch.yml` require a DSH restart.

**Code changes to `client.js` / `lib/index.js` do nothing**
Restart DSH; refreshing the page will not help (see above).

**My `AGENTS.md` got overwritten**
It should not have. Check whether `overwriteSeed` is on.

**Where did my files go after a clear?**
Into `_trash/<timestamp>/` inside the workspace, exactly as they were. The "recycle bin" row in the
panel shows the batch count and the newest batch name, so you can navigate straight to it.

**Will `_trash` be deleted automatically?**
Only batches named `YYYYMMDD-HHmmss-SSS` that fall beyond `trashKeep` are deleted, oldest first.
Anything you put into `_trash` yourself is never touched.

**Can I have the agent clear the workspace for me?**
No, deliberately. That action empties the whole workspace, so it only has a panel entry point and it
requires typing the directory name. The agent can only tell you to open the clear/reset section.

**Does it conflict with DSH's built-in default workspace?**
No. `directoryName` defaults to `default-workspace`, the same path DSH core uses for its first-use
workspace, and the plugin reuses it through `resolveByPath` rather than creating a second one.

## License

[MIT](./LICENSE)
