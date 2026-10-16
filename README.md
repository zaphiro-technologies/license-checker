# License Checker GitHub Action

License Checker is a cross-platform Node 24 GitHub Action that checks dependency
license compatibility. It accepts the dependency-related parts of the License
Eye configuration shape and normalizes license metadata to SPDX identifiers and
expressions.

## Usage

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: zaphiro-technologies/license-checker@v1
    with:
      config: .licenserc.yaml
      token: ${{ github.token }}
      log: info
```

The action is dependency check-only. It does not modify files or scan
source-file headers. It writes a job summary and workflow annotations. When a
pull request has a failure or distribution-review warning and a token is
available, it creates or updates one managed pull-request comment.

## Configuration

The default configuration file is `.licenserc.yaml`. The following License
Eye-style configuration is supported:

```yaml
header:
  # Used only as the project license for dependency compatibility.
  license:
    spdx-id: Apache-2.0

dependency:
  files:
    - go.mod
  licenses:
    - name: github.com/zaphiro-technologies/roger
      license: Apache-2.0
    - name: acme-package
      match: 'Copyright \(c\) Acme.*All rights reserved'
      license: LicenseRef-Acme-Proprietary
  exceptions:
    - name: gsap
      version: "3.15.0"
      url: https://gsap.com/community/standard-license/
      reason: Approved by legal for use outside prohibited GSAP uses.
```

Supported dependency inputs are:

- JavaScript: `package.json` with `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, or `pnpm-lock.yaml`
- Go: `go.mod`, resolved with `go list -mod=readonly -m all`
- Python: `poetry.lock`, `Pipfile.lock`, or an exhaustive, fully pinned
  `requirements.txt`; `pyproject.toml` is supported with an adjacent
  `poetry.lock`

Copyable configuration and workflow examples are in [`examples/`](examples/).
Each ecosystem example shows the dependency file entry to use in
`dependency.files`; lockfiles should be generated and maintained by that
ecosystem's package manager.

Yarn `workspace:` entries represent local packages and are ignored; only
third-party dependencies are checked.

The checker requires exact resolved versions before evaluating dependency
licenses. JavaScript dependencies without a supported lockfile, Python ranges
without a supported lockfile or exact `==`/`===` pin, and incomplete Go module
graphs are reported as unresolved and fail the check. `requirements.txt` must
list the complete resolved set; includes, constraints, and options must be
expanded before checking.

Go module versions are computed from `go.mod` with the Go tool's build list. The
action environment must have Go installed when checking Go dependencies.
`go.sum` contains integrity hashes and is not used as a dependency graph; a
`go.sum`-only configuration fails. Replaced Go modules are reported unresolved
because the replacement source may have different license terms.

When `pyproject.toml` has an adjacent `poetry.lock`, its exact direct and
transitive package versions are checked. Python license resolution uses PyPI's
SPDX `license_expression` metadata when available.

For dependencies with exact versions, license resolution uses configured
overrides first, then lockfile metadata, installed npm metadata, public package
registries, and repository license files. When PyPI metadata has no usable
license, the checker follows a linked public GitHub repository and uses its
license metadata or LICENSE text. Unresolved versions or licenses are reported
as `Unknown` and fail compatibility checks.

Use `dependency.exceptions` only for a manually reviewed non-SPDX license. Every
entry requires an exact dependency `name` and `version`, a reference `url`, and
an audit `reason`. It takes precedence over registry resolution and is reported
as `approved-exception` with the provided terms link and reason; it is not
represented as SPDX-compatible. Add a separate exception for each package, such
as `@gsap/react`.

The `dependency.require_fsf_free`, `dependency.require_osi_approved`, and
`dependency.excludes` fields are accepted. The `header.license.spdx-id` field
identifies the project license used for compatibility. SPDX `AND`, `OR`, and
`WITH` expressions are supported.

Entries in `dependency.licenses` can include an optional `match` regular
expression. A license entry with `match` applies only when the dependency name
and optional version match and the expression matches available license data.
The checker tries declared license metadata first, then downloaded repository
LICENSE text when that text is available. Entries without `match` remain
unconditional name/version overrides and take precedence over pattern entries.
Pattern entries are checked in configuration order for each source. Invalid
regular expressions fail configuration loading. Use this for reviewed,
package-specific cases; a copyright notice alone does not establish the terms of
a license.

Compatibility decisions for the supported license families follow the
[LicenseCheck.io compatibility matrix](https://licensecheck.io/compatibility-matrix).
Matrix warnings are reported as `unknown` by default and as `weak-compatible`
when `weak-compatible: true`.

## Action inputs

| Input             | Default               | Description                                              |
| ----------------- | --------------------- | -------------------------------------------------------- |
| `config`          | `.licenserc.yaml`     | License Eye-compatible YAML configuration path           |
| `token`           | `${{ github.token }}` | Token used for pull-request comments                     |
| `log`             | `info`                | `error`, `warn`, `info`, or `debug`                      |
| `weak-compatible` | `false`               | Enable License Eye weak-compatible compatibility entries |
| `report-all`      | `false`               | Include compatible dependencies in the job summary       |

By default, the job summary and pull-request comment show dependency issues
only. Distribution review warnings and manually approved non-SPDX exceptions
are included in the job summary; they are omitted from the pull-request comment.
The pull-request comment links to the workflow run summary for the full report.
Set `report-all: true` to include every compatible dependency in the job summary.

Compatible reciprocal/copyleft dependencies are also reported by default as
non-blocking **Distribution review** warnings. LGPL, MPL, GPL/AGPL, CAL, and
related reciprocal licenses can require notices, license copies, source
availability, relinking, or other conditions when software is distributed. These
warnings do not fail the action. They appear in the job summary and as GitHub
Actions warning annotations.

The generated `dist/index.js` bundle is committed because JavaScript GitHub
Actions run from the checked-out action repository without installing its Node
dependencies.

## Local usage

From a checkout of this repository:

```sh
corepack enable
yarn install --immutable
yarn run check --config .github/config/.licenserc.yaml --log debug
```

The local command checks dependency licenses and exits non-zero on failures. It
does not create pull-request comments. Network access may be needed for registry
and repository license resolution; configured `dependency.licenses` entries work
offline.

## Checking another repository locally

Run the checker from its own checkout and point `GITHUB_WORKSPACE` at the
repository you want to inspect. Dependency file paths in the configuration are
resolved relative to that target repository.

```sh
TARGET_REPO=/path/to/other-repository
TARGET_CONFIG="$TARGET_REPO/.github/config/.licenserc.yaml"

GITHUB_WORKSPACE="$TARGET_REPO" \
  yarn run check \
  --config "$TARGET_CONFIG" \
  --log info
```

For example:

```sh
GITHUB_WORKSPACE=/Users/ffacca/Code/documentation \
  yarn run check \
  --config /Users/ffacca/Code/documentation/.github/config/.licenserc.yaml \
  --log debug
```

The target repository must already be checked out and contain the dependency
files listed in its configuration. The checker does not install dependencies or
modify the target repository. It exits with code `1` when incompatible or
unresolved licenses are found. Use `--token` when private GitHub repository
metadata must be queried:

```sh
GITHUB_WORKSPACE="$TARGET_REPO" \
  yarn run check \
  --config "$TARGET_CONFIG" \
  --token "$GITHUB_TOKEN"
```

Local runs produce annotations in supported GitHub environments but do not
create pull-request comments.

## Usage examples

The [`examples/README.md`](examples/README.md) describes the example files and
how to copy them into a project. It includes configurations for JavaScript, Go,
Python with Poetry, and fully pinned Python requirements, plus a GitHub Actions
workflow and an optional license-text pattern example.
