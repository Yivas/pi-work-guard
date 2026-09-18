# pi-work-guard

A Pi extension that keeps the agent's task list honest during long sessions.

Long sessions drift. The list of tasks stops matching the work: updates become rare, compaction
erases the habit, and a turn can end with an item still marked in progress and nothing said about
it. This extension watches the session and acts on the two moments that matter.

[![CI](https://github.com/Yivas/pi-work-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Yivas/pi-work-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What it does

While a task list has open items, the extension:

- keeps a short reminder in the system prompt, so the working rule stays visible even in a very long
  conversation that never compacts;
- injects a note when the list has not been touched for a number of agent steps, naming the open
  items;
- re-injects the open items right after compaction, when the habit is measurably lost;
- tells a new session what the previous session left unfinished, as information only;
- when the agent goes idle with an item still `in_progress`, asks for an explicit decision — keep
  working, close it with evidence, or declare a handoff — instead of letting the turn end quietly.

The extension never blocks a tool and never edits your task list. It can only remind, and the
decision stays with the agent and with you.

## Status

Version 0.1.0. The extension is new and its behaviour may change between releases; see
[CHANGELOG.md](CHANGELOG.md).

Requires Pi 0.84.3 or newer. It has no runtime dependencies and no network access.

## Install

```bash
pi install git:github.com/Yivas/pi-work-guard
```

From a local checkout:

```bash
pi install /path/to/pi-work-guard
```

Reload Pi or run `/reload` so the extension is picked up.

## Use

The extension works on its own. Its only user-facing command reports and changes its state:

```text
/work-guard            show status
/work-guard on         enable it
/work-guard off        disable it
/work-guard reset      clear the reminder counters for the current list
```

## Configuration

Settings live in `work-guard.json` inside the Pi agent directory (`~/.pi/agent/work-guard.json`).
The file is optional; these are the defaults:

```json
{
  "enabled": true,
  "staleSteps": 12,
  "maxForcedTurns": 3,
  "noticeOnSessionStart": true,
  "systemPromptNotice": true
}
```

| Key                    | Meaning                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `enabled`              | Turns the extension off completely when `false`.                                            |
| `staleSteps`           | Agent steps without touching the list before a reminder is injected.                        |
| `maxForcedTurns`       | Consecutive requests for a decision before the extension goes quiet until the list changes. |
| `noticeOnSessionStart` | Report unfinished work inherited from the previous session of the same directory.           |
| `systemPromptNotice`   | Keep the working rule and the open items in the system prompt.                              |

`/work-guard on` and `/work-guard off` write this file. Edit it directly for the other keys.

## How it decides

The extension recomputes everything from the session itself. It has no counters to fall out of sync:

- the task list comes from the last `todo` tool result in the current branch, so branching and
  reloading are handled for free;
- steps are counted from that result to the end of the branch;
- when a Pi goal is active, the extension stays out of the way: the goal already continues the work,
  so no turn is forced and only reminders remain.

Two task-list shapes are recognised: `{ tasks: [...] }` and `{ todos: [...] }`. A different tool
name or shape means the extension stays silent rather than guessing.

## Security and privacy

- No network access, no telemetry, no analytics.
- The only file it writes is its own configuration under the agent directory.
- To report inherited work, it reads the newest previous session file of the same working directory
  and extracts just the last task list; message text is never read into memory or displayed.
- It runs with your permissions inside Pi. It never blocks a tool call, so a misconfigured threshold
  cannot stop your work.

## Limits

- It reports what the list says. It cannot tell whether a task is genuinely finished, so it asks for
  evidence instead of claiming it.
- Reminders compete for your attention; `maxForcedTurns` and `/work-guard off` exist for that reason.
- A forced turn only happens in an interactive session. In print and JSON modes the extension only
  adds reminders.
- It watches a tool named `todo`. An agent that tracks work anywhere else gets no help from it.

## Support and contributing

Bug reports and feature requests go to [Issues](https://github.com/Yivas/pi-work-guard/issues).
Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities through
the channel in [SECURITY.md](SECURITY.md), not in a public issue.

## License

MIT. See [LICENSE](LICENSE).

This project is not affiliated with or endorsed by the Pi project or its maintainers.
