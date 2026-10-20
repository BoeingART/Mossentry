# dev-forward: small-server operations

## Scope and design

The Operations page runs operator-supplied, multiline Linux commands using the
existing native SSH or Ansible transport. Both transports send the same Python
probe. Targets require Linux, Python 3 and Bash. No remote agent is installed;
Ansible may create its usual temporary module files. Existing SSH host-key
verification and the saved sudo configuration remain in use.

The previous inspection/service/log presets are no longer offered in the form.
Their historical results remain readable and exportable; legacy API operations
remain supported for compatibility.

## Inventory

Use **Servers → Edit server** to set a group and notes. Search includes both.
**Export inventory** contains connection references (including local key paths)
and annotations, never key contents, sudo passwords, sessions or account data.
It is an inventory transfer, not a full application backup.

**Import inventory** accepts version 1 JSON, up to 500 entries. Preview validates
all entries and lists name conflicts before applying. Import is atomic, creates
only new names and starts every imported server paused. It never overwrites an
existing server. Check private-key paths and configure credentials on the new
machine before enabling imported hosts. The interface accepts files up to 2 MB.

Existing databases gain `group_name` and `notes` columns without replacing
inventory, credentials or user history.

## Operations

Choose enabled hosts individually or use **Select all servers** beside the
selector. All enabled hosts are selected; there is no silent truncation to the
former 50-host limit. Paused hosts cannot be targeted. Enter Bash commands, choose
whether to use sudo, and set a per-host timeout from 10 to 3,600 seconds (default
300). Commands are non-interactive: use appropriate options such as `apt install
-y`, and use the sudo checkbox for the saved privilege configuration.

**Dry run** connects to every selected host and feeds the script to
`bash --noprofile --norc -n` through a private pipe. It runs as the SSH account without sudo, even
when sudo is selected for later execution. The checker uses a clean environment
without `BASH_ENV`, `ENV`, exported shell functions or inherited shell options.
The entered commands, substitutions and redirections are not executed. Syntax
errors and diagnostics are saved per host. This is a shell grammar check, not a
simulation of application behavior: `apt update xxx` can pass shell syntax while
still having invalid apt arguments. Missing commands, permissions and outcomes
are not verified. See the [Bash manual](https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html).

Static rules warn about deletion, permissions/ownership, elevated privileges,
packages, services/processes, shutdown, storage, networking, file writes and
dynamic/downloaded scripts. These rules are conservative and incomplete; warnings
are advisory and do not constitute a security sandbox. The execution review shows
the exact command and hosts, and requires acknowledgement when warnings exist.

Execution requires a successful saved Dry run for the identical command, host
set, sudo selection, timeout and target connection settings. The API independently
checks this condition and the risk acknowledgement; changing the form invalidates
the UI check. Execution also rechecks syntax on the target before starting the
script. Bash runs without startup files, with standard system executable paths,
and with its usual exit semantics. Script input is passed on a separate descriptor
while command stdin is `/dev/null`, so a program cannot consume later script lines
as interactive responses. To stop on earlier failures or detect failed
pipeline stages, include the appropriate Bash options in the script.

Each task processes hosts sequentially and continues after a host fails.
Configuration changes, account execution and maintenance tasks share the existing
operation lock. Live resource charts remain independent. Each host records stdout,
stderr, exit code and timeout state. Each output stream is capped at 256 KiB and
truncation is displayed. Nonzero exits and timeouts fail that host while preserving
captured output. The command process group is killed on timeout; detached processes
or changes already made may remain. SSH/Ansible has an additional 30-second budget
for syntax checking and transport overhead.

Commands and output are kept in the owner-only local SQLite database. Do not put
passwords or secrets in the command text. History supports pagination, JSON export
and deletion; deleting a task retains its audit events. Deletion is logical, not
secure erasure of SQLite pages or backups. Command text and output are excluded
from audit events. Historic inspection/service/log records retain their original
result format.

Closing the page does not stop a job. Closing the app can interrupt it; unfinished
jobs become **Interrupted** at the next startup and are never automatically
retried. A failure or lost connection may occur after changes took effect. Check
the actual server state before retrying.

## Implementation and verification

- `backend/app/operations_probe.py`: Bash checks, bounded command execution, risk rules and legacy probes; stdlib only.
- `backend/ansible/operations.yml`: Ansible execution and private local results.
- `backend/app/operations_service.py`: durable background execution and recovery.
- `frontend/src/Operations.tsx`: command form, Dry run, risk review, results and history; English and Simplified Chinese.
- `frontend/src/InventoryTransfer.tsx`: import preview and export.
- `backend/tests/test_operations.py`: validation, authentication/CSRF, import
  conflicts, credential exclusion, non-executing syntax checks, malformed scripts,
  risk rules, check invalidation, output bounds, timeout cleanup, partial failures,
  operation locking, recovery and both transports.
- `scripts/test-remote-linux.py`: disposable CI container smoke checks, including
  read-only inspection and optional capability detection without new packages.

Run `npm run check` for the complete suite. Automated tests use isolated local
fixtures; they never manage the configured real servers. The Linux container
smoke check requires a running Docker daemon and is run by the existing release
workflow. Real SSH/Ansible command execution should be verified against a disposable Linux
host before production use.

System command semantics follow the upstream [systemctl documentation](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
and [journalctl documentation](https://www.freedesktop.org/software/systemd/man/255/journalctl.html).
