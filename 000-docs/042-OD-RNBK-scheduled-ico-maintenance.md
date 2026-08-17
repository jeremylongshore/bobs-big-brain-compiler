# Scheduled ICO maintenance

Bob's Big Brain has two independent scheduled knowledge paths. Keep their names and receipts separate:

- `teamkb-compile-daily.sh` is the agent distiller. It turns recent work into governed team-memory proposals through the registrar.
- `ico maintain` is compiler maintenance. It scans registered source mounts, hashes eligible files, ingests deltas, and runs the governed source-scoped summarize and extract passes.

The distiller does not invoke ICO. A successful distiller run is never evidence that the ICO compiler ran.

## Receipt contract

Every `ico maintain` run writes `.ico/maintenance/latest.json` plus a run-addressed receipt under `.ico/maintenance/receipts/`. The terminal status is exactly one of:

- `compiled`: every eligible source reached a compiled or explicit governed-exclusion outcome.
- `partial`: the bounded batch advanced, and the receipt states exactly how many eligible sources remain.
- `verified_noop`: every eligible mounted file is already represented by the same content hash.
- `failure`: the input is stale or missing, a source needs explicit retirement, the spend gate deferred work, the write lock was unavailable, or the compiler failed.

Policy-blocked compensation or PII files are counted separately. They are neither ingest failures nor silent omissions. Validation-rejected sources receive an explicit governed-exclusion marker. A run cannot report `verified_noop` while eligible sources remain. A `running` latest receipt means the prior process died before a terminal receipt and the next run prioritizes its raw paths.

Every receipt declares `compileScope: "mounted-source"`. Accordingly, `compiled` and `verified_noop` are claims about source representation by content hash; they are not claims that the corpus-wide topic, backlink, contradiction, and gap passes were regenerated. Those four passes read the whole compiled corpus and belong to the explicit six-pass operator workflow (`ico compile all`) with a separate cost decision. Scheduled maintenance never changes scope silently on its final backlog batch.

Maintenance processes at most 10 source candidates per run by default (`--max-candidates` or `ICO_MAINTAIN_MAX_CANDIDATES`). Each receipt exposes `progress.eligible`, `selected`, `processed`, `governedExcluded`, `failed`, and `remaining`. A successful partial run is liveness evidence, not a freshness claim.

The `inference_operations` ledger records exact input and output usage once per successful provider call. The cost gate projects from that operation history and computes UTC-day spend from the same rows. Summary planning prices the compiler's documented one-retry maximum per source. Compilation-page `tokens_used` remains page provenance, but it is not summed as provider spend because one multi-page response can stamp the same batch total onto several pages. A second runtime guard refuses the next call when its conservative worst case could cross the daily ceiling.

## Production mounts

Register live documentation roots, not an abandoned staging snapshot. For the Bob's Big Brain team path:

```bash
ico --workspace ~/.teamkb/brain mount add bbb-umbrella ~/000-projects/bobs-big-brain-umbrella
ico --workspace ~/.teamkb/brain mount add bbb-compiler ~/000-projects/bobs-big-brain-compiler
ico --workspace ~/.teamkb/brain mount add bbb-registrar ~/000-projects/bobs-big-brain-registrar
ico --workspace ~/.teamkb/brain mount add bbb-plugin ~/000-projects/bobs-big-brain-plugin
ico --workspace ~/.teamkb/brain mount add intent-os ~/000-projects/intent-os
```

The scanner is recursive, skips hidden directories and `node_modules`, accepts supported extensions case-insensitively, and assigns a stable collision-resistant raw path from mount identity plus relative path. Git mounts enumerate tracked files plus non-ignored untracked files, so ignored caches and permission-restricted scratch backups are outside the knowledge surface instead of becoming silent scan gaps. A Git enumeration failure still fails the run. Content hashes, not mtimes, decide freshness. Direct repository mounts disable the input-age gate by default because an unchanged repository can be healthy. Set `ICO_MAX_INPUT_AGE_DAYS` only for a derived feed that has an explicit delivery SLA; the receipt still records each mount's newest observed mtime.

Removing a tracked source is fail-closed. Maintenance reports `removed_source_requires_retirement`; it does not erase compiled knowledge or pretend the deletion was governed.

## Install and schedule

Install only from a committed tree:

```bash
scripts/operations/install-ico-cli.sh
scripts/operations/install-ico-maintenance.sh
systemctl --user list-timers ico-maintain.timer
```

The CLI installer builds an npm tarball, installs independent dependencies into `~/.local/opt/ico/releases/<git-sha>`, allows only the pinned `better-sqlite3` native install script, initializes and reads a disposable database as its cold-start preflight, and atomically flips `~/.local/opt/ico/current` and `~/.local/bin/ico`. It never overwrites a commit-addressed release.

The timer starts at 01:10 local time and caps the run at 75 minutes, before the 02:45 dev-box backup replication. The wrapper selects MiniMax-M3 through the normal provider registry and decrypts `.minimax.key` from `~/.config/intentsolutions/api-providers.sops.json` only in process memory. It writes liveness evidence under `~/.local/state/ico-maintain-daily/` and sends a high-severity `sys-automation` event through the governed alert floor only on failure.

## Operator checks

Run a read-only discovery before changing mounts or provider configuration:

```bash
ico --workspace ~/.teamkb/brain maintain --scan-only --max-input-age-days 0
jq '{status,errorCode,progress,inference,scan,rawPaths}' ~/.teamkb/brain/.ico/maintenance/latest.json
```

Inspect the scheduled unit and the latest receipt:

```bash
systemctl --user status ico-maintain.service --no-pager
journalctl --user -u ico-maintain.service -n 100 --no-pager
jq . ~/.teamkb/brain/.ico/maintenance/latest.json
```

The default inference ceiling is `$1.00` per UTC day. A projection above the ceiling is a retryable failure, not permission to spend more. Raise `ICO_DAILY_CEILING_USD` only with an explicit operator decision backed by the receipt's projected and measured operation costs.

## Rollback

Each installed release is self-contained. To roll back the CLI, atomically repoint both symlinks to a previously cold-started SHA release:

```bash
ln -s ~/.local/opt/ico/releases/<known-good-sha> ~/.local/opt/ico/.rollback-current
mv -Tf ~/.local/opt/ico/.rollback-current ~/.local/opt/ico/current
ln -s ~/.local/opt/ico/current/node_modules/.bin/ico ~/.local/bin/.rollback-ico
mv -Tf ~/.local/bin/.rollback-ico ~/.local/bin/ico
ico --version
```

Disable only the schedule with `systemctl --user disable --now ico-maintain.timer`. Receipts, source rows, and compiled pages remain intact.
