# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and version numbers follow the convention
described in the project documentation.

## Unreleased

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
