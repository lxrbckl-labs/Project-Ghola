# Native-Windows Verification Checklist

This session fixed three separate defect classes that all traced back to one
assumption baked into earlier code: that Ghola always runs under WSL. A
sibling team now runs sessions from native Windows (win32, Git Bash, VS Code
desktop) and found all three. Nobody on this box can run win32, so every
Windows branch that shipped this session is *reasoned, not measured*. This
checklist is that gap made repeatable: an operator at a real Windows machine
works through it once and turns "we think it works" into "we checked it".

Every item below is grounded in code that actually shipped this session. Where
a section says "FAIL looks like", that is the important half — every bug this
session was silent (a wrong-but-plausible path, a quietly-skipped alias, a
leaked env var), so the operator needs to know what silence itself looks like,
not just what success looks like.

## Before you start

- **Build + install.** The fixes below exist only in the working tree until
  they are built and running. On the Windows machine: `npm run build`, then
  either launch via F5 (Extension Development Host) or package and install a
  VSIX. Every item below exercises the OLD, unfixed code if this step is
  skipped.
- **PowerShell execution policy — the known first-try blocker.** A
  `Restricted` execution policy prevents PowerShell from loading
  `$PROFILE.CurrentUserAllHosts` at all, so none of the alias functions
  `alias-sync.ts` writes ever come into existence. The symptom is the
  **identical** `CommandNotFoundException` you would see from a completely
  different cause (the alias never being written, or a name PowerShell
  rejected). Before touching aliases, run:
  ```powershell
  Get-ExecutionPolicy -Scope CurrentUser
  ```
  If it reports `Restricted`, run:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
  and re-test. If an alias still fails after this, the cause is something
  else in section 2 below — do not keep blaming the execution policy.
- **Alias block requires an explicit Save, and a new terminal.** The managed
  PowerShell block is written by **Settings -> CLI Aliases -> Save** in
  Ghola's panel — nothing writes it automatically. PowerShell only reads its
  profile once, at shell startup, so a terminal open before you clicked Save
  will never see the new functions; open a **new** terminal afterward.

## 1. `scripts/ghola-boot-probe.sh` — platform detection and path translation

- **Platform detection (`shell_platform()`).** Run `uname -s` in the Git Bash
  terminal you'll use for the rest of this checklist and confirm it reports
  `MINGW*`, `MSYS*`, or `CYGWIN*`. PASS: the boot probe's digest behaves per
  the Windows-specific items below. FAIL looks like: if `uname -s` reports
  something the `case` in `shell_platform()` does not recognize, the probe
  silently falls through to the `unix` branch — every Windows-specific
  translation below is then skipped with no error, and the visible symptom is
  a healthy-looking digest that nonetheless reports `notes_exists=no` on a
  ticket you know has notes, or a vault path that is obviously wrong.
- **WSL-vs-Windows split via `/proc/version`.** Not reachable on native
  Windows (no `/proc/version`), so confirm this by contrast: the probe should
  never report `wsl`-branch behavior (e.g. `/mnt/c/...`-form paths) on this
  machine.
- **Vault path translation, try-stored-first / adopt-only-if-exists gate
  (8a).** Configure `tool.obsidian-notes`' `vaultPath` (or `GHOLA_VAULT`) to a
  WSL-form path such as `/mnt/c/Users/<you>/Documents/Obsidian/<vault>` — the
  form a WSL session would have stored — and run the probe. PASS: the digest
  emits `vault_translated=windows` and the `vault` field is the same directory
  in `C:/...` form. FAIL looks like: `vault_state=unresolved` in the digest
  with `notes_exists=no`, even though the directory demonstrably exists in one
  of the two forms — check by hand that `ls "/mnt/c/Users/<you>/Documents/Obsidian/<vault>"`
  and the `C:\Users\...` equivalent both work before concluding the probe is
  wrong.
- **MSYS-form canonicalization (8b), `/c/...` -> `C:/...`.** This is a
  *separate* rule from 8a and fires on a path that already resolves. Under Git
  Bash, `$HOME` is naturally `/c/Users/<you>`, so a vault path derived from
  `$HOME` (either the fallback scan below or a stored setting written from a
  Windows session) is already in MSYS form and *passes* the `-d` test in 8a —
  meaning 8a does nothing and only 8b can catch it. PASS: the digest emits
  `vault_canonicalized=windows` and the `vault` field reads `C:/...`, never
  `/c/...`. FAIL looks like: the digest's `vault` field is still `/c/...` —
  this will look fine to bash (which accepts either form) but the agent's
  Read/Write tools reject it, so notes silently fail to load with no error
  surfaced by the probe itself. Distinguish this from the 8a failure above by
  checking that `vault_translated` is **absent**: `vault_translated` means the
  *stored* setting was wrong and had to be recovered; `vault_canonicalized`
  means the setting was fine and only its spelling changed. Neither field
  should ever appear together with `vault_state=unresolved`.
- **Portable vault fallback scan (no stored `vaultPath` / `GHOLA_VAULT`).**
  Unset both, then run the probe. Git Bash normally leaves `$USER` unset and
  sets `$USERNAME` instead (the reverse of WSL), so this exercises the
  `${USER:-${USERNAME:-}}` fallback plus the Windows-only `$USERPROFILE`
  candidate. PASS: `vault` resolves to a real directory under
  `Documents/Obsidian`. FAIL looks like: `vault=none` even though
  `Documents\Obsidian\<something>` genuinely exists — check `echo $USER`,
  `echo $USERNAME`, and `echo $USERPROFILE` by hand; an empty `$USERPROFILE`
  (translated form) or an unset `$USERNAME` explains a miss without the probe
  itself being at fault.
- **Detail-file placement under `%TEMP%`.** Run the probe and inspect the
  `detail_file=` field. PASS: a path in `C:/...` form, physically inside
  `%TEMP%`/`%TMP%`, and readable. FAIL looks like: `detail_file_form=msys` is
  present in the digest — this means no `%TEMP%`/`%TMP%`/`%TMPDIR%` candidate
  translated to a confirmed drive-letter directory, so the probe fell back to
  a plain MSYS `mktemp` path. Treat a failed read of that path as *expected*
  in this case (the handoff block/ticket body could not be read), not as
  evidence there was no handoff — see the open question below.
- **Abnormal-only digest fields.** On a fully healthy native-Windows boot with
  a correctly stored, already-canonical vault path, confirm that **none** of
  `vault_translated`, `vault_state`, `vault_canonicalized`, or
  `detail_file_form` appear in the digest at all. Their appearance on an
  otherwise-normal session is itself the signal something needs attention;
  their absence is not something to double-check further.

## 2. `src/session/alias-sync.ts` — PowerShell alias sync

- **PowerShell function emission into `$PROFILE.CurrentUserAllHosts`.** After
  Settings -> CLI Aliases -> Save, run `$PROFILE.CurrentUserAllHosts` in the
  same `pwsh`/`powershell` flavor Ghola launches (pwsh.exe is tried first)
  to find the file, and open it. PASS: a
  `# >>> ghola-managed-aliases >>> ... # <<< ghola-managed-aliases <<<` block
  containing a `function <alias> { ... }` per registered alias, each wrapping
  its invocation in `try`/`finally` with `Get-Command ... -CommandType
  Application`. FAIL looks like: the block is missing entirely (check the
  execution-policy blocker above first), or a function is missing for an
  alias you registered — check the settings-panel notification for a named
  warning before assuming the sync silently swallowed it.
- **Legacy `nomeda-managed-aliases` sentinel adoption.** Hand-edit the profile
  to add a `# >>> nomeda-managed-aliases >>> ... # <<< nomeda-managed-aliases
  <<<` block (the pre-rename marker pair) containing a hand-written function,
  then press Save in CLI Aliases. PASS: the block is rewritten **in place**
  with the current `ghola-managed-aliases` markers (same file position, not
  appended as a second block), and the panel shows a note about the adoption.
  FAIL looks like: a second, separate `ghola-managed-aliases` block appears
  below the untouched legacy block — that means the legacy markers were not
  recognized and the old block was orphaned rather than adopted.
- **Alias-name legality guard.** Register an alias whose name is not a safe
  PowerShell function identifier — a purely numeric name such as `123`, or
  (via `settings.json`, since the UI already blocks whitespace/metacharacters)
  something PowerShell would parse as an operator token. Save it. PASS: that
  one alias is **skipped** with a named warning, and every *other* alias in
  the block still loads and works. FAIL looks like: the whole profile fails to
  load (every alias breaks, not just the bad one) — that means the bad name
  reached the emitted PowerShell text instead of being caught by
  `POWERSHELL_FUNCTION_NAME` before rendering.
- **Env save/restore so `CLAUDE_CONFIG_DIR` does not leak.** Launch a session
  through an alias whose command sets `CLAUDE_CONFIG_DIR`. After the CLI
  exits, in the **same** terminal window (not a new one — this checks the
  interactive shell's own environment, not a fresh profile load), run
  `echo $env:CLAUDE_CONFIG_DIR`. PASS: empty/unset. FAIL looks like: the value
  is still set in the interactive shell after the function returns — that
  means the function's `finally` block did not restore `$gholaSaved` correctly
  (or the shell exited the function abnormally in a way that skipped it).

## 3. `src/session/host-path.ts` + `scripts/ghola.mjs` — ledger root agreement

- **Ledger root lands on the real `_Gholas` directory.** Launch a session and,
  in the session terminal, run `echo $env:GHOLA_LEDGER_ROOT` (or `$env:GHOLA_VAULT`
  if no ledger-root override is set). PASS: a real path such as
  `C:\Users\<you>\Documents\Obsidian\<vault>\_Gholas`. FAIL looks like: a
  fabricated path of the shape `C:\mnt\c\Users\...` — the exact failure this
  module exists to prevent (`path.resolve` amplifying a POSIX `/mnt/c/...`
  string into a syntactically valid but nonexistent Windows path).
- **War Room watcher and `ghola.mjs` writer agree on that same location.**
  From the running session, run something that writes to the ledger, e.g.
  `node scripts/ghola.mjs mission start --subject test --goal "verification check"`,
  then open the War Room panel. PASS: the new mission shows up. FAIL looks
  like: the War Room stays empty or stale even after waiting — this means the
  watcher (set up at extension activation via `resolveWatchedLedgerRoot`) and
  the CLI writer resolved to two *different* fabricated roots, each self-
  consistent but disagreeing with the other, which is exactly the failure mode
  `host-path.ts`'s header comment describes as having happened before this
  module existed.

## 4. `src/session/prompt-file.ts` — per-extension-host prompt filenames

- Open two separate VS Code windows against the same workspace (or two
  windows/profiles pointed at the same folder) and launch a Ghola session in
  each. PASS: each window's terminal has its own distinct
  `$GHOLA_TPM_PROMPT_FILE` (and SWE/QA equivalents) under `%TEMP%`, and
  neither session's composed prompt changes after the other window opens a
  new session. FAIL looks like: one window's TPM behavior or prompt content
  changes mid-session as soon as the second window opens a session — that
  means both extension-host instances resolved to the *same* prompt-file path
  and the second write clobbered the first (the bug the per-instance token
  exists to prevent).

## Open question for the operator

Whether the agent's `Read` tool can open an MSYS-form `/tmp/...` path on
native Windows is still **unknown** and worth settling. The boot probe now
avoids depending on the answer (it only ever emits a `detail_file=` path in
that form as a last resort, flagged with `detail_file_form=msys` so a
consumer can react instead of failing blind), but nobody has actually tried
handing such a path to `Read` on a real Windows box. If you hit the
`detail_file_form=msys` case during this checklist, that is the moment to
test it and record the answer here.
