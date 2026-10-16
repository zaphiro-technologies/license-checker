# Usage examples

These examples include configurations and small dependency input samples. The
checker reads dependency files from the target repository root, so copy the
selected example files there (or update the paths and pass the config location
with the action's `config` input).

| Example                                                                | Use it when                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`javascript/`](javascript/)                                           | `package.json`, `package-lock.json`, and a config with an exact-version override.                         |
| [`go/`](go/)                                                           | `go.mod` and a config; the checker reads the selected module graph with `go list -mod=readonly -m all`.   |
| [`python-poetry/`](python-poetry/)                                     | `pyproject.toml` and a config; generate the adjacent lockfile with `poetry lock`.                         |
| [`python-requirements/`](python-requirements/)                         | An exhaustive `requirements.txt` with every dependency pinned using `==` or `===`.                        |
| [`match-pattern/.licenserc.yaml`](match-pattern/.licenserc.yaml)       | A reviewed package-specific rule needs to recognize declared license metadata or downloaded LICENSE text. |
| [`github-actions/license-check.yml`](github-actions/license-check.yml) | A starter workflow for running the action on pull requests and pushes.                                    |

The ecosystem configurations refer to conventional filenames. If a project
stores them elsewhere, change `dependency.files` to the correct repository-
relative path. For JavaScript, keep the lockfile in the same directory as
`package.json`; regenerate it with the package manager after changing
dependencies. For Poetry, run `poetry lock` to create and update `poetry.lock`.
For Go, the runner must have Go installed. A `go.sum` file may remain in the
project, but it is not a substitute for `go.mod`.

The requirements example uses `idna`, which has no transitive dependencies.
For a real project, include every direct and transitive dependency in the
requirements file and pin each one.

The pattern example uses a placeholder package name and notice. Replace both
with a real dependency and a reviewed match expression before using the rule.

The workflow example expects `.licenserc.yaml` at the repository root. Copy it
to `.github/workflows/license-check.yml` and adjust the action version and
configuration path to match the project.
