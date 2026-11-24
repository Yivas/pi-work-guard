# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version numbers follow the convention
described in the project documentation.

## Unreleased

### Added

- `rpiv-todo`'s `rpiv-todo-state` entries are read as list updates, in the current branch and in the
  previous session file, so a call routed through another tool is not missed.
- A configuration file that exists but cannot be read now produces one warning instead of failing
  silently.

### Changed

- A forced turn now needs at least three agent steps since the last list update, so an agent that
  updates the list at the end of its turn is not sent back to work immediately.
- Goal detection reads the payload `pi-goal` writes, `{ goal: { status } | null }`, and treats an
  unrecognised payload as active rather than queueing a second continuation.
- The previous session is chosen through Pi's own session directory and the newest other file, and
  the inherited-work notice is only sent on startup or a new session.
- The previous session file is read with a cap per file and per line.

### Fixed

- Reading a session file that exceeds the byte cap no longer returns an older task list; the file
  yields no notice.
- An aborted run no longer asks for a decision: `agent_settled.aborted` and a last assistant message
  with `stopReason: "aborted"` both suppress the forced turn.
- A `todo` result that carries `details.error` is no longer treated as a list update, so a failed
  call does not reset the step count.
- A read-only `todo` call (`list` or `get`) is no longer treated as a list update either, so asking
  for the list does not reset the step count or suppress a reminder and a forced turn.
- CI checked files out with CRLF endings on Windows, where `format:check` failed; `.gitattributes`
  now pins LF.

## 0.1.0

### Added

- Stale-list reminders: a note is injected when the task list has not been touched for a configurable
  number of agent steps.
- Post-compaction reminder with the open items.
- Session-start notice describing work inherited from the previous session of the same directory.
- Forced turn when the agent goes idle with an item still in progress, capped and suppressed while a
  Pi goal is active.
- System prompt reminder while the list has open items.
- `/work-guard` command to show status and to turn the extension on, off or reset.
- Configuration file `work-guard.json` with defensive parsing of invalid values.
