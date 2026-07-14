# SSH Access Setup

SSH Access lets agents SSH to an allowlisted set of hosts and run allowlisted commands. Authentication is entirely **key-based** - there is no password field anywhere in this module, by design. The Allowed Hosts list below is a permission allowlist (which hosts an agent may target), not a credential store - it never holds a secret.

## Step 1 - Have an SSH key

If you don't already have one:

```
ssh-keygen -t ed25519
```

This creates `~/.ssh/id_ed25519` (private key, stays on your machine) and `~/.ssh/id_ed25519.pub` (public key, safe to copy around).

## Step 2 - Install your key on each host

```
ssh-copy-id user@host
```

This is the **one time** you'll enter that host's password - to install your public key. After this, connecting never needs a password again.

## Step 3 - First manual connect

Connect once by hand:

```
ssh user@host
```

This adds the host's key fingerprint to `~/.ssh/known_hosts`. It's required when the **Require Known Hosts** setting is on (the safe default) - without it, the module refuses to SSH to a host it can't verify.

## Step 4 - Add the host to Allowed Hosts (in this panel)

- **Host** - the `user@host` (or hostname) string, matched byte-for-byte against what the agent invokes.
- **Description** - what the host is for (panel-only note, not enforced).

An empty allowlist refuses all SSH - nothing is reachable until you add at least one host here.

## Step 5 - Set Allowed Command Patterns

A comma-separated list of command prefixes the agent may run on the remote host. The default covers read-only inspection (`ls`, `pwd`, `ps`, `df`, `docker ps`, `tail -n`, and similar). Add anything destructive - `systemctl restart`, `docker run`, `rsync` - explicitly, and only after you've reviewed what it allows.

## Jump/bastion hosts

Put the bastion itself in Allowed Hosts, then reach hosts behind it with `ProxyJump` in `~/.ssh/config`:

```
Host client
  HostName client.internal
  User deploy
  ProxyJump bastion
```

The agent SSHes through the bastion using the same key - no separate credential or config on this panel is needed for the hop.

## About passwords

There is nowhere on this panel to put a password. That's intentional: the module forbids piping credentials into SSH, so it only works with keys. If your key has a passphrase, you unlock it once into `ssh-agent` yourself at the start of a session - the agent never sees or handles the passphrase.

## If you can't install a key on a host

If you don't control the host, or policy forbids adding keys, agent SSH won't fit that host - connect to it manually instead. This module targets hosts where you can set up key-based access yourself: bastions, deploy targets, dev VMs.
