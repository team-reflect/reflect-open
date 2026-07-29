# iOS Context List Cycle Status

## Current Status

- [x] Read Reflect `AGENTS.md`.
- [x] Confirmed Reflect branch/worktree.
- [x] Confirmed Meowdown branch/worktree and package scripts.
- [x] Traced Reflect iOS formatting toolbar UI and command bridge.
- [x] Traced Meowdown list command surface and existing task cycle pattern.
- [x] Created implementation plan before code edits.
- [x] Implement Meowdown `cyclePlainList` command and tests.
- [x] Run Meowdown focused tests and required checks.
- [x] Open Meowdown PR if required: prosekit/meowdown#396.
- [x] Wire Reflect toolbar bridge to upstream command.
- [x] Run Reflect focused tests and required checks.
- [x] Attempt/document iOS QA.
- [ ] Commit, push, and open ready Reflect PR.

## Working Notes

- Meowdown currently has `cycleCheckableList` for the task icon and `toggleList` for direct list toggles. It does not expose the exact three-state plain-list cycle required by the iOS toolbar.
- Reflect's iOS bullet-list button currently calls `editor.commands.toggleList({ kind: 'bullet' })`, which cannot produce the requested bullet-to-ordered next state.
- Reflect is pinned to the Meowdown PR snapshot for commit `df741bb` so the branch is portable while the upstream PR is pending.
- iOS simulator QA is blocked on this host: `xcrun simctl list devices available` fails with `xcrun: error: unable to find utility "simctl", not a developer tool or in PATH`.
