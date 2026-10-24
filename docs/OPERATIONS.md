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

## Firewall and ping

Open **Operations → Firewall** to see a list of servers and their firewall status. Enabled servers are checked in sequence; paused management, missing UFW and failed checks are shown separately from an enabled or disabled firewall. Use **Refresh** to check again, or select a server to manage its UFW firewall. **All servers** returns to the list with refreshed status. The server must already have UFW installed and the management account needs sudo access. Add inbound allow/deny rules for a port using TCP, UDP or both, choosing all IPs or a source IPv4/IPv6 address or CIDR network. Saved rules remain visible and editable while UFW is disabled. Changes to an active firewall apply immediately. Deleting a saved rule removes its IPv4 and IPv6 counterparts; a changed rule list must be refreshed before deletion. Disable retains the saved rules. Changes and failures are recorded in the activity log and share the server operation lock.

Saved rules appear in a table showing their type and destination ports or port ranges. Expand a row to read its original UFW description; unresolved application profiles or service names show **See original rule** instead of an inferred port. **Delete** opens the existing confirmation for that rule. The **Add rule** button is below the input panel, beside **Refresh**.

Enabling requires an explicit saved inbound TCP allow rule matching the management connection. The privileged remote operation checks persisted rules again immediately before invoking `ufw --force enable`; missing, unreadable or unrecognized rules block enabling. The check uses the actual server-side SSH port and source IP (including a jump host's IP), which can differ from the configured destination when forwarding/NAT is involved. It honors source/destination networks, port ranges, IPv4/IPv6 and the order of user rules, including earlier deny/reject rules. UFW application profiles are checked through their expanded numeric rules. Interface-specific or other complex rules that cannot be proven safe block enabling. Add a suitable rule while disabled and refresh before enabling. Custom rules outside UFW's user input chain, external firewalls and later changes made outside Mossentry require separate review.

Open **Ping test** to send four ICMP requests from this computer to the configured server address, independently of SSH. The result includes the system ping output and is bounded by a 12-second deadline. Jump hosts and SSH proxy settings are not used. ICMP failure can indicate filtering and does not establish whether SSH/TCP access works.

See the [Ubuntu UFW guide](https://ubuntu.com/server/docs/how-to/security/firewalls/) for rule behavior and server setup.

## Monitoring

Open a server's **Monitor** button from its Servers card. Collection runs every five seconds while the page is visible and unpaused; overlapping samples are skipped. Charts keep a rolling five-minute window with whole-minute ticks that move left as time advances. Legends contain names; hover tooltips provide readings.

CPU/GPU user filters apply to the retained visible history. GPU utilization/memory modes reuse that history. Unsupported or unreadable metrics remain unavailable rather than becoming zero. NVIDIA GPU readings require `nvidia-smi` and a compatible installed driver.

Disk bars are sorted by physical capacity. Linux sysfs rotational information, with an NVMe fallback, identifies SSD/HDD where possible; software RAID levels are read from the exposed topology. Hardware RAID controllers and virtual machines may hide these details. Measured filesystem usage appears beside its percentage in decimal GB. Unmounted or unreadable usage is unavailable. A filesystem spanning multiple disks is counted once.

## Inventory and storage

Import servers from an SSH config file, preview the resolved hosts, and select which new entries to add. Imported servers start paused and existing names are skipped in the selection. Inventory export has been removed; task-result and credential downloads remain available. Removing a server requires one confirmation and removes its local inventory and account cache while preserving operation history and remote data. See [SSH config import](INSTALL.md#ssh-config-import-and-login-options) for supported login settings.

All application persistence lives in the configured user-data directory, outside the source checkout by default. See [installation](INSTALL.md) for paths and storage overrides.
