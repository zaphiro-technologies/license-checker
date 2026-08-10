# License Checker GitHub Action

License Checker is a cross-platform Node 20 GitHub Action that checks source-file headers and dependency license compatibility. It accepts the main License Eye configuration shape and normalizes license metadata to SPDX identifiers and expressions.

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

The action is check-only. It does not modify files. It writes a job summary and workflow annotations. When a pull request fails and a token is available, it creates or updates one managed pull-request comment.

## Configuration

The default configuration file is `.licenserc.yaml`. The following License Eye-style configuration is supported:

```yaml
header:
  license:
    spdx-id: Apache-2.0
    copyright-year: 2024
    copyright-owner: Zaphiro Technologies
  paths-ignore:
    - .github
    - .docker
    - '**/*.{md,MD}'
    - go.mod
    - go.sum
  comment: on-failure

dependency:
  files:
    - go.mod
  licenses:
    - name: github.com/zaphiro-technologies/roger
      license: Apache-2.0
```

Supported dependency inputs are:

- JavaScript: `package.json`, npm lockfiles, `yarn.lock`, and `pnpm-lock.yaml`
- Go: `go.mod` and `go.sum`
- Python: `requirements.txt`, `pyproject.toml`, `poetry.lock`, and `Pipfile.lock`

License resolution uses configured overrides first, then manifest or lockfile metadata, installed npm metadata, public package registries, and repository license files. Unresolved licenses remain `Unknown` and fail compatibility checks until an override is supplied.

The `dependency.require_fsf_free`, `dependency.require_osi_approved`, `dependency.excludes`, and module-specific `header` entries are accepted. SPDX `AND`, `OR`, and `WITH` expressions are supported.

## Action inputs

| Input | Default | Description |
|---|---|---|
| `config` | `.licenserc.yaml` | License Eye-compatible YAML configuration path |
| `token` | `${{ github.token }}` | Token used for pull-request comments |
| `log` | `info` | `error`, `warn`, `info`, or `debug` |
| `weak-compatible` | `false` | Enable License Eye weak-compatible compatibility entries |

The generated `dist/index.js` bundle is committed because JavaScript GitHub Actions run from the checked-out action repository without installing its npm dependencies.
