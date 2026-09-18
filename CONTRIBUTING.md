# Contributing

Thanks for taking the time to look at this project. This document describes what is accepted and how
to send it.

## What is accepted

- Bug reports through [Issues](https://github.com/Yivas/pi-work-guard/issues), using the bug report
  form.
- Feature proposals through Issues, using the feature request form. Discuss the shape of a change
  before writing it.
- Pull requests for bug fixes, tests and documentation. For anything larger, open an issue first so
  we do not spend your time on a change that will not be merged.
- Security reports through the channel described in [SECURITY.md](SECURITY.md). Do not open a public
  issue for a vulnerability.

## Before you start

- Node.js 22 or newer is required.
- Run `npm install` once.
- Run `npm test` to confirm the suite passes on your machine before changing anything.

## Checks your change must pass

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs the same commands on Linux and Windows, with Node.js 22. A pull request that does not pass
them locally will not pass review either.

## What a pull request should contain

- A summary of the behaviour that changes and why.
- The checks you ran and their result.
- Tests for new decision logic. The module `src/guard.ts` is pure on purpose: keep it that way so it
  stays testable without a Pi session.
- Documentation updates when configuration, commands or limits change.

Keep changes focused. A pull request that mixes a fix with an unrelated refactor is harder to review
and slower to merge.

## Privacy in reports

Remove credentials, personal paths, session identifiers, real task subjects and any private project
data from issues, pull requests and logs. Invented examples are preferred.

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
