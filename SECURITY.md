# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Scope

pi-work-guard runs inside Pi with the permissions of the user running Pi. It reads session files
from the Pi agent directory and writes its own configuration there. There is no network access, no
subprocess execution and no telemetry.

The extension does not decide whether work is complete and does not modify your task list, files or
repository. It cannot stop a tool call, by design.

## What to include in a report

- Version of pi-work-guard and version of Pi.
- Operating system and Node.js version.
- The smallest configuration and session state that triggers the problem, with any personal paths
  and task subjects replaced by invented ones.
- What you expected and what happened instead.

Remove credentials, personal directory names, task text, session identifiers and anything else you do
not want in a public thread before sending.

## Reporting

Use GitHub's private vulnerability reporting on this repository when it is available. If it is not,
open a minimal issue asking for a private contact channel and leave the details out until one exists.

There is no bug bounty, no guaranteed response time and no commitment to issue a CVE. Reports are
read as time allows, and fixes are published as ordinary releases.
