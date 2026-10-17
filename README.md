# License Checker GitHub Action

A GitHub Action for checking dependency license compatibility in JavaScript,
Python, and Go projects.

It uses License Eye-style YAML config and SPDX license expressions. This because
we started from that tool, and keeping the same config file avoid us to rework
all our repos.

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

The default config path is `.licenserc.yaml`. Example:

```yaml
header:
  # Used for dependency checks when project-license is `header`.
  license:
    spdx-id: Apache-2.0

dependency:
  files:
    - go.mod
  # Compare dependencies against a proprietary product outcome instead of
  # the project's SPDX license in header. Defaults to header.
  project-license: proprietary
  # Choose the product intent explicitly when the project is proprietary.
  # The distribution model is an action input; it defaults to public-saas.
  # Optional; includes JS/Python dev dependencies and Go test imports.
  # include-dev-dependencies: true
  go:
    # Defaults to ["./..."]. Set to the package patterns CI builds.
    packages:
      - ./cmd
  licenses:
    - name: github.com/zaphiro-technologies/roger
      license: Apache-2.0
    - name: acme-package
      match: 'Copyright \(c\) Acme.*All rights reserved'
      license: LicenseRef-Acme-Proprietary
  # Source-scoped regex rules for license metadata.
  license-rules:
    - source: python-classifier
      match: "Acme Public License"
      license: LicenseRef-Acme
    - source: license-text
      match: "Your custom license fingerprint"
      license: LicenseRef-Custom-License
  exceptions:
    - name: gsap
      version: "3.15.0"
      url: https://gsap.com/community/standard-license/
      reason: Approved by legal for use outside prohibited GSAP uses.
```

The supported dependency inputs are:

- JavaScript: `package.json` with `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, or `pnpm-lock.yaml`
- Go: `go.mod`, resolved from package imports with `go list -deps -json`
- Python: `poetry.lock`, `Pipfile.lock`, or an exhaustive, fully pinned
  `requirements.txt`; `pyproject.toml` is supported with an adjacent
  `poetry.lock`

Examples are in [`examples/`](examples/).

## Configuration reference

| Setting                               | Purpose                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `header.license.spdx-id`              | Project SPDX license used when `dependency.project-license` is `header`.                                                                                                                                           |
| `dependency.project-license`          | `header` (default) compares SPDX license expressions. `proprietary` checks whether each dependency fits a proprietary product under the selected distribution model.                                                |
| `dependency.files`                    | Manifests and lockfiles to scan. Versions must be exact; Python requirements must pin and list every dependency. Unresolved inputs fail the check.                                                                  |
| `dependency.include-dev-dependencies` | Defaults to `false`. Includes JS `devDependencies`, Python non-main groups and Pipfile `develop`, and Go tests.                                                                                                     |
| `dependency.go.packages`              | Go build targets; defaults to `./...`.                                                                                                                                                                              |
| `dependency.licenses`                 | License override by package name or glob and optional version. `match` adds a regex over declared license metadata or downloaded LICENSE text. Unconditional entries take precedence.                               |
| `dependency.license-rules`            | Ordered, case-insensitive regexes scoped by `source`: `license-text` or `python-classifier`. Custom rules run before built-in mappings in [`config/default-license-rules.yaml`](config/default-license-rules.yaml). |
| `dependency.exceptions`               | Manual non-SPDX approval. Requires exact package name/version, terms `url`, and review `reason`; reported as `approved-exception`.                                                                                  |
| `dependency.excludes`                 | Skip package names or globs, optionally limited to comma-separated exact versions.                                                                                                                                  |
| `dependency.require_fsf_free`         | Fail dependencies not recognized as FSF-free.                                                                                                                                                                       |
| `dependency.require_osi_approved`     | Fail dependencies not recognized as OSI-approved.                                                                                                                                                                   |
| SPDX expressions                      | `AND`, `OR`, and `WITH` are supported in license values.                                                                                                                                                            |

Review license text before assigning a license with `match`; a copyright notice
alone does not establish license terms.

### Compatibility reference

Compatibility models follow [licensecompat](https://licensecompat.com/compatibility/).
The action's rules are in [`config/license-compatibility.yaml`](config/license-compatibility.yaml).
With `project-license: proprietary`, the selected model decides whether a known
dependency is compatible with keeping the product proprietary, needs manual
review, or is incompatible. Commercial use is generally permitted by open
source licenses; this setting is about the obligations that may prevent a
closed-source product. It does not claim that the dependency itself is
non-commercial. The proprietary outcomes are conservative category-level
policies in this repository, not a copy of licensecompat's complete pair
dataset.

| `distribution` model | Use case |
| -------------------- | -------- |
| `internal-use` | Used only inside the organization; not distributed to users. |
| `public-saas` | Public hosted service; the default. |
| `proprietary-binary` | Closed-source software delivered as a binary. |
| `static-linking` | Product statically links the dependency. |
| `dynamic-linking` | Product dynamically links the dependency. |
| `open-source-redistribution` | Product and dependencies are redistributed as open source. |

The selected model is a `distribution` action input; it defaults to
`public-saas`. Pair checks against `header.license.spdx-id` are independent of
the distribution model. Use `project-license: header` for
`open-source-redistribution`; proprietary target checks cannot determine the
license of a new open-source combined work. For
`project-license: proprietary`, the YAML policy uses broad license families
and may request manual review. Unlisted licenses and CC-BY-3.0/4.0 remain
unresolved for manual review. Outcomes requiring review fail until covered by
a manual exception in `dependency.exceptions`.
Set the model under the action's `with:` section, for example
`distribution: proprietary-binary`.
Licensecompat provides general guidance, not legal advice. FSF-free and
OSI-approved identifiers are exact snapshots from the SPDX
[License List v3.29.0](https://github.com/spdx/license-list-data/blob/main/json/licenses.json).
Conditional or review outcomes include a link to the
[licensecompat checker](https://licensecompat.com/).

## Comparison with alternatives

We tested different tools. Some are surely more complete, and that was one of
the problems: they do much more than just checking license compatibility. Other
have a weak support for the ecosystem we care about, so in the end, rather than
applying different tools to different ecosystem, we came up with our own tool.

| Tool                                                                            | Strength                                                                                   | Trade-off                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| This action                                                                     | Exact-version license checks for JavaScript, Python, and Go. Unresolved dependencies fail. | Focused ecosystem and policy coverage.                                                               |
| [GitHub Dependency Review](https://github.com/actions/dependency-review-action) | Native PR review of dependency changes with an SPDX allowlist.                             | Uses GitHub's dependency graph; private repositories may require Code Security or Advanced Security. |
| [ORT](https://github.com/oss-review-toolkit/ort-ci-github-action)               | License and security policy evaluation, reports, and SBOMs.                                | Broader setup and configuration.                                                                     |
| [FOSSA](https://github.com/fossas/fossa-action)                                 | Hosted compliance with policy review and attribution reports.                              | Requires a FOSSA account and API key.                                                                |

## Action inputs

| Input             | Default                  | Description                                                                               |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `config`          | `.licenserc.yaml`        | License Eye-compatible YAML configuration path                                            |
| `token`           | `${{ github.token }}`    | Token used for pull-request comments                                                      |
| `log`             | `info`                   | `error`, `warn`, `info`, or `debug`                                                       |
| `weak-compatible` | `false`                  | Accept matrix review pairings when comparing SPDX project and dependency licenses         |
| `distribution`    | `public-saas`            | `internal-use`, `public-saas`, `proprietary-binary`, `static-linking`, `dynamic-linking`, or `open-source-redistribution` |
| `report-all`      | `false`                  | Include compatible dependencies in the job summary                                        |

The summary shows the full report. PR comments show dependency issues and link
to the summary; distribution warnings and approved exceptions appear only in the
summary. `report-all: true` includes compatible dependencies in the summary.
Reciprocal licenses such as LGPL, MPL, GPL/AGPL, and CAL produce distribution
review warnings. Outcomes requiring review fail until covered by a manual
exception in `dependency.exceptions`.

## Local usage

From a checkout of this repository:

```sh
corepack enable
yarn install --immutable
yarn run check --config .github/config/.licenserc.yaml --log debug
```

The local command checks dependency licenses and exits non-zero on failures.
Network access may be needed for registry and repository license resolution;
configured `dependency.licenses` entries work offline.

Third-party component attributions are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Checking another repository locally

Set `GITHUB_WORKSPACE` to the target checkout. Config paths are relative to it.

```sh
TARGET_REPO=/path/to/other-repository
TARGET_CONFIG="$TARGET_REPO/.github/config/.licenserc.yaml"

GITHUB_WORKSPACE="$TARGET_REPO" \
  yarn run check \
  --config "$TARGET_CONFIG" \
  --log info
```

Use `--token` when the checker needs to read private GitHub repository metadata:

```sh
GITHUB_WORKSPACE="$TARGET_REPO" \
  yarn run check \
  --config "$TARGET_CONFIG" \
  --token "$GITHUB_TOKEN"
```

## Usage examples

See [`examples/README.md`](examples/README.md) for the example configs and
workflow.

For contributor workflows, see the [development guide](DEVELOPMENT.md).
