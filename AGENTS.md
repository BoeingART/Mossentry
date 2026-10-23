# Mossentry Agent Collaboration Guide

This file applies to the entire repository. Explicit user instructions take precedence. An `AGENTS.md` in a subdirectory may add rules for that directory.

Mossentry uses Tauri 2, React/Mantine, and Rust, with SQLite storage, SSH, approvals, and operation history. See the [development guide](docs/DEVELOPMENT.md) for development and verification commands, and the [installation guide](docs/INSTALL.md#application-data) for application data isolation.

## Branch Conventions

- Keep `main` as the only long-lived integration branch by default. It must remain buildable, verifiable, and releasable. Integrate changes through task branches and pull requests (PRs).
- Give each independent task one short-lived branch, one dedicated worktree, and one PR. Start a new branch for each new task, even when the same agent handles it; avoid long-lived agent branches that mix unrelated work.
- Use `codex/<type>-<short-english-task-name>` by default. Choose `feat`, `fix`, `hotfix`, `refactor`, `docs`, or `chore` as the type, for example `codex/fix-ssh-timeout`. Follow an explicit branch name requested by the user.
- Do not create or restore long-lived integration branches such as `dev` or `develop` by default. Define an additional workflow only when shared integration testing or multiple maintained versions require it.
- Record releases with version tags. Create a `release/<major>.<minor>.x` maintenance branch only when an older version needs ongoing support.

## Starting a Task

1. Check `git status --short --branch`, `git worktree list`, and applicable repository instructions. Confirm the working directory, branch, and existing changes.
2. For a new task, refresh remote references with `git fetch origin`. Normally start from the latest `origin/main`. When continuing an existing task, reuse its branch and worktree instead of creating another environment.
3. Create a dedicated worktree and task branch for work that changes files. A Codex-managed worktree may initially use detached HEAD, but create a named branch before committing and handing off the work.
4. Define the scope, acceptance criteria, and dependencies. Independent features and fixes can proceed in parallel. If a task depends on shared changes that have not merged, coordinate the merge order or explicitly record the dependency PR and target branch.

If the current directory contains user changes, preserve them and start the new task in a separate worktree. Do not discard, overwrite, or stash user work without authorization just to switch tasks.

## Worktrees and Parallel Work

- Separate chats do not automatically isolate files. Tasks that write in parallel must use different worktrees and branches. By default, each branch has one writing task responsible for it.
- Reuse a worktree that belongs to the current task. While another task is running, do not switch its branch or alter its state through resets, rebases, cleanup, or deletion.
- Worktrees isolate source files but share repository information such as branches and commits. Edit, install dependencies, build, and test within the current task's directory. Do not use another worktree's generated directories.
- Agree on ownership and ordering before changing the same public interface, database migrations, dependency lockfiles, or substantially overlapping files. Separate directories do not prevent merge conflicts or behavioral conflicts.
- Review tasks are read-only by default and provide feedback on a specific PR or commit. The task's writer implements the requested fixes.
- When running the application manually, set a separate `MOSSENTRY_USER_DATA_DIR` for each task. Check that `MOSSENTRY_DATA_DIR`, `MOSSENTRY_DB_PATH`, and legacy `SRVMGR_*` overrides do not point to real user data or another task's data.
- The native development environment currently binds the Vite port, Tauri `devUrl`, CSP, and navigation allowlist to `5173`. Run native development instances one at a time by default; parallel builds and regular tests can run in their own worktrees. Coordinate all related configuration before running multiple application instances simultaneously.

## Developing Features and Fixes Together

- Start new features from `origin/main`. For bugs already present on the mainline, create a separate fix branch from `origin/main` so the fix does not depend on an unfinished feature.
- Fix bugs that exist only in an unmerged feature on that feature branch. Split problems that also affect the mainline into independent fix tasks.
- Prioritize merging validated independent fixes into `main`. Features still in development should then sync with the mainline, resolve conflicts, and repeat the affected checks. Fixes can be released before those features are complete.
- By default, sync by running `git fetch origin` and `git merge origin/main` in your own task worktree. Dependent PRs use their agreed base. Do not rewrite another task's history or a shared branch's history without coordination.
- If a released version needs a patch while `main` already contains features that must not ship in that patch, create a hotfix from the corresponding release tag or maintenance branch. If needed, first create `release/X.Y.x` from that tag and target the hotfix PR at that maintenance branch.
- Also propagate maintenance-branch fixes to `main` through an appropriate merge, cherry-pick, or adapted equivalent fix, and verify each target separately. Do not bring unrelated features from `main` back into an older version.
- Creating release tags and publishing installers belong to explicitly planned release tasks. Ordinary feature or fix PRs must not initiate releases on their own.

## Commits, Verification, and PRs

- Keep changes focused and stage only files that belong to the current task. Use clear verbs and objects in commit messages, optionally with prefixes such as `feat:`, `fix:`, or `docs:`.
- For behavior changes and fixes, run meaningful checks appropriate to the affected scope. Reproduce bugs first where practical and add regression coverage that prevents recurrence. For documentation-only changes, review the content, links, and `git diff --check`; full application tests are unnecessary.
- Use `npm run check` for regular code checks. For Rust changes, also run `npm run check:rust` and `cargo fmt --manifest-path src-tauri/Cargo.toml --check`. Follow the development guide for relevant integration checks when changing SSH, account operations, or packaging.
- Current PR CI is defined in [release.yml](.github/workflows/release.yml) and includes regular tests, Rust checks, and native builds on multiple platforms. Never report checks that were not run, failed, or are still running as passed.
- By default, deliver implementation tasks as committed and pushed task branches with a PR targeting `main`. Use a draft PR when work is incomplete or validation has not passed. Update the original PR when continuing a task. Use the explicitly agreed target for maintenance or dependent PRs. Respect a user request to keep work local.
- PR descriptions must explain the problem, final behavior, key implementation tradeoffs, verification results, and remaining limitations. Link related issues or dependency PRs. A reviewer should be able to understand the change without reading the chat.
- If network access, permissions, or the environment prevent delivery, preserve the branch and files and report completed work and remaining steps accurately. Do not describe a local commit as pushed or a PR as created when it is not.

## Review and Merge

- The user or designated integration owner merges PRs. An agent may merge only when the task explicitly authorizes it. Ordinary implementation tasks do not push directly to `main`.
- Address review feedback and complete the task's acceptance checks and the repository's required CI checks before merging. Tasks may be developed in parallel, but merges happen in sequence.
- After an earlier PR merges, subsequent PRs must sync with the latest target branch and recheck conflicts and affected behavior. The absence of textual conflicts does not replace behavioral verification.
- For dependent PRs, review the remaining diff after the prerequisite PR merges, then retarget the follow-up PR to `main` to avoid duplicate integration or missing changes.

## Completion and Cleanup

- Before cleaning up a task branch, confirm that its changes are in the target branch, its PR is merged, and there are no uncommitted changes or tasks still using it.
- Check `git worktree list` before deleting a local branch. For a regular merge, verify ancestry with `git merge-base --is-ancestor <task-branch> <target-branch>`. Prefer `git branch -d`; do not force-delete to bypass unmerged-branch protection.
- Squash and rebase merges change commit relationships. An ancestry check alone cannot establish that such work is unmerged and does not justify force-deleting the branch. Verify the PR and final diff; if safe deletion is still uncertain, keep the branch and explain why.
- Deleting local branches and deleting remote branches are separate actions. Delete remote branches only when remote cleanup is explicitly in scope. Preserve the mainline, actively maintained release branches, and other people's active branches.
- Before cleaning up a worktree, confirm that required changes are committed and either integrated or reliably backed up. Archive Codex-managed worktrees through the application's archive operation. Remove manually created worktrees with `git worktree remove`; do not directly delete their directories or force cleanup.
- The final handoff should describe changes, verification results, the branch, and PR links, and accurately identify unmerged work, checks still running, or retained worktrees.
