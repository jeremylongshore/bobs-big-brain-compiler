# The writer model: many processes, one logical writer

**Doc:** 040-AT-ARCH · **Date:** 2026-07-19 · **Track:** GSB Wave-2 G4 (umbrella blueprint
`019-PP-PLAN` § G4) · **Status:** Authoritative — the umbrella's `005-AT-ARCH` addendum points
here.

Many independent processes touch the live brain (`~/.teamkb/`): MCP servers spawned per Claude
and per Grok session, cron wrappers, CLI invocations, the registrar's daemons. The system stays
consistent not because there is one process, but because there is **one logical writer at a
time** for the multi-artifact durable write path — enforced by a single cooperative lock — plus
SQLite-level serialization for everything narrower. This doc states that invariant, what the
lock does and does not cover, and the crash and bypass story.

## 1. The lock that serializes writers

**One advisory `flock(2)` exclusive lock on `${TEAMKB_HOME}/.write.lock`** (default
`~/.teamkb/.write.lock`, overridable via `TEAMKB_LOCK`). Every holder contends for the *same
kernel lock on the same path* — that identity is the whole mechanism:

| Holder | How it takes the lock | Wait / contention behavior |
| --- | --- | --- |
| `~/bin/teamkb-backup.sh` (04:30 daily) | `/usr/bin/flock -w` on fd 9, held for the whole run | Bounded wait, then skip-graceful (exit 0 — a deferred backup is expected, not an incident) |
| Plugin `brain_govern` (`bobs-big-brain-plugin/src/govern.ts` → `runGovernLocked`) | `fs-ext` native `flock(fd, 'exnb')` poll loop in `src/write-lock.ts` | 8 s bounded wait (100 ms poll), then `WriteLockBusyError` → clean "brain busy, retry" MCP result |
| Plugin `brain_transition` (`src/local-server.ts`) | Same `acquireWriteLock` | Same 8 s bounded wait → busy result |
| Compiler incremental compile (`ico compile`, `packages/cli/src/commands/compile.ts`) | Kernel `withWriteLock` (`packages/kernel/src/write-lock.ts`) — spawns `flock -w 10 -x <lock> cat`, releases by closing `cat`'s stdin | 10 s wait, then skip-graceful `ok({ ran: false })` → exit 4, retry next trigger |

Why three implementations of one lock: `/usr/bin/flock`, `fs-ext`'s native binding, and the
kernel's `flock … cat` subprocess all issue the identical `flock(2)` syscall on the identical
file, so they mutually exclude each other correctly. A mkdir- or PID-lockfile library would
**not** interoperate with `/usr/bin/flock` — that is why the plugin carries the `fs-ext` native
dep (see the rationale block at the top of the plugin's `src/write-lock.ts`).

Two writers **deliberately do not** join this lock:

- **The nightly compile wrapper** (`~/bin/teamkb-compile-daily.sh`) serializes concurrent
  compile wrappers on its own `.compile.lock` and leaves `.write.lock` free. Holding
  `.write.lock` across the whole headless agent compile deadlocked AUTO-mode promotion
  (incident 2026-07-12..14: `brain_govern` needs the same lock the wrapper was sitting on; the
  spool grew while `brain_after` never changed). The compile's *inner* durable writes still
  take `.write.lock` themselves via the paths above.
- **The registrar edge-daemon** (`bobs-big-brain-registrar/apps/edge-daemon/src/lock.ts`) uses
  a PID-file lock, which only prevents a second daemon instance. It does **not** interoperate
  with `flock(2)` and is not part of the brain writer lock.

## 2. What the lock protects — and what it does not

**Protected (the multi-artifact durable write path).** `govern`'s durable write spans SQLite +
file export + qmd index + the anchor git commit **non-atomically**; the backup's snapshot spans
`VACUUM INTO` on both DBs + staging + tar. Interleaving any two of these can skew the brain
across artifacts (risk `010-AT-RISK` R13 in the umbrella) or fork the anchor log. Under the
lock:

- spool ingest → dedupe → policy → **promotion** (the govern pass body),
- **receipt writes** (audit JSONL append, trace append, anchor commit),
- the **qmd search-index** refresh and file export,
- lifecycle transitions (`brain_transition`: DB update + audit insert + anchor append),
- the backup's quiesced snapshot,
- the incremental compile's pass re-runs + wiki index rebuild.

**Not lock-protected (by design):**

- **Reads** — `brain_search`, `brain_status`, `brain_audit_verify`, `qmd search`, exports read
  from a consistent WAL snapshot; they never take the lock.
- **`brain_capture`** — an append to the pre-admission spool only. Nothing durable is promoted
  until govern runs, so a capture racing a govern is harmless.
- **Narrow single-DB writes on the registrar side** (API, curator, mcp-server) — these rely on
  SQLite's own serialization, not the flock (see § 3 and the honest limits in § 5).
- **Renders into `outputs/`** — scratch, see `041-AT-DECR` (the wiki/outputs boundary doc).

## 3. The SQLite layer under the lock

Both stores open with the same pragmas, applied immediately after open:

- Compiler kernel (`packages/kernel/src/state.ts`, `initDatabase`): `journal_mode=WAL`,
  `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- Registrar store (`bobs-big-brain-registrar/packages/store/src/database.ts`,
  `createDatabase`): the same four, plus 0700 dir / 0600 file permissions. The qmd-adapter FTS5
  backend also runs WAL + `busy_timeout=5000`.

WAL means readers never block the writer and see a consistent snapshot; `busy_timeout=5000`
means a second *DB-level* writer waits up to 5 s at the SQLite door instead of failing
instantly. That combination is what makes N spawned MCP server processes (one per Claude/Grok
session, each opening the same DB) safe for single-statement writes — but SQLite serialization
covers only the DB file. The flock exists because govern-shaped writes span **more than the
DB**; WAL cannot make "DB + export + index + anchor" atomic.

## 4. Contention and crash behavior

**Contention blocks briefly, then yields — never queues forever.** Every holder uses a bounded
wait (8–10 s) and then backs off: the crons and the incremental compile skip gracefully (exit
0/4, retry next trigger); the plugin returns a clean "brain busy — another write in progress,
retry" tool result rather than hanging the MCP. If `flock` is not on PATH, the kernel helper
and the shell wrappers run **without** the lock and say so loudly (`locked: false` / a WARN
line) instead of silently racing — degraded, but never silent.

**Crashes cannot leave a stale lock.** `flock(2)` locks live on the open file description: a
SIGKILLed holder's lock is reclaimed by the kernel the instant the process dies. There is no
lock-file cleanup step to forget.

**A crash mid-write is covered by receipts-precede-visibility (PR #176).** Every compiled or
promoted page is written tmp → *all receipts durable* → rename-into-place. A crash therefore
leaves either (a) an orphan `.tmp`, swept into `quarantine/` by the reconciler once stale
(default > 1 h), or (b) a receipt for a page that never appeared — auditable and re-derivable
by recompiling. It can no longer leave a visible page with no receipt; historical or hand-made
violations are caught after the fact by `ico audit reconcile` (§ 5).

## 5. Honest limits — the lock is cooperative

`flock(2)` is **advisory**. A process that simply never takes the lock — a script opening
`teamkb.db` directly, a hand-`cp` into `wiki/`, an editor writing where only receipted writers
should — is not stopped by anything in this document. The umbrella blueprint's G2 already
counts ~14 registrar files that open the DB directly for writes with no substrate-level
sole-writer enforcement. The invariant "many processes, one logical writer" is a *protocol all
current writers follow*, not a wall.

The detector for protocol violations is the **corpus-accounting guard**, not the lock:

- Compiler side (shipped, PR #176): `reconcileWorkspace` / `ico audit reconcile` compares every
  visible page in the gated wiki dirs against `compilations.output_path ∪
  promotions.target_path` and quarantines (never deletes) anything unaccounted for; `ico spool
  emit` runs it as a default-on pre-emit gate.
- Registrar side (planned, blueprint G2): a reconciliation job comparing `curated_memories`
  row-count/hash-set against what `audit_events` accounts for, flagging rows with no matching
  admission event.

So the honest claim is: cooperative serialization for every writer that follows the protocol,
plus after-the-fact detection and quarantine for writers that do not. Not "corruption is
impossible" — "an out-of-band write cannot silently stay in the governed corpus."

## 6. References

- Kernel lock: `packages/kernel/src/write-lock.ts` (contract comment mirrors the shell
  wrappers); CLI usage in `packages/cli/src/commands/compile.ts`.
- Plugin lock: `bobs-big-brain-plugin/src/write-lock.ts`, `src/govern.ts` (`runGovernLocked`),
  `src/local-server.ts` (`brain_transition`).
- Crons: `~/bin/teamkb-backup.sh` (holds `.write.lock`), `~/bin/teamkb-compile-daily.sh`
  (holds `.compile.lock` only — see its "compile-level lock" comment block).
- Pragmas: `packages/kernel/src/state.ts`; registrar `packages/store/src/database.ts`.
- Crash floor + reconciler: PR #176; `packages/kernel/src/{promotion.ts,reconcile.ts}`;
  companion boundary doc `041-AT-DECR-wiki-receipted-outputs-scratch-boundary.md`.
- Blueprint: umbrella `000-docs/019-PP-PLAN-master-blueprint-epics-and-beads.md` § G4;
  umbrella `005-AT-ARCH` carries the summary addendum pointing here.
