# Operation workflows

## Account approvals

User access buttons immediately add an operation to the current pending approval list. Multiple users, hosts and permission changes can share one list. Repeated identical items are deduplicated. New-user forms collect the username, target hosts and desired sudo access before adding the item.

The Approvals page displays all list items. Remove an item before approval, or approve/reject the entire list. All usernames, protected accounts, enabled servers and remote preconditions are checked before the first mutation. Individual results remain visible if a later operation fails; remote mutations cannot be rolled back automatically. New-user credential archives are exported once per creation operation.

System and management accounts are protected locally and remotely. The existing `srvmgr` and `sync` exceptions remain supported. Deleting an account retains its home and files and does not terminate active sessions. Pending lists survive restart; interrupted approved work is marked failed and is not resumed automatically.

## Commands

Choose one or more enabled servers, enter multiline Bash commands, and optionally select sudo and a timeout from 10 to 3600 seconds per server. Commands execute non-interactively.

**Check syntax and risks** uses `bash -n` on each target without executing the entered commands. This optional check validates shell grammar, not command options, installed software or successful outcomes.

**Run command** opens a local risk review. The confirmation shows the selected hosts and execution identity, with operation categories highlighted. **Confirm and run** acknowledges the displayed risks and submits the task directly. Risk detection uses static rules and cannot identify every dangerous command.

Tasks persist their per-host results, exit codes, stdout, stderr and detected diagnostics. The output limit is 256 KiB per stream. A nonempty stderr stream alone does not indicate failure. Successful exit codes with explicit warning/error diagnostics produce a completion-with-warnings status. Saved history can be viewed, exported as JSON or removed locally.

Configuration changes, account management and command jobs share a local operation lock. Monitoring uses separate bounded requests. Failed or interrupted commands are not automatically retried.

## Monitoring

Open a server's **Monitor** button from its Servers card. Collection runs every five seconds while the page is visible and unpaused; overlapping samples are skipped. Charts keep a rolling five-minute window with whole-minute ticks that move left as time advances. Legends contain names; hover tooltips provide readings.

CPU/GPU user filters apply to the retained visible history. GPU utilization/memory modes reuse that history. Unsupported or unreadable metrics remain unavailable rather than becoming zero. NVIDIA GPU readings require `nvidia-smi` and a compatible installed driver.

Disk bars are sorted by physical capacity. Linux sysfs rotational information, with an NVMe fallback, identifies SSD/HDD where possible; software RAID levels are read from the exposed topology. Hardware RAID controllers and virtual machines may hide these details. Measured filesystem usage appears beside its percentage in decimal GB. Unmounted or unreadable usage is unavailable. A filesystem spanning multiple disks is counted once.

## Inventory and storage

Inventory JSON exports include connection settings, groups and notes, excluding saved sudo passwords. Imports validate atomically and start imported servers paused. Removing a server removes its local inventory and account cache while preserving operation history and remote data.

All application persistence lives in the configured user-data directory, outside the source checkout by default. See [installation](INSTALL.md) for paths and storage overrides.
