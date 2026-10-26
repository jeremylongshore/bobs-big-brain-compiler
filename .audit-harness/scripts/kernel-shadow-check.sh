#!/usr/bin/env bash
# kernel-shadow-check.sh — flag local re-declarations of kernel-owned contracts.
#
# The kernel @intentsolutions/core is the single source of truth for the
# canonical platform contracts: the gate-result/v1 predicate shape and the
# evidence-bundle payload shape (and, downstream, the authoring/v1 artifact
# schemas). This repo (audit-harness) is a CONSUMER of those contracts — it
# emits gate-result rows and EvidenceBundles, it must NOT re-define their
# shapes. A local re-declaration ("shadow") is supply-chain drift: the harness
# would validate against its own stale copy instead of the kernel the dashboard
# verifies with.
#
# This detector greps for files that re-DECLARE a kernel-owned schema shape,
# as opposed to REFERENCING the kernel (importing from @intentsolutions/core,
# or naming the predicate URI in a gate_id string — both legitimate).
#
# A SHADOW is:
#   * a JSON Schema document whose "$id" claims a kernel-owned canonical id
#     (evals.intentsolutions.io/gate-result/... or .../evidence-bundle/...), OR
#   * a TS/Python source file that DEFINES (not imports) a GateResultV1 /
#     EvidenceBundle / EvidenceBundlePayload type/interface/class.
#
# NOT a shadow (allowlisted):
#   * tests/fixtures/**   — a frozen offline copy of the kernel schema, pinned
#                           deliberately so the regression suite runs without a
#                           network fetch. This is a test pin, not a contract.
#   * ci/**               — the CI-only emitter; it IMPORTS the kernel validators
#                           (@intentsolutions/core/validators/v1/*) and only
#                           declares emitter-internal plumbing types.
#   * schemas/conform/**  — the harness's OWN deterministic structural floor for
#                           authoring artifacts, namespaced under conform/v1.
#                           This is a separate, shallower contract from the
#                           kernel authoring/v1 validity SSoT — intentionally
#                           different, not a re-declaration.
#   * **/dist/**, **/build/**
#                         — compiler output. Whatever a bundle or .d.ts contains
#                           is a mechanical restatement of source that this
#                           detector already checks; flagging both reports one
#                           authoring decision twice and cannot be fixed in the
#                           generated file.
#
# NOT a shadow (by construction — the anchors below):
#   * `export { type EvidenceBundle, ... } from "@intentsolutions/core/..."`
#     A re-export entry names the kernel's type in order to FORWARD it. That is
#     the single-source-of-truth pattern this detector exists to encourage, and
#     matching it was a false positive that flagged three j-rig files for doing
#     exactly the right thing. The identifier in a re-export or import list is
#     followed by `,`, `}`, or a newline — never by declaration syntax — so the
#     anchors require `=`, `{`, `<`, `(`, `:`, `extends`, or `implements` after
#     the name.
#
# ## Third class: a STALE KERNEL RANGE is a shadow too
#
# Re-declaring a kernel type is only ONE way to end up validating against a stale
# contract. The other is to declare a dependency range that cannot resolve forward
# to the kernel everyone else is on. The harm is identical — the consumer validates
# against a contract copy the platform has moved past — so it belongs in the same
# detector rather than in a separate tool nobody remembers to run.
#
# This is not hypothetical. bobs-big-brain-compiler pinned
# `"@intentsolutions/core": "^0.1.1"` while the kernel shipped 0.10.0. A caret range
# on a 0.x major is capped at that MINOR (`^0.1.1` == `>=0.1.1 <0.2.0`), so it could
# never reach 0.10.0 on its own — nine minor versions of silent drift. This detector
# reported that repo CLEAN, because it only looked for re-declared types. It was
# blind to the exact failure mode it exists to prevent.
#
# Range forms understood (anything else is reported as UNKNOWN, never assumed OK):
#   ^0.Y.Z / ~0.Y.Z  -> admits 0.Y.* only          (0.x caret does NOT cross minors)
#   ^X.Y.Z (X>=1)    -> admits X.*
#   ~X.Y.Z (X>=1)    -> admits X.Y.*
#   X.Y.Z            -> exact; admits only itself
#   >=… / * / x      -> open; admits latest
#   workspace:…      -> monorepo link; not a published-range concern
#
# Background: iah-E02 (the architecture question — peerDep-only vs full TS port
# vs second-emitter — that historically blocked a standing kernel-shadow check)
# is now CLOSED, so this detector ships.
#
# Exit codes:
#   0 — no shadows found (or shadows found in advisory/default mode)
#   1 — shadows found AND --strict was passed (gate)
#
# Default mode is ADVISORY (exit 0, annotate). Pass --strict to make a shadow
# a hard failure. CI runs the advisory mode so the lane is green while still
# surfacing any shadow as a GitHub annotation.

set -euo pipefail

# Bash version floor: these gates rely on bash 4+ features. Refuse early with a
# clear message on bash 3.x (e.g. macOS system bash) instead of failing later
# with a cryptic syntax error (jcgw).
[ "${BASH_VERSINFO:-0}" -ge 4 ] || { echo 'audit-harness requires bash >= 4' >&2; exit 3; }

STRICT=0
ROOT="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --root) ROOT="${2:-.}"; shift 2 ;;
    --help|-h)
      echo "Usage: kernel-shadow-check.sh [--strict] [--root DIR]"
      echo "  Flags local re-declarations of kernel-owned gate-result/evidence-bundle contracts,"
      echo "  AND @intentsolutions/core dependency ranges that cannot resolve to the current kernel."
      echo "  Default: advisory (exit 0). --strict: exit 1 on any shadow."
      echo ""
      echo "  KERNEL_LATEST_VERSION=X.Y.Z  skip the npm lookup and compare against X.Y.Z"
      echo "                               (used by the test suite; also lets CI pin the check)"
      exit 0 ;;
    *) echo "kernel-shadow-check: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# Paths that are allowed to carry a kernel-shaped artifact (see header).
# A match is a shadow only if it is OUTSIDE all of these.
is_allowlisted() {
  case "$1" in
    tests/fixtures/*) return 0 ;;
    ci/*)             return 0 ;;
    schemas/conform/*) return 0 ;;
    node_modules/*)   return 0 ;;
    .git/*)           return 0 ;;
    dist/*|*/dist/*)   return 0 ;;
    build/*|*/build/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The class-2 declaration anchor (see the block comment above the class-2 loop).
CLASS2_PATTERN='(^|[[:space:]])((export|declare|abstract)[[:space:]]+)*(interface|class|type)[[:space:]]+(EvidenceBundlePayload|EvidenceBundle|GateResultV1)([[:space:]]*[{<(:=]|[[:space:]]+(extends|implements)[[:space:]])'

# is_kernel_imported FILE SYMBOL — true when SYMBOL appears inside an import or
# re-export statement that resolves to @intentsolutions/core in FILE. Statements
# are reconstructed by joining the file and splitting on ';', so a multi-line
# `import {\n  A,\n  B,\n} from "@intentsolutions/core/..."` is handled.
is_kernel_imported() {
  local file="$1" sym="$2"
  awk -v sym="$sym" '
    { buf = buf " " $0 }
    END {
      n = split(buf, stmts, /;/)
      for (i = 1; i <= n; i++) {
        if (stmts[i] ~ /@intentsolutions\/core/ &&
            stmts[i] ~ ("(^|[^A-Za-z0-9_])" sym "([^A-Za-z0-9_]|$)")) { found = 1 }
      }
      exit(found ? 0 : 1)
    }
  ' "$file"
}

# is_kernel_derivation FILE LINE — true when LINE is a type alias whose right-hand
# side is a pure derivation of a kernel-imported symbol. Anything else (an
# interface, a class, a structural type literal, a union, or a derivation from a
# locally-declared schema) returns false and is treated as a real declaration.
is_kernel_derivation() {
  local file="$1" line="$2" rhs sym
  # Only `type X = ...` can derive; interface/class always declare a shape.
  [[ "$line" =~ (^|[[:space:]])((export|declare|abstract)[[:space:]]+)*type[[:space:]] ]] || return 1
  [[ "$line" == *=* ]] || return 1

  rhs="${line#*=}"
  # Strip comments, trailing semicolon, and surrounding whitespace.
  rhs="${rhs%%//*}"
  rhs="$(printf '%s' "$rhs" | sed -E 's/[[:space:]]*;?[[:space:]]*$//; s/^[[:space:]]+//')"

  if [[ "$rhs" =~ ^z\.(infer|input|output)\<typeof[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)\>$ ]]; then
    sym="${BASH_REMATCH[2]}"
  elif [[ "$rhs" =~ ^typeof[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
    sym="${BASH_REMATCH[1]}"
  elif [[ "$rhs" =~ ^([A-Za-z_][A-Za-z0-9_]*)$ ]]; then
    sym="${BASH_REMATCH[1]}"
  else
    return 1   # structural / union / intersection → a real declaration
  fi

  is_kernel_imported "$file" "$sym"
}

shadows=()

# 1. JSON Schema documents claiming a kernel-owned canonical $id.
#    The kernel owns gate-result/<ver> and evidence-bundle/<ver> ids under
#    evals.intentsolutions.io. conform/v1 ids are the harness's own (allowlisted
#    structurally by the schemas/conform/ path skip below).
#
#    EXEMPT: a redirect stub. A document that carries an `x-redirect` marker is
#    the ratified discoverability pattern (Blueprint B § 7.0 "Lab specs/ MAY host
#    redirect stubs"; ISEDC Session 5 DR-018 § 6.4 Option α-minus) — it claims the
#    id in order to $ref the kernel's schema, which is referencing, not
#    re-declaring. The lab's own schema-drift.yml already allowlists exactly this
#    marker; flagging it here would contradict a gate the platform ratified.
# shellcheck disable=SC2016  # the grep pattern's $id is a literal, not a shell var
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  rel="${f#./}"
  is_allowlisted "$rel" && continue
  grep -qE '"x-redirect"[[:space:]]*:' "$f" && continue
  shadows+=("$rel  (re-declares a kernel-owned JSON Schema \$id)")
done < <(grep -rIlE '"\$id"[[:space:]]*:[[:space:]]*"https://evals\.intentsolutions\.io/(gate-result|evidence-bundle)/' \
            --include='*.json' --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)

# 2. TS/Python source DEFINING (not importing, not re-exporting) a kernel-owned
#    type/class. The keyword alone is not enough to tell a definition from a
#    re-export — `export { type EvidenceBundle } from "@intentsolutions/core"`
#    carries `type EvidenceBundle` too. What separates them is what FOLLOWS the
#    identifier, so the anchor requires actual declaration syntax:
#
#      interface X {        interface X<T>        interface X extends Y
#      class X {            class X<T>            class X extends Y
#      class X(Base):       class X:              class X implements Y   (py/ts)
#      type X =             type X<T> =
#
#    A re-export or import entry is followed by `,`, `}`, `;`, or end-of-line and
#    therefore cannot match. `declare`/`abstract` prefixes are tolerated.
#
#    EXEMPT: a pure DERIVATION of a kernel-imported symbol, e.g.
#      export type EvidenceBundle = z.infer<typeof EvidenceBundlePayloadSchema>;
#    where `EvidenceBundlePayloadSchema` is imported/re-exported from
#    @intentsolutions/core in the same file. Such an alias has no independent
#    shape — it is defined BY the kernel schema and changes when the kernel
#    changes, so it cannot drift, which is the entire harm this detector guards
#    against. Only three RHS forms qualify (`z.infer|input|output<typeof S>`,
#    `typeof S`, bare `S`); anything structural (`{`, `|`, `&`) is a real
#    declaration and still flags, as does a derivation from a NON-kernel symbol.
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  rel="${f#./}"
  is_allowlisted "$rel" && continue

  # Per-LINE triage: a file is reported only if it holds at least one match that
  # is not an exempt kernel derivation.
  real_hits=()
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    lineno="${hit%%:*}"
    text="${hit#*:}"
    if is_kernel_derivation "$f" "$text"; then continue; fi
    real_hits+=("$lineno")
  done < <(grep -nE "$CLASS2_PATTERN" "$f" 2>/dev/null || true)

  [[ ${#real_hits[@]} -eq 0 ]] && continue
  lines="$(IFS=,; echo "${real_hits[*]}")"
  shadows+=("$rel  (defines a kernel-owned type at line(s) ${lines} — should import from @intentsolutions/core)")
done < <(grep -rIlE "$CLASS2_PATTERN" \
            --include='*.ts' --include='*.py' --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)

# 3. @intentsolutions/core dependency ranges that cannot resolve to the current
#    kernel. See the header — a stale range and a re-declared type produce the same
#    outcome (validating against a contract the platform has moved past), so both
#    are shadows.

KERNEL_PKG="@intentsolutions/core"

# Resolve the current published kernel. KERNEL_LATEST_VERSION short-circuits the
# network (deterministic tests, pinned CI). A failed lookup SKIPS this class loudly
# — it never silently passes, because "we could not check" and "it is fine" are
# different answers and only one of them is safe to report as clean.
kernel_latest="${KERNEL_LATEST_VERSION:-}"
kernel_lookup_note=""
if [[ -z "$kernel_latest" ]]; then
  if command -v npm >/dev/null 2>&1; then
    kernel_latest="$(npm view "$KERNEL_PKG" version 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  if [[ -z "$kernel_latest" ]]; then
    kernel_lookup_note="could not resolve ${KERNEL_PKG} from npm (offline, or npm unavailable)"
  fi
fi

# Compare strict MAJOR.MINOR.PATCH values. Echoes -1, 0, or 1 and ignores
# build metadata because SemVer precedence ignores it. Callers validate the
# shape before invoking this helper.
version_cmp() {
  local a="${1%%+*}" b="${2%%+*}" ai bi
  local -a av bv
  IFS='.' read -r -a av <<< "$a"
  IFS='.' read -r -a bv <<< "$b"
  for i in 0 1 2; do
    ai="${av[$i]}"; bi="${bv[$i]}"
    if (( 10#$ai < 10#$bi )); then echo -1; return; fi
    if (( 10#$ai > 10#$bi )); then echo 1; return; fi
  done
  echo 0
}

# Does RANGE admit VERSION? Echoes: admits | stale | unknown
# Deliberately narrow: every form it does not positively understand returns
# "unknown" and is surfaced, never assumed OK.
range_admits() {
  local range="$1" latest="$2"

  case "$range" in
    workspace:*|link:*|file:*|portal:*) echo "admits"; return ;;   # local link, not a published range
    ""|"*"|x|X|latest)                  echo "admits"; return ;;
  esac

  # Compound / hyphen / wildcard-inside ranges (`0.1.x || ^0.2.0`, `1.2.0 - 1.4.0`,
  # `^0.1 <0.3`) are NOT evaluated. Composing them correctly is a real semver
  # implementation, and half-parsing one produces a confident wrong answer — the
  # earlier draft classified `0.1.x || ^0.2.0` as STALE because the leading digit
  # made it look exact. Report unknown and let a human read it.
  if [[ "$range" == *"||"* || "$range" == *" "* || "$range" == *"x"* || "$range" == *"X"* || "$range" == *"-"* ]]; then
    echo "unknown"; return
  fi

  local op="" spec="$range"
  case "$range" in
    ^*) op="caret"; spec="${range#^}" ;;
    ~*) op="tilde"; spec="${range#\~}" ;;
    ">="*) op="gte"; spec="${range#>=}" ;;
    ">"*) op="gt"; spec="${range#>}" ;;
    [0-9]*) op="exact" ;;
    *) echo "unknown"; return ;;
  esac

  # spec must be strictly MAJOR.MINOR.PATCH (an optional +build suffix is fine;
  # a `-prerelease` is excluded above with the hyphen ranges). Anchored, so a
  # trailing surprise cannot slip through the way a glob let it.
  if [[ ! "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\+[0-9A-Za-z.]+)?$ ]]; then
    echo "unknown"; return
  fi

  local smaj smin cmp latest_major latest_minor spec_plain
  spec_plain="${spec%%+*}"
  smaj="${spec%%.*}"
  smin="${spec#*.}"; smin="${smin%%.*}"
  latest_major="${latest%%.*}"
  latest_minor="${latest#*.}"; latest_minor="${latest_minor%%.*}"
  cmp="$(version_cmp "$latest" "$spec_plain")"

  if [[ "$op" == "exact" ]]; then
    [[ "$cmp" == "0" ]] && echo "admits" || echo "stale"
    return
  fi

  if [[ "$op" == "gte" ]]; then
    [[ "$cmp" -ge 0 ]] && echo "admits" || echo "stale"
    return
  fi

  if [[ "$op" == "gt" ]]; then
    [[ "$cmp" -gt 0 ]] && echo "admits" || echo "stale"
    return
  fi

  if [[ "$op" == "tilde" ]]; then
    # `~X.Y.Z` admits [X.Y.Z, X.(Y+1).0). The lower-bound comparison matters:
    # ~0.10.1 must NOT admit an older 0.10.0 kernel.
    if [[ "$smaj" == "$latest_major" && "$smin" == "$latest_minor" && "$cmp" -ge 0 ]]; then
      echo "admits"
    else
      echo "stale"
    fi
    return
  fi

  # THE 0.x TRAP: ^0.1.1 admits [0.1.1, 0.2.0), never 0.10.0. For ^0.0.Z,
  # semver narrows the upper bound to the next patch, so only the exact patch
  # is admitted. A caret on >=1.0.0 admits the same major, but still respects
  # the lower bound.
  if [[ "$smaj" == "0" ]]; then
    if [[ "$smin" == "0" ]]; then
      [[ "$cmp" == "0" ]] && echo "admits" || echo "stale"
    elif [[ "$smaj" == "$latest_major" && "$smin" == "$latest_minor" && "$cmp" -ge 0 ]]; then
      echo "admits"
    else
      echo "stale"
    fi
    return
  fi

  if [[ "$smaj" == "$latest_major" && "$cmp" -ge 0 ]]; then echo "admits"; else echo "stale"; fi
}

stale_ranges=()
unknown_ranges=()
skipped_note=""

if [[ -n "$kernel_lookup_note" ]]; then
  skipped_note="$kernel_lookup_note"
else
  while IFS= read -r pkgjson; do
    [[ -z "$pkgjson" ]] && continue
    rel="${pkgjson#./}"
    is_allowlisted "$rel" && continue
    # Extract the declared range for the kernel from any dependency block.
    declared="$(grep -oE "\"${KERNEL_PKG}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$pkgjson" 2>/dev/null \
                 | head -n1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' || true)"
    [[ -z "$declared" ]] && continue
    verdict="$(range_admits "$declared" "$kernel_latest")"
    case "$verdict" in
      stale)
        stale_ranges+=("$rel  (${KERNEL_PKG}: \"${declared}\" cannot resolve to ${kernel_latest})") ;;
      unknown)
        unknown_ranges+=("$rel  (${KERNEL_PKG}: \"${declared}\" — range form not understood; verify by hand)") ;;
    esac
  done < <(grep -rIl "\"${KERNEL_PKG}\"" --include='package.json' \
              --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true)
fi

if [[ ${#shadows[@]} -eq 0 && ${#stale_ranges[@]} -eq 0 && ${#unknown_ranges[@]} -eq 0 ]]; then
  if [[ -n "$skipped_note" ]]; then
    echo "kernel-shadow-check: no re-declarations found."
    echo "kernel-shadow-check: SKIPPED the kernel-range check — ${skipped_note}." >&2
    echo "  Set KERNEL_LATEST_VERSION=X.Y.Z to check offline. Not reporting fully clean." >&2
    exit 0
  fi
  echo "kernel-shadow-check: clean — no re-declarations, and every ${KERNEL_PKG} range resolves to ${kernel_latest}."
  exit 0
fi

if [[ ${#stale_ranges[@]} -gt 0 ]]; then
  echo "kernel-shadow-check: found ${#stale_ranges[@]} stale kernel range(s) — current kernel is ${kernel_latest}:" >&2
  for r in "${stale_ranges[@]}"; do
    echo "  - $r" >&2
    file_only="${r%%  *}"
    echo "::warning file=${file_only}::stale kernel range — this range cannot resolve to ${KERNEL_PKG}@${kernel_latest}; the package validates against a contract the platform has moved past"
  done
fi

if [[ ${#unknown_ranges[@]} -gt 0 ]]; then
  echo "kernel-shadow-check: ${#unknown_ranges[@]} kernel range(s) could not be evaluated:" >&2
  for r in "${unknown_ranges[@]}"; do
    echo "  - $r" >&2
    file_only="${r%%  *}"
    echo "::warning file=${file_only}::kernel range not understood by kernel-shadow-check — verify by hand"
  done
fi

if [[ ${#shadows[@]} -eq 0 ]]; then
  if [[ "$STRICT" -eq 1 ]]; then
    echo "kernel-shadow-check: --strict — failing the build." >&2
    exit 1
  fi
  echo "kernel-shadow-check: advisory mode — not failing the build (pass --strict to gate)." >&2
  exit 0
fi

echo "kernel-shadow-check: found ${#shadows[@]} potential kernel shadow(s):" >&2
for s in "${shadows[@]}"; do
  echo "  - $s" >&2
  # GitHub Actions annotation (surfaces in the PR even in advisory mode).
  file_only="${s%%  *}"
  echo "::warning file=${file_only}::kernel shadow — this file re-declares a kernel-owned contract; reference @intentsolutions/core instead"
done

if [[ "$STRICT" -eq 1 ]]; then
  echo "kernel-shadow-check: --strict — failing the build." >&2
  exit 1
fi

echo "kernel-shadow-check: advisory mode — not failing the build (pass --strict to gate)." >&2
exit 0
