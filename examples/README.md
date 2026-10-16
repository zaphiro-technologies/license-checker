# Usage examples

Copy the files you need into your repository and set the action's `config` input
to the copied config. Dependency paths are relative to the repository root.

| Example                                                                | Use it for                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| [`javascript/`](javascript/)                                           | npm lockfile and config                               |
| [`go/`](go/)                                                           | Go module and package targets                         |
| [`python-poetry/`](python-poetry/)                                     | Poetry lockfile and config                            |
| [`python-requirements/`](python-requirements/)                         | Fully pinned requirements                             |
| [`match-pattern/.licenserc.yaml`](match-pattern/.licenserc.yaml)       | Matching a package's declared license or LICENSE text |
| [`github-actions/license-check.yml`](github-actions/license-check.yml) | PR and push workflow                                  |

Use the filenames shown, or update `dependency.files`. Keep JavaScript lockfiles
beside `package.json`; run `poetry lock` after Poetry dependency changes. The Go
runner needs Go installed. Go scans `./...` by default; set `dependency.go.packages`
to your build targets. `dependency.include-dev-dependencies: true` includes JS
and Python dev dependencies and Go test imports for those same targets.
`go.sum` does not replace `go.mod`.

The requirements example is complete only for its sample. List and pin every
direct and transitive package in a real requirements file. Replace the pattern
example's placeholder package and expression with a reviewed rule. The workflow
example expects `.licenserc.yaml` at the repository root; adjust its config path
and action version as needed.
