# Contextivity downstream T3 distribution

> Fork-only operations for `Contextivity/t3code`. Official T3 releases stay on `pingdotgg/t3code`.

This is a long-term maintained downstream, not an upstream PR. The generic ACP/sub-agent patch
stack lives in the T3 server/provider tree. Everything that builds, publishes, or installs the
forked server lives under `contextivity/` plus two GitHub workflows. Keep it that way so an
upstreamable ACP review does not have to read fleet machinery.

## What this is

The Mac desktop app stays the **official** T3 nightly. The background server on the fleet is the
**forked** server: exact official nightly source plus the Contextivity patch stack.

- Protocol-visible `serverVersion` is the official upstream nightly (from `apps/server/package.json`).
- `contextivityRevision` is a separate git SHA recorded on disk and in the candidate manifest.
- Official clients that match that nightly stay compatible. They must not be told they are running a
  different T3 version.
- The internal updater is `t3-ctx` / `t3-ctx fleet`. Never `npx t3@<version>` and never npm
  `t3@<version>`.

## Initial fork setup

1. The organization fork is `https://github.com/Contextivity/t3code`.
2. Default branch permanently contains the small Contextivity patch stack (generic ACP Registry,
   sub-agent events, this distribution tree, and the npm self-update suppression).
3. Add git remotes:

   ```sh
   git remote add origin https://github.com/pingdotgg/t3code.git
   git remote add contextivity https://github.com/Contextivity/t3code.git
   ```

4. Automation tracks official `pingdotgg/t3code` **nightly release tags**
   (`vX.Y.Z-nightly.YYYYMMDD.N`), not arbitrary newer `main` commits.

## GitHub permissions, secrets, and OIDC

Required on `Contextivity/t3code`:

- Workflow permissions: `contents: write`, `issues: write`, `id-token: write`, `attestations: write`.
- No private signing key. Candidate provenance is GitHub artifact attestations via OIDC
  (`actions/attest-build-provenance`).
- Optional: `CONTEXTIVITY_GITHUB_TOKEN` for hosts that cannot use `gh`. Do not persist or log it.
- Mirror/base URL overrides (`CONTEXTIVITY_T3_GITHUB_API`, `CONTEXTIVITY_T3_GITHUB_BASE`) are
  refused unless `CONTEXTIVITY_T3_TRUST_MIRROR=1` is set. That is an explicit trust policy, not a
  default.

Host updater auth is an explicit token or an already-authenticated `gh` CLI. Credentials never go
into manifests, inventory files, or logs.

## Branch and release model

1. For each new official nightly tag, the candidate workflow fetches that **exact** tag and merges
   it into the downstream branch, preserving Contextivity commits.
2. If the merge conflicts or focused tests fail, the workflow fails closed: no candidate publish, no
   fleet pointer movement, prior version stays active. It opens a deduplicated issue titled
   `Contextivity T3 nightly sync failed: <tag>` with label `contextivity-maintenance`.
3. Successful runs produce an immutable **candidate** (archives + manifest + SHA-256 + attestations).
   They do **not** move `nightly` or `stable`.
4. `nightly` advances only from the manual promote workflow after artifacts/tests passed and the
   installed official Mac desktop version is confirmed equal to `upstreamVersion`.
5. `stable` is a known-good pointer for rollback, promoted the same way.

Candidate tag: `contextivity-candidate/<upstreamVersion>-ctx.<revision>`  
Pointers: GitHub releases `contextivity-nightly` and `contextivity-stable` (pointer JSON only).

## Candidate flow

Scheduled every three hours (offset from upstream) or `workflow_dispatch` with an exact tag.

`.github/workflows/contextivity-candidate.yml` is a thin wrapper. Logic lives in
`contextivity/src/`:

1. `discover-upstream` — newest official nightly tag/commit.
2. `sync-tag` — exact-tag merge, version/commit validation, fail-closed on conflict.
3. Downstream unit tests plus generic ACP/sub-agent tests, server typecheck, server build.
4. Per-platform archives: Linux x64/arm64, macOS x64/arm64. Native addons (`node-pty`,
   `msgpackr-extract`, and the rest of the CLI external closure) are platform-specific, so the
   artifact is not platform-neutral.
5. `write-candidate-manifest` — schema version, upstream version/tag/commit, Contextivity revision,
   build revision, Node engine, artifact name/size/SHA-256, created time, compatibility.
6. GitHub OIDC attestations. Checksums are sorted SHA256SUMS files.
7. Immutable GitHub release `contextivity-candidate/<upstreamVersion>-ctx.<revision>`. Re-runs must
   not overwrite that tag. The merge commit is pushed to `contextivity-sync/<run_id>` so later jobs
   can check it out, then the default branch fast-forwards only after the candidate exists.

The candidate does not publish npm package `t3`. Hosts install with `t3-ctx updater update`.

## Manual promotion

`.github/workflows/contextivity-promote.yml`:

- Inputs: `channel` (`nightly` or `stable`), exact candidate identity, official Mac client version.
- Fails closed if the Mac version ≠ manifest `upstreamVersion`.
- Does not overwrite or disable the official desktop app or its updater.
- Writes the channel pointer only.

Local equivalent:

```sh
t3-ctx promote --channel nightly --manifest manifest.json --mac-client-version "$VERSION"
```

## Three-host inventory

Copy `contextivity/inventory.example.json`. Use SSH **config aliases** and one `via: "local"` host.
Do not put hostnames, usernames, home paths, or tokens in the file.

Typical mapping (configure aliases yourself): workstation (Mac, official desktop + forked server),
builder (second Mac), lab (Linux).

```sh
t3-ctx fleet update --inventory ~/.config/contextivity/t3-inventory.json \
  --manifest manifest.json --mac-client-version "$VERSION"
```

The coordinator resolves **one** manifest, stages every host, then activates. If staging fails,
none activate. If activate/health fails, every host that switched is rolled back.

## Host updater

Layout:

```
~/.contextivity/t3/
  versions/<upstreamVersion>-ctx.<revision>/
  current -> versions/...
  previous -> versions/...
```

Override root with `CONTEXTIVITY_T3_HOME`.

```sh
t3-ctx updater status
t3-ctx updater check --channel nightly
t3-ctx updater update --version 0.0.34-nightly.20260822.2-ctx.abc1234 --stage-only
t3-ctx updater update --channel nightly
t3-ctx updater stage --manifest manifest.json --archive t3-server-linux-x64.tar.gz
t3-ctx updater activate --version 0.0.34-nightly.20260822.2-ctx.abc1234
t3-ctx updater rollback
```

Each host authenticates to GitHub with `CONTEXTIVITY_GITHUB_TOKEN` or an already-logged-in `gh`.
`update` downloads the exact candidate (or nightly/stable pointer, then that candidate), verifies
SHA-256, and verifies GitHub attestations when authenticated. Preflight is bounded and must not
advertise an upstream npm install. Cutover is an atomic symlink rename. `--stage-only` stops before
cutover so the fleet coordinator can activate every host together.

The staged tree sets `CONTEXTIVITY_T3_DISTRIBUTION=1`, which makes the server omit
`serverSelfUpdate` and refuse npm `t3@<version>` installs. Same-version official clients keep
working. Unknown downstream metadata is local/optional.

## Conflict recovery

1. Read the `contextivity-maintenance` issue for the exact tag.
2. Reproduce: `t3-ctx sync-tag --tag vX.Y.Z-nightly.YYYYMMDD.N`.
3. Resolve the patch stack against that tag only. Do not fast-forward past a newer untagged main.
4. Re-run the candidate workflow with the same tag.
5. Promote only after the Mac desktop version matches.

## Exact-version diagnostics

```sh
t3-ctx updater status
git -C ~/.contextivity/t3/current rev-parse --short=7 HEAD   # if a checkout exists
python3 -c 'import json,pathlib; print(json.loads(pathlib.Path.home().joinpath(".contextivity/t3/current/contextivity-distribution.json").read_text()))'
```

`protocolVersion` / `upstreamVersion` must equal the official client. `installId` includes
`-ctx.<revision>` for rollback.

## Official Mac client sync

Promotion and fleet gates compare the installed/declared official Mac app version with
`manifest.upstreamVersion`. Set `CONTEXTIVITY_T3_MAC_CLIENT_VERSION` or pass
`--mac-client-version`. On macOS, `defaults read "/Applications/T3 Code.app/Contents/Info"
CFBundleShortVersionString` is the usual reader. A mismatch fails closed. This pipeline never
writes into `/Applications/T3 Code.app`.

## Contextivity agent versions are independent

Stable/nightly **Contextivity agent** releases (the ACP executable, for example
`contextivity-agent --mode acp`) are versioned in the Contextivity agent repo. They are not this
T3 downstream and must not share these pointers, archives, or updater layout. T3's ACP Registry
settings point at whatever agent binary the host already has.

## Commands

```sh
node --experimental-strip-types contextivity/src/cli.ts --help
node --test --experimental-strip-types contextivity/src/*.test.ts
```

`contextivity/bin/t3-ctx` is a POSIX wrapper around that CLI.
