# Dependency maintenance

- Frequently review and proactively update maintained packages and all runtime,
  development, build, test, and tooling dependencies. Routine in-scope updates are
  authorized; do not wait for breakage. Prioritize Pi, reviewing the latest stable
  official release and the intended `fitchmultz/pi` revision separately.
- Read the relevant release, changelog, migration, and security notes across the
  upgrade range. Check actual supported APIs and behavior, not version numbers
  alone. Preserve support floors, standalone installation, and optional-integration
  boundaries. Use npm, Node 24, and compatible dependency cohorts; update committed
  lockfiles together with their manifests when present.
- Adopt beneficial current APIs, conventions, patterns, and functionality rather
  than extending deprecated or outdated approaches. Align callers, documentation,
  fixtures, and generated resources through the canonical
  `scripts/sync-pstack.mjs` generator; preserve the recorded upstream provenance.
- Carry updates through the existing project gates, including
  `npm run check:compat`, applicable exact-host native checks, and required review
  and CI. Report exact versions/revisions, results, skips, and limits honestly.
  Never relax checkers, safety requirements, or support floors to pass an update.
- Roll out through the existing approval, release, and installation gates with a
  recoverable prior version and rollback plan. Honor explicit holds. This standing
  maintenance authorization does not itself authorize publication, active-runtime
  installation/restarts, private-data disclosure, or global model/auth changes.
