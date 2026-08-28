# signalk-cpu-governor

Switches the CPU frequency governor on an SBC (NanoPi, Raspberry Pi, Orange Pi, etc.)
per CPU cluster, driven by rules matched against any SignalK path — battery
voltage/SOC, shore power presence, navigation state, whatever you point it at.

Handles big.LITTLE / heterogeneous boards (e.g. 4x Cortex-A53 + 4x Cortex-A72) by
detecting each distinct CPU core type and letting you assign a different rule set to
each cluster.

## How it works

The plugin config has two sections:

**Rules** — each rule watches a SignalK path and, when its condition matches, names a
governor. A rule is either:
- a **threshold** match: `path` + `comparator` (`<=`, `<`, `>=`, `>`, `==`) + `value`, or
- an **enum** match: `path` + `enumValue` (compared as a string)

**CPU groups** — one entry per CPU cluster detected on the device (e.g. "4x
Cortex-A72 (cores 4-7)"). Each group gets an ordered list of rule names. Every
`pollIntervalSeconds`, rules are evaluated top-to-bottom for that group; the **first
match wins** and its governor is applied. If no rule matches, the group's governor is
left alone (hysteresis — it won't flap).

A governor is applied per cluster (or the whole CPU, if there's only one), not per
individual core — there's no need to micromanage 8-12 cores one at a time, and no need
to know exactly which logical core id belongs to which cluster. Only two things matter:
how many distinct core models the board has, and how many cores of each — both come
straight from `lscpu -J` (util-linux), which already ships (and maintains) its own
vendor/model name tables for every architecture, so this plugin doesn't hand-roll one.
`lscpu -J` reports each distinct CPU model on the board together with its
`Core(s) per socket:` / `Socket(s):` / `Thread(s) per core:`, which multiply out to how
many cores that model has (confirmed against a real 4x Cortex-A53 + 4x Cortex-A72
board). The specific core ids for each model aren't in that output, but don't need to
be looked up separately either: the kernel always enumerates a cluster's cores
contiguously in discovery order, so the Nth model block simply claims the next N ids.

**Requires `lscpu` (part of `util-linux`).** It's present on essentially every
Debian-based SBC image (Raspberry Pi OS, Armbian, DietPi), but not on minimal
containers such as `node:alpine` — install it there with `apk add util-linux`. If
`lscpu` is missing, or its counts don't add up to the board's total CPU count (parse
gone wrong, unexpected format), the plugin logs an error and disables itself rather
than guess at CPU topology.

Check available governors on your board first:

```sh
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
```

### Example

Rules:

| name | path | comparator | value | governor |
|---|---|---|---|---|
| `low-battery` | `electrical.batteries.house.voltage` | `<=` | `12.2` | `powersave` |
| `shore-power` | `electrical.batteries.house.voltage` | `>=` | `12.6` | `performance` |
| `sailing` | `navigation.state` | enum: `sailing` | | `performance` |

Groups:

| group | rule set (priority order) |
|---|---|
| 4x Cortex-A53 (cores 0-3) | `low-battery`, `shore-power` |
| 4x Cortex-A72 (cores 4-7) | `low-battery`, `sailing` |

Here the little cores stay in `powersave` unless the battery is doing well, while the
big cores also spin up for sailing mode regardless of battery state (since `sailing`
is checked after `low-battery` — put it first if it should take priority instead).

## Permissions (the actual gotcha)

Writing `scaling_governor` normally requires root, and SignalK usually doesn't run as
root. Two options — pick one:

### Option A: udev rule (recommended, no sudo needed at runtime)

Make the governor files group-writable and put the SignalK user in that group. Create
`/etc/udev/rules.d/60-cpufreq-governor.rules`:

```
SUBSYSTEM=="cpu" ACTION=="add" RUN+="/bin/chmod -R g+w /sys/devices/system/cpu/cpu%n/cpufreq"
```

That only chmods the parent dir, which won't recurse — simplest reliable version is a
tiny boot script instead of a udev rule:

```sh
# /etc/systemd/system/cpufreq-perms.service
[Unit]
Description=Make cpufreq governor files group-writable
Before=signalk.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'chgrp signalk-cpu /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor && chmod g+w /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor'

[Install]
WantedBy=multi-user.target
```

```sh
sudo groupadd -f signalk-cpu
sudo usermod -aG signalk-cpu <the user signalk runs as>
sudo systemctl enable --now cpufreq-perms.service
```

Reboot (or restart both services) and check `ls -l` on a `scaling_governor` file —
group should have `w`.

### Option B: sudoers (if you'd rather not touch systemd)

```
<signalk-user> ALL=(root) NOPASSWD: /usr/bin/tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

Then swap `fs.writeFileSync` in `index.js` for a `sudo tee` `child_process` call. Not
wired up — Option A is cleaner and keeps the plugin dependency-free.

## Install (MVP / local dev)

```sh
# on the SBC, inside the SignalK data dir
cd ~/.signalk
npm install /path/to/signalk-cpu-governor   # or rsync the folder over first
```

Restart SignalK, then configure the plugin from the admin UI (Server → Plugin Config →
CPU Governor Switcher). The CPU groups section is populated dynamically from the
hardware SignalK is running on, so it'll differ per board. Watch the plugin's status
line there for the applied-governor per group, and `journalctl -u signalk -f` for
permission errors if writes are failing.

## Config reference

| Field | Meaning |
|---|---|
| `pollIntervalSeconds` | how often rules are evaluated (default 30, min 5) |
| `rules[].name` | unique name, referenced from `groups.<id>.ruleSet` |
| `rules[].path` | SignalK path to read |
| `rules[].matchType` | `threshold` (default) or `enum` |
| `rules[].comparator` / `rules[].value` | used when `matchType` is `threshold` |
| `rules[].enumValue` | used when `matchType` is `enum`; compared as a string |
| `rules[].governor` | governor applied when this rule matches |
| `groups.<id>.ruleSet` | ordered array of rule names for that CPU cluster |
