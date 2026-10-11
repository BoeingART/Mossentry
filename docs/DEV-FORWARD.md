# dev-forward: small-server operations

## Scope and design

The existing application covers inventory, account approvals and live resource
monitoring. This iteration completes five missing day-to-day workflows:

| Gap | Implemented workflow |
| --- | --- |
| Hosts lack operational context and portable inventory | Groups, notes, search/filter, JSON export, import preview and atomic creation |
| Live charts do not give a durable health report | On-demand multi-host OS, load, memory, filesystem and inode inspection with threshold alerts |
| Existing services cannot be managed | Service list with search, start/stop/restart and enable/disable at boot |
| Troubleshooting requires another SSH session | Bounded journal queries by unit, age and severity, search within returned messages |
| Multi-host maintenance has no durable per-host result | Background tasks, per-host status, partial failures, restart recovery, history pagination, JSON export and deletion |

No dependencies were added. Both existing native SSH and Ansible transports run
the same fixed Python operation implementation. Remote hosts retain the existing
Linux, SSH and Python 3 prerequisites. Read-only inspection and service listing
need no sudo. Service changes use the saved sudo configuration. Journal queries
use the SSH account's existing visibility unless the operator selects sudo.
Existing SSH host-key verification stays enabled.

There are no agent, exporter, message broker, database server, scheduled remote
job or monitoring daemon installations. `systemctl` and `journalctl` are optional
capabilities of the remote OS: missing tools are reported as unavailable. Neither
transport installs them. Python code runs in memory; subprocess output is drained into bounded
in-memory buffers. Ansible may create its usual
short-lived remote module files.

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

Choose up to 50 enabled hosts explicitly or select a group. Each task runs hosts
sequentially, records each outcome and continues after an individual host fails.
Configuration changes, account execution and other maintenance tasks share the
existing operation lock. Live resource charts remain independent.

**Health inspection** reports OS/kernel/architecture, logical CPUs, uptime,
1/5/15-minute load, memory/swap use, local filesystem space and inode use, and
failed systemd services when available. Warnings trigger at 90% memory, disk or
inode use, five-minute load above logical CPU count, or a failed service. These
are fixed on-demand thresholds, not continuous monitoring or notifications.
Unsupported data is shown as unavailable. Network filesystems and non-data
pseudo-filesystems are excluded; bind mounts are deduplicated by device.

**Services** includes loaded and installed inactive units (up to 2,000), with
runtime state and boot policy. Actions require an exact `.service` name and a
confirmation showing selected hosts. `enable`/`disable` affect boot policy only;
they do not include `--now`. Unit files are not edited or installed. SSH, common
network, firewall and core system services are protected. The remote probe also
checks canonical names/aliases and `RefuseManualStart`/`RefuseManualStop` before
mutating. This is a guardrail, not a complete analysis of unit dependencies;
application services can still affect workloads or dependent units.

**Logs** queries the existing journal for 1 minute–7 days, with 1–1,000 entries
and severity filtering. Empty service means all accessible units. Read-only
users may see a partial journal; the UI reports that scope and any journal
warnings. Captured stdout is capped at 2 MiB, individual displayed messages at
8,192 characters. Results are plain text, never HTML or executable commands.

Tasks keep per-host results in the owner-only local SQLite database. Export
results before deleting a task when needed; deletion removes saved results but
retains audit events. This is logical deletion, not secure erasure of SQLite
pages or external backups. Journal results may contain operational secrets, so
only export to intended recipients. No log content is copied to audit events.

Closing a page does not stop a task. Closing the app can interrupt it. On next
startup, unfinished tasks become **Interrupted**, never automatically retried.
A lost connection or timeout can occur after a remote change took effect;
inspect the actual service state before manually rerunning a failed mutation.
Task history is paginated at 25 rows. Each remote host has a 100-second transport
budget, with shorter command deadlines.

## Implementation and verification

- `backend/app/operations_probe.py`: fixed remote operations, stdlib only.
- `backend/ansible/operations.yml`: Ansible execution and private local results.
- `backend/app/operations_service.py`: durable background execution and recovery.
- `frontend/src/Operations.tsx`: batch form, review, inspection/service/log results
  and history; English and Simplified Chinese.
- `frontend/src/InventoryTransfer.tsx`: import preview and export.
- `backend/tests/test_operations.py`: validation, authentication/CSRF, import
  conflicts, credential exclusion, command injection rejection, protected aliases,
  thresholds, partial failures, operation locking, recovery and both transports.
- `scripts/test-remote-linux.py`: disposable CI container smoke checks, including
  read-only inspection and optional capability detection without new packages.

Run `npm run check` for the complete suite. Automated tests use isolated local
fixtures; they never manage the configured real servers. The Linux container
smoke check requires a running Docker daemon and is run by the existing release
workflow. Service mutations still need end-to-end verification against a
purpose-built systemd test host before a production rollout.

System command semantics follow the upstream [systemctl documentation](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
and [journalctl documentation](https://www.freedesktop.org/software/systemd/man/255/journalctl.html).
