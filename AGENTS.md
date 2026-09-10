# Agent installation guide

Use this guide when a user asks an Agent to install, update, verify, or remove
`dsh-cursor-agent`.

## Commands

- `pnpm run build` — build host (`lib/index.js`) and web client (`lib/client.js`)
- `pnpm run dev` — watch mode
- `pnpm run test` — run the rstest suite
- `pnpm run lint` — lint with rslint
- `pnpm run format` — format with prettier

Agent protocol messages come from the vendored Cursor protogen under
`src/generated/` (`@bufbuild/protobuf` v1). Connect framing stays in `src/wire/frames.ts`.

## Safety

- Confirm the target DSH profile; use `web` only when it is the user's target.
- Never print OAuth credentials, refresh tokens, authorization callbacks, or
  the credential store.
- Do not start, stop, or restart DSH without explicit permission.
- Preserve the DSH profile, unrelated plugins, and stored OAuth credentials.
  Signing out requires explicit permission.
- Do not delete any DSH profile during install, update, verification, or uninstall.

## Install

When `dsh`, Node.js, and pnpm are available, install the package directly:

```sh
dsh plugin --profile web add dsh-cursor-agent
```

For a local checkout (development), add it to the profile as a file dependency:

```sh
cd "%USERPROFILE%\.dsh\profiles\web"
pnpm add file:D:/mcp/dsh-cursor-agent
```

Then ensure `dsh-cursor-agent` is listed in the profile
`package.json` under `dsh.profile.bundles` (the `dsh plugin add` command does
this automatically for published packages).

Update with `dsh plugin --profile web update dsh-cursor-agent`.
Uninstall with `dsh plugin --profile web remove dsh-cursor-agent`.

## Verify

```sh
dsh plugin --profile web list dsh-cursor-agent --depth 0
dsh --profile web --dump-config
```

Success requires:

1. The requested package version appears once.
2. `cursor-agent` appears once in the composed config after install
   or update, and is absent after uninstall.
3. No unrelated profile or plugin changed.
4. A running DSH process was not restarted by the operation.
5. After a start with the plugin installed, the user-root preset
   `~/.dsh/.agent-presets/cursor-agent/` exists with `agent.cordis.yml` and
   `preset.yml` (the plugin writes them at startup; Settings -> Agent presets
   shows the display name **Cursor Agent**, not only the id).

Do not treat `dsh plugin --profile web peers check` as the completion test.
If the user authorizes a live check, restart DSH manually, open
**Settings -> Cursor Agent**, and verify the page loads. The Cursor provider
route (`cursor-agent`) must appear in the model picker. A Cursor model call
from a session whose agent preset is not `cursor-agent` must fail fast
with a preset-mismatch error; after switching the session's preset to
`cursor-agent`, one simple chat message must stream a reply. The first
eligible human message may retitle the session through `NameAgent`; that call
must not open a second Agent `Run`. Only run live checks when the user
explicitly requests them.

## Failure handling

- If the settings page reports "无法读取 Cursor 状态" the loopback RPC failed;
  confirm the plugin bundle is listed once in the composed config.
- A "Cursor Agent is not signed in" error on a model call means the
  credential store is empty; the user must complete the browser login flow.
- A preset-mismatch error means the session is not running the
  `cursor-agent` agent preset; switch the session's preset (or set
  `requireCursorPreset` to false in the runtime settings, which also disables
  the check). Sessions created under the old `cursor-subscription` id must
  switch to `cursor-agent` (or pick the model again) after this rename.
- If the `cursor-agent` preset is missing from the preset list, check
  that `~/.dsh/.agent-presets/cursor-agent/agent.cordis.yml` and `preset.yml`
  exist; the plugin re-creates them on the next start. A leftover
  `~/.dsh/.agent-presets/cursor-subscription/` directory from an older build
  can be removed by hand; the plugin does not delete it.
- Cursor's Agent protocol is undocumented and changes; a transport or
  `CURSOR_ERROR` failure on the chat path is expected to need a plugin update.
- `/compact` on a cursor-agent session must trigger Cursor's summarize, not a
  DSH `llm.stream({ purpose: "compaction" })` call. A model calling `compress`
  / `decompress` / `search_context` / `acp_status` means those ACP tools leaked
  onto the Cursor wire; they are denylisted in the adapter.

On any failure, report the sanitized command error, DSH version, selected
profile, what changed, and what remains unverified. Do not patch DSH, wipe
credentials, delete a profile, or claim success from a partial check.
