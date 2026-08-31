# simqa — Linux install

One-shot installer for putting **SimQA** on a fresh Ubuntu/Debian or RHEL/CentOS host with a systemd service + the GitHub-based self-update plumbing.

The Update pill in the sidebar topbar runs `sudo -n /usr/local/sbin/simqa-update`, which downloads the latest `main.tar.gz` from `github.com/nikhilsimnovus/simqa` and re-runs this same `install.sh` from the new tree. Mirrors the OneClick (perf-qa) update pattern.

## Quick start

```bash
# On the target host (must be root):
tar xzf simqa-deploy-<ts>.tar.gz   # or `git clone https://github.com/nikhilsimnovus/simqa`
cd simqa
sudo bash scripts/install.sh
```

The installer:

1. Detects `apt` / `dnf` / `yum` and installs prereqs (`curl`, `tar`, `python3`, `build-essential`, plus Node.js 20.x via NodeSource if the host doesn't already have Node ≥ 18.18).
2. Creates a service user `simqa` with home `/opt/simqa`.
3. Rsyncs the source tree to `/opt/simqa/` (preserves `inventory.yaml` on re-runs).
4. Runs `npm ci` + `npm run build` as the service user.
5. Writes `/etc/systemd/system/simqa.service`, enables + restarts it.
6. **Plants the self-update wrapper** at `/usr/local/sbin/simqa-update` + a `/etc/sudoers.d/simqa` entry granting the `simqa` user passwordless sudo for **only that script**.
7. Waits up to 60 s for simqa to answer on `:${SIMQA_PORT}` and prints the URL.

Re-running `install.sh` is safe — idempotent, preserves the local `inventory.yaml`.

## Tunables

All optional; set as env vars before running:

| Var | Default | Notes |
|---|---|---|
| `SIMQA_PORT` | `4100` | Listen port. `4100` avoids the OneClick service on `4000`; switch to `4000` if you've shut OneClick down. |
| `SIMQA_USER` | `simqa` | Service user (gets created if absent). |
| `SIMQA_HOME` | `/opt/simqa` | Install root. |
| `SIMQA_UPDATE_TARBALL` | `https://github.com/nikhilsimnovus/simqa/archive/refs/heads/main.tar.gz` | Override the update source — point at a fork or a release branch if needed. |

## How the Update pill works

```
Sidebar topbar (Update) ── POST /api/update ──> Next.js route
                                                       │
                                                       ▼
                                     sudo -n /usr/local/sbin/simqa-update
                                                       │
                                                       ▼
                                     1. curl tarball from GitHub
                                     2. tar xzf → /tmp/simqa-update-…
                                     3. exec bash scripts/install.sh
                                                       │
                                                       ▼
                                     install.sh: rsync source, npm ci,
                                     npm run build, systemctl restart simqa
```

When `systemctl restart simqa` fires, the running Node process is killed mid-response. The Sidebar client treats `fetch failed` as expected success and reloads the page after 4 seconds — the new build is already up by then.

### When the pill is hidden

`/api/update` returns `{available: false}` if `/usr/local/sbin/simqa-update` doesn't exist (i.e. the host wasn't installed via this script — usually a local dev workstation). The pill stays hidden in that case so dev environments don't accidentally try to self-update.

## Verifying

```bash
# Service running?
systemctl status simqa --no-pager

# Reachable on the network?
curl http://<host>:4100/api/bulk-tests/status

# Pill should appear in the sidebar at http://<host>:4100/
```

## Uninstall

```bash
sudo systemctl disable --now simqa.service
sudo rm -f /etc/systemd/system/simqa.service /usr/local/sbin/simqa-update /etc/sudoers.d/simqa
sudo rm -rf /opt/simqa
sudo userdel -r simqa 2>/dev/null
```

Or just stop the service and delete `/opt/simqa` if you want to keep the user + sudoers entry around for a future install.
