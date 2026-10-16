# Development guide

This guide describes the main extension points in the checker. For end-user
configuration and local invocation, see the [README](README.md).

## Add a license classification

License identifiers affect several separate behaviors. Update only the
classifications that have evidence for the license; an entry in one list does
not automatically establish the other classifications.

1. **Normalize names when needed.** Add non-SPDX spellings to `aliases` in
   [`config/license-compatibility.yaml`](config/license-compatibility.yaml),
   mapping each spelling to the canonical SPDX identifier. Canonical SPDX IDs
   are handled by `spdx-correct`; aliases are for names it cannot normalize.
2. **Set compatibility behavior.** Add the license to the appropriate
   `license-families` list for fallback behavior, or add a `matrix.groups` entry
   when it needs explicit compatibility behavior. For an explicit group, add one
   value to every row in `matrix.values` and add a row with one value per group,
   in the order of `matrix.groups`. Use `compatible`, `warning`, or
   `incompatible`. The YAML loader checks row lengths and allowed values.
3. **Set review and distribution behavior if applicable.** Add licenses that
   require manual review to `review-required.licenses`. Add distribution warning
   rules to `distribution-warnings` when redistribution has a specific
   consideration. Do not put a license in a fallback family if it should stay
   unknown pending review.
4. **Update factual classifications.** Add the canonical ID to `fsf-free` and/or
   `osi-approved` only when the corresponding organization classifies it that
   way. These lists are maintained as snapshots of the SPDX License List; retain
   the source and version when refreshing them.
5. **Add tests.** In [`tests/spdx.test.ts`](tests/spdx.test.ts), cover alias
   normalization if added, the license's fallback or matrix behavior, and any
   review-required or distribution warning behavior. For a new matrix group,
   update the test's representative IDs and expected matrix so every new row and
   column is exercised.
6. **Review documentation.** If the user-facing compatibility table or its cited
   policy sources are affected, update the matching section in
   [`README.md`](README.md).

The checked-in compatibility YAML is the policy source of truth. The matrix is
directional: rows are project licenses and columns are dependency licenses.
Treat compatibility results as policy behavior, not as a legal conclusion.

### Add a license-text fingerprint

If the checker encounters a license text or Python classifier it cannot map,
first verify the complete license terms and identify the canonical SPDX ID. Then
add an ordered rule to `license-text` or `python-classifier` in
[`config/default-license-rules.yaml`](config/default-license-rules.yaml). Rules
use regular expressions and the first matching built-in rule wins. Add a focused
regression case in
[`tests/license-text-rules.test.ts`](tests/license-text-rules.test.ts) or
[`tests/dependencies.test.ts`](tests/dependencies.test.ts), following the
existing fixture style. Users can also supply ordered, source-scoped
`dependency.license-rules` in their config; that does not require changing the
built-in rules.

## Support a new dependency ecosystem

An ecosystem implementation collects exact-version dependencies from configured
manifest or lock files, then resolves license evidence for each dependency. Keep
collection, license resolution, and policy evaluation separate: the shared audit
service in
[`src/dependencies/audit-service.ts`](src/dependencies/audit-service.ts) handles
license overrides, exceptions, SPDX normalization, compatibility, and report
generation.

1. **Define the supported inputs and version guarantees.** Decide which manifest
   and lock files provide a complete dependency list and exact resolved
   versions. Unpinned or unresolved dependencies must be represented as
   unresolved so the shared audit service reports them as unknown.
2. **Add the ecosystem type.** Extend `Ecosystem` in
   [`src/types.ts`](src/types.ts). Use a stable ecosystem key for all
   dependencies from this implementation.
3. **Implement parsers and collection.** Add a directory under
   `src/dependencies/<ecosystem>/parsers/` and a collector that returns the
   shared `Dependency` shape, including name, exact version, ecosystem, and
   source manifest. Respect `includeDevDependencies` where the ecosystem has
   development or test dependencies.
4. **Implement license resolution.** Add a resolver that returns
   `LicenseEvidence` through the `DependencyChecker` contract in
   [`src/dependencies/checker.ts`](src/dependencies/checker.ts). Use the
   existing metadata, registry, and repository helpers where their data fits;
   preserve the evidence source and return `unknown` when the license cannot be
   established. Pass through configured custom license rules where the source
   supports them.
5. **Add and register a checker.** Implement a `DependencyChecker` subclass with
   its supported filenames, collection, and resolver. Register it in the
   `checkers` list in
   [`src/dependencies/registry.ts`](src/dependencies/registry.ts). The audit
   service discovers input formats through this registry.
6. **Add focused coverage.** Add parser tests for dependency names, versions,
   duplicates, optional/dev dependencies, and malformed or incomplete inputs.
   Add resolver tests for metadata, license text, unknown results, and custom
   rules as applicable. Add integration cases in
   [`tests/dependencies.test.ts`](tests/dependencies.test.ts) to verify the
   manifest is collected and reaches the shared policy checks.
7. **Update user documentation.** Document supported manifest and lock files,
   exact-version requirements, and development dependency behavior in the
   README's supported inputs and configuration sections.

Existing implementations to use as references:

- JavaScript: `src/dependencies/javascript/`
- Python: `src/dependencies/python/`
- Go: `src/dependencies/go/`

## Build and validation commands

Run these from the repository root after implementation changes:

```sh
yarn typecheck
yarn test:unit
yarn lint
yarn build
```

The action executes the checked-in `dist/index.js`; include build output and any
emitted runtime data files required by the change. `yarn build` refreshes the
distribution bundle. Review `git status` and the final diff to confirm the
bundle and any data assets are included when needed.
