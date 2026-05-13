# Docker Engine on WSL — Install & Run Guide

A drop-in prompt/instruction file for installing Docker Engine natively inside a WSL2 Ubuntu distro, and using `docker` / `docker compose` for project workflows. Use this instead of Docker Desktop on Windows when you want a lightweight, daemon-managed, sudo-only setup that doesn't depend on the Windows-side GUI.

---

## When to use this

- You're on WSL2 (Ubuntu) and want Docker without running Docker Desktop on Windows.
- You want `docker` and `docker compose` available from any shell session, autostart via `systemd`, and no Windows-side process to manage.
- Your project ships a `docker-compose.yml` (database, queue, etc.) and you'd rather `docker compose up -d` than juggle native installs of each service.

## Prerequisites

- WSL2 Ubuntu (this guide targets **Ubuntu 24.04 "noble"**; adjust the codename for other releases).
- `systemd` enabled in WSL. Verify with:
  ```bash
  ps -p 1 -o comm=          # should print: systemd
  cat /etc/wsl.conf         # should include [boot] systemd=true
  ```
  If systemd isn't enabled, add this to `/etc/wsl.conf` (then `wsl --shutdown` from Windows PowerShell and reopen):
  ```ini
  [boot]
  systemd=true
  ```

## Install (one-time)

Run inside the WSL distro:

```bash
# 1) Prereqs + Docker's official GPG key + apt source
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Replace "noble" below with your Ubuntu codename if different
# (jammy = 22.04, focal = 20.04). Check with: . /etc/os-release && echo $VERSION_CODENAME
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

# 2) Install Engine + CLI + Compose plugin + Buildx
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3) Start the daemon and enable it at WSL boot
sudo systemctl enable --now docker

# 4) Allow your user to run docker without sudo
sudo usermod -aG docker $USER
newgrp docker     # applies the group to *this* shell immediately
```

## Verify

```bash
docker --version
docker compose version
docker run --rm hello-world
```

If `docker --version` still routes to the Docker Desktop shim (path under `/mnt/c/Program Files/Docker/...`):
```bash
hash -r           # clear shell command cache
which docker      # should now print /usr/bin/docker
```
If the shim still wins on `PATH`, either uninstall Docker Desktop or prepend `/usr/bin` in your shell rc.

## Daily use

```bash
# Daemon status (rarely needed once enabled)
sudo systemctl status docker

# Bring up services defined in a project's docker-compose.yml
docker compose up -d                # all services in the background
docker compose up -d <service>      # just one service (e.g. postgres)
docker compose ps                   # what's running
docker compose logs -f <service>    # tail logs
docker compose down                 # stop + remove containers (keeps volumes)
docker compose down -v              # also drop named volumes (DESTRUCTIVE)

# Ad-hoc containers
docker run --rm -it ubuntu:24.04 bash
docker exec -it <container> bash    # shell into a running container

# Inspect
docker ps                           # running containers
docker ps -a                        # all (including stopped)
docker images                       # local images
docker volume ls                    # named volumes
docker network ls                   # networks

# Cleanup
docker system prune                 # dangling images, stopped containers, unused networks
docker system prune -a --volumes    # nuke everything not in use (DESTRUCTIVE)
```

## Project-specific pattern

For a typical Next.js / Postgres / etc. project where `docker-compose.yml` defines a `postgres` service exposing host port `5433`:

```bash
# From the project root
docker compose up -d postgres

# Verify it's reachable
nc -zv localhost 5433

# Connect interactively (if psql is installed on the host)
PGPASSWORD=<pw> psql -h localhost -p 5433 -U <user> -d <db>

# Or hop into the container
docker compose exec postgres psql -U <user> -d <db>
```

The container persists data in a named volume — `docker compose down` will not wipe it. Only `docker compose down -v` will.

## Common gotchas

- **`docker` command not found after install.** The Docker Desktop shim at `/mnt/c/Program Files/Docker/...` might still be first on `PATH`. Run `hash -r` and check `which docker`. Prepend `/usr/bin` in your shell rc if needed.
- **`permission denied while trying to connect to the Docker daemon socket`.** You're not in the `docker` group yet. Either `newgrp docker` in the current shell, or log out and back into WSL (`wsl --shutdown` from Windows PowerShell, then reopen).
- **`Cannot connect to the Docker daemon`.** The daemon isn't running. `sudo systemctl start docker`. If systemd isn't running in WSL, see Prerequisites.
- **WSL `/mnt/c/...` bind mounts are slow.** For dev workflows, keep the project on the Linux side (`~/projects/...`) rather than `/mnt/c/...`. Compose bind mounts work either way, but Linux-native paths are dramatically faster for filesystem-heavy operations.
- **Files written by the container are root-owned on the host.** Fix with `--user $(id -u):$(id -g)` on `docker run`, or set the `user:` key in `docker-compose.yml`.
- **Port already in use.** Some other process (often a native install) is on the same port. `ss -tlnp | grep :<port>` to find it. Either stop the conflicting process or change the published port in `docker-compose.yml` / your run command.

## Rollback (uninstall)

```bash
sudo systemctl disable --now docker
sudo apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo rm -rf /var/lib/docker /var/lib/containerd
sudo rm /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc
sudo gpasswd -d $USER docker || true
```

---

## Why this over Docker Desktop?

- No Windows-side GUI process to keep running or update.
- Faster startup, lower memory footprint.
- Daemon lifecycle is `systemctl`-managed inside WSL — same UX as a Linux server.
- One less Windows licensing surface to think about for org use.

## Why Docker Desktop instead?

- You want Kubernetes one-click, the Windows-side GUI, Windows containers, or out-of-the-box port forwarding to other distros.
- You need WSL integration shared across multiple distros from a single point of control.
