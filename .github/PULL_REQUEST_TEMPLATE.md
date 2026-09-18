## What changes

<!-- The behaviour that changes, and why it needs to change. -->

## How it was verified

<!-- Commands you ran and their result. CI runs the same ones on Linux and Windows. -->

```
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

## Compatibility

<!-- Configuration keys, command behaviour or session data that consumers must adapt to. Write
"no public behaviour change" if none. -->

## Checklist

- [ ] The change is focused on one problem.
- [ ] Tests cover the new decision logic, or the change has no decision logic.
- [ ] Documentation is updated when configuration, commands or limits changed.
- [ ] No credentials, private paths, session identifiers or real task text are included.
