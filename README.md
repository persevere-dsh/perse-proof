# perse-proof

**Every "done / verified" in DSH should point at something real — and the acceptance criteria must not be quietly edited by the very agent being judged.**

This is not a plugin that makes the model smarter. It **forces the mechanically checkable parts**: hashes, existence, exit codes, append-only semantics, role separation, structural invariants. It is a host-plane plugin (no client UI, no typed remote), plain ESM JavaScript, zero runtime dependencies.

---

## 1. Capabilities

| Layer | Name | What it does | Default |
|---|---|---|---|
| **A** | Evidence gate | Criteria freezing (content digest with volatile fragments normalized away) + criteria drift detection (including an `afterFailure` flag) + mechanical claim↔evidence reconciliation (file sha256; command exit code cross-checked against the session's real tool calls) + completion-claim gate + code-name gate | **on** |
| **B** | Reporting contract | Registers the system-prompt section `proof:report-contract` (`order = 2900`, i.e. `SECTION_ORDERS.TOOL_REPORT`): conclusion first, no unexplained code names, any "done" must point at a file or a command, every number must have a source | **on** |
| **C** | Budget drift | Per-turn cost observation (tokens / tool calls / new artifact paths / ledger changes) + no-progress alerts + dispatch budget reconciliation (recorded, never blocking) | **off by default** |

State is append-only: `$PERSE_PROOF_HOME/<sessionId>.jsonl` (defaults to `~/.dsh/proof/`), one `{ts, type, data}` record per line. Corrupt lines are skipped and counted; a write failure only logs a warning and **never throws into the session**.

## 2. The nine tools

| Tool | Key parameters | Notes |
|---|---|---|
| `proof_fact_set` | `key`(req) `value`(req) `evidence` `note` | Records a fact; file evidence is checked for existence + sha256, mismatches are rejected and the actual value is reported |
| `proof_facts` | `key`(optional) | Reads back the session's fact ledger |
| `proof_criteria_freeze` | `criteria`(req) `taskId` `executor` `artifacts` | Freezes criteria; the digest normalizes absolute paths / `/tmp/xxx` / `run-\w+` / ports / timestamps / `sha256:` fragments |
| `proof_criteria_amend` | `taskId` `criteria`(req) `reason`(req) | Changing criteria requires a reason; a change made right after a failure is flagged |
| `proof_criteria_check` | `taskId` | Read-only: current revision, how many changes, which ones came after a failure |
| `proof_verify_run` | `taskId` `command` `executorPath` `exitCode` `pass` `fail` `skip` `outputSha256` | Records one criteria run; if the criteria changed between runs it emits `criteria-drift` (with `afterFailure`) |
| `proof_allowlist_add` | `file`(req) `pattern`(req) `reason`(req) `failureRef`(req) `upstreamId` `reviewBy` | Records an allow-listing; missing reason or missing failure reference is an error — this fights unbounded permanent relaxation |
| `proof_claim` | `claim`(req) `level`(verified/partial/unverified) `evidence`(req) `scope` | `verified` needs a real file (with sha256) or a command this session actually ran (with exit code); a manual note alone can never be `verified` |
| `proof_claims` | — | Lists every claim and its reconciliation result |

Slash commands:

```
/proof status            one-line overview (criteria tasks / ledger entries / evidence / alerts) + top-10 alert detail; says "none" when there are none
/proof facts [key]       fact ledger (optionally a single entry)
/proof criteria [taskId] frozen revisions and change history
/proof claims            claims and reconciliation results
/proof alerts            alerts only
/proof help              usage
```

## 3. Configuration (defaults are the recommended values)

```js
{
  report:   { enabled: true,  order: 2900, maxGatesPerTurn: 1 },   // B reporting contract + shared gate quota
  jargon:   { enabled: true,  minCodenameCount: 2, extraPatterns: [] },
  claims:   { enabled: true,  gateOnCompletionClaim: true,
              strictCommandEvidence: true, allowUnmatchedCommands: false },
  criteria: { enabled: true,  driftDetect: true, requireAmendReason: true,
              normalizeVolatile: true },
  ledger:   { enabled: true,  todoDropDetect: true, writeAmplifyThreshold: 8 },
  budget:   { enabled: false, noProgressRounds: 3, dispatchBudgetCheck: true,
              tokenAlerts: false },                                  // C off by default
}
```

| Key | Default | Meaning |
|---|---|---|
| `report.enabled` | `true` | Register the reporting-contract prompt section |
| `report.order` | `2900` | Section order (falls back to this literal when `getSectionOrder('TOOL_REPORT')` is unavailable) |
| `report.maxGatesPerTurn` | `1` | Per-turn intervention budget **shared** by both gates |
| `jargon.enabled` | `true` | Enable the unexplained-code-name gate |
| `jargon.minCodenameCount` | `2` | Minimum unexplained code names in one message before intervening |
| `jargon.extraPatterns` | `[]` | Extra code-name patterns (string or `RegExp`) |
| `claims.enabled` | `true` | Enable claim reconciliation |
| `claims.gateOnCompletionClaim` | `true` | Enable the completion-claim gate |
| `claims.strictCommandEvidence` | `true` | Command evidence must match the session's real records |
| `claims.allowUnmatchedCommands` | `false` | Allow downgrading to "partial" when no matching record exists |
| `criteria.enabled` | `true` | Enable criteria freezing / drift detection |
| `criteria.driftDetect` | `true` | Compare criteria digests between runs |
| `criteria.requireAmendReason` | `true` | Require a reason when amending criteria |
| `criteria.normalizeVolatile` | `true` | Normalize volatile fragments in criteria |
| `ledger.enabled` | `true` | Enable the fact ledger |
| `ledger.todoDropDetect` | `true` | Detect to-do items that vanish without being completed |
| `ledger.writeAmplifyThreshold` | `8` | Rewrites of the same path before a write-amplification alert |
| `budget.enabled` | `false` | Master switch for layer C |
| `budget.noProgressRounds` | `3` | Consecutive turns without new artifacts / ledger changes before "no progress" |
| `budget.dispatchBudgetCheck` | `true` | Reconcile declared dispatch budgets |
| `budget.tokenAlerts` | `false` | Emit token-usage alerts |

## 4. Installation

The package declares `dsh.bundle.patch` → its own `cordis.patch.yml`, so **`dsh plugin add` mounts it as a profile layer automatically**:

```bash
cd perse-proof
npm pack                                   # → perse-proof-0.1.0.tgz
dsh plugin --profile web add perse-proof-0.1.0.tgz
```

`dsh plugin` is a pnpm forwarder: it installs the package into `~/.dsh/profiles/web/node_modules` and — **only because the package declares `dsh.bundle`** — appends `perse-proof` to `dsh.profile.bundles` in the profile's `package.json` (auto-mount).

Verify: open a new session; the tool list should show the nine tools above and `/proof` should be available. With no records yet, `/proof status` should report no alerts.

> ⚠️ Do **not** hand-edit the profile's `cordis.patch.yml` to add `- insert: {id: perse-proof, name: perse-proof}`.
> The bundle layer and a manual insert row are mutually exclusive: having both collides on the loader's unique id (rule R-07), and a mistyped `name:` **fails silently with zero diagnostics**. The bundle route needs no patch-file editing at all.
> (A manual insert row is only needed for packages that do **not** declare `dsh.bundle` — this one does.)

### Shadow verification (never touches the running 3080)

```bash
node scripts/verify-load.mjs --dry     # print the commands only
node scripts/verify-load.mjs           # isolated DSH_HOME + port ≥3199: pack → add → boot → assert → full cleanup
```

The script boots the web profile with an **isolated `DSH_HOME`** (under `/tmp`) and a port **≥ 3199**, asserts auto-mount, the composed tree, a successful boot and tool registration, then kills the process and confirms the port was released. The real GUI on **3080 is never touched** (`--port 3080` is rejected outright).

## 5. Tests

```bash
node tests/run-all.mjs      # runs T1–T14 in order with a per-case PASS/FAIL matrix and a summary; non-zero exit on any failure
node scripts/pack-check.mjs # npm pack --dry-run --json: checks the artifact list and the mounting preconditions
```

All tests use `node:test` + `node:assert/strict`, are **zero-dependency and offline**, do not need a real DSH instance, and isolate their writes via `PERSE_PROOF_HOME` / temp directories with post-test cleanup.

## 6. Known Limitations (nothing sugar-coated)

1. **Whether the criteria are sufficient (semantic adequacy) is out of scope.** The plugin cannot judge whether the criteria text actually covers what must hold.
2. **Whether layer-A evidence supports a layer-B conclusion is out of scope.** It only checks mechanical facts — hashes, existence, exit codes — not whether the inference holds.
3. **Naming clarity is out of scope.** It can require code names to be translated into plain language in user-facing replies; it cannot make the names themselves good.
4. **Whether scope expansion is justified is out of scope.** The budget module only observes; it never blocks or adjudicates.
5. **"We don't yet know what to verify" (end-to-end coverage discovery) is out of scope.** This plugin only guarantees that **the criteria you wrote down are not quietly changed** — it cannot discover what you forgot to verify.
6. **This plugin is observation + gates; it does not replace a human acceptance decision.** It will not, and should not, sign off for you.

## 7. Implementation note: plain JS with zero dependencies, and the deviation from the perse TS convention

- **Language/build**: v1 is **plain ESM JavaScript with no build step and zero runtime dependencies** (only `node:` builtins).
- **Why the deviation**: the third-party host plugin already running on this machine (`dsh-zai-search-tools`) has exactly this shape and works on DSH rc.2; this skips three toolchain risk points (`tsc` / `tsdown` / typert); typert is only required for typed remotes, and this plugin has no client half.
- **The honest difference**: this repository **does not** follow the `perse-updater` / `perse-cua` TypeScript + `tsc -b` + `tsdown` convention. There is no `lib/types/*.d.ts`, no `src/`, no build script.
- **Plan**: migrate to TS once the interfaces settle (when the criteria/evidence data model stops moving), adding type declarations and the packaging chain while keeping the same three exports (`name` / `apply`, no `Config` export) and the same on-disk file format.
- **Profile dependency constraint**: DSH profiles run with `autoInstallPeers:false`, so this package has **zero dependencies and zero peers**.

---

Part of Persevere with DSH
