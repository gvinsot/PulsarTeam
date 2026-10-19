#!/usr/bin/env python3
"""Per-container disk write throttling for Docker Swarm services.

Swarm services have no blkio settings: `docker stack deploy` silently drops
`blkio_config`, and `docker update` can only change the blkio *weight*, not a
bps ceiling. A CLI runner doing `npm install`, `cargo build` or an unbounded
`dd` can therefore saturate the node's disk and starve every other service on
it (Postgres, the API, the other runners).

This daemon runs once per node (global service). Every INTERVAL seconds it
lists the local containers carrying the label

    io.pulsarteam.io-limit.write-bps=<rate>     e.g. 25M (= 25 MiB/s)

and writes the matching kernel throttle straight into the container's cgroup:

  * cgroup v2: `io.max` -> "MAJ:MIN wbps=N" (covers buffered writeback too)
  * cgroup v1: `blkio.throttle.write_bps_device` -> "MAJ:MIN N"
    (v1 only throttles direct I/O — writeback is not attributed to the cgroup)

The limit is applied to every physical block device of the node (loop, ram,
zram, optical... are skipped), so it holds whichever disk backs the overlay or
the named volumes. Reconciliation is idempotent and periodic, so it survives
container restarts, new tasks and systemd re-realising the slice.

Only the Python standard library is used. Never logs container env or specs.
"""
from __future__ import annotations

import http.client
import json
import logging
import os
import re
import socket
import sys
import time
from pathlib import Path
from urllib.parse import quote

LABEL = 'io.pulsarteam.io-limit.write-bps'

DOCKER_SOCK = os.environ.get('DOCKER_SOCK', '/var/run/docker.sock')
CGROUP_ROOT = Path(os.environ.get('CGROUP_ROOT', '/host/cgroup'))
SYS_BLOCK = Path(os.environ.get('SYS_BLOCK', '/sys/block'))
INTERVAL = float(os.environ.get('IO_LIMITER_INTERVAL', '15'))
# Optional explicit device list ("8:0,259:0"); default: auto-detect.
DEVICES_OVERRIDE = os.environ.get('IO_LIMITER_DEVICES', '').strip()

# Virtual / non-disk block devices that never back container storage.
SKIP_DEVICE_PREFIXES = ('loop', 'ram', 'zram', 'sr', 'fd', 'nbd')

log = logging.getLogger('io-limiter')

_RATE_RE = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b?)?\s*(?:/s)?\s*$', re.IGNORECASE)
_UNITS = {'': 1, 'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3, 't': 1024 ** 4}


def parse_rate(value: str) -> int:
    """Parse '25M', '25MiB', '25m/s', '26214400' into bytes/s (binary units).

    Returns 0 for "no limit" ('0', 'max', 'none', 'off', '').
    """
    v = (value or '').strip().lower()
    if v in ('', '0', 'max', 'none', 'off'):
        return 0
    m = _RATE_RE.match(v)
    if not m:
        raise ValueError(f'invalid rate {value!r}')
    return int(float(m.group(1)) * _UNITS[m.group(2).lower()])


# --- Docker API ----------------------------------------------------------------

class _DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(DOCKER_SOCK)


def docker_get(path: str):
    conn = _DockerHTTP('localhost')
    try:
        conn.request('GET', path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status >= 300:
            raise RuntimeError(f'Docker API returned HTTP {resp.status} for GET {path.split("?")[0]}')
        return json.loads(body) if body else None
    finally:
        conn.close()


def labelled_containers() -> list[tuple[str, str]]:
    """Return [(container_id, rate_label_value)] for running labelled containers."""
    filters = quote(json.dumps({'label': [LABEL], 'status': ['running']}))
    out = []
    for c in docker_get(f'/containers/json?filters={filters}') or []:
        out.append((c['Id'], (c.get('Labels') or {}).get(LABEL, '')))
    return out


# --- Block devices -------------------------------------------------------------

def block_devices(sys_block: Path = SYS_BLOCK) -> list[str]:
    """MAJ:MIN of every whole-disk block device worth throttling."""
    if DEVICES_OVERRIDE:
        return [d.strip() for d in DEVICES_OVERRIDE.split(',') if d.strip()]
    devs = []
    try:
        entries = sorted(sys_block.iterdir())
    except OSError:
        return devs
    for entry in entries:
        if entry.name.startswith(SKIP_DEVICE_PREFIXES):
            continue
        try:
            devs.append((entry / 'dev').read_text().strip())
        except OSError:
            continue
    return devs


# --- cgroup handling -----------------------------------------------------------

def is_cgroup_v2(root: Path = CGROUP_ROOT) -> bool:
    return (root / 'cgroup.controllers').exists()


def find_container_cgroup(container_id: str, base: Path) -> Path | None:
    """Locate the cgroup directory of a container under `base`.

    Fast path for the systemd and cgroupfs drivers, then a bounded walk
    (nested slices, custom cgroup parents).
    """
    for candidate in (
        base / 'system.slice' / f'docker-{container_id}.scope',
        base / 'docker' / container_id,
    ):
        if candidate.is_dir():
            return candidate
    base_depth = len(base.parts)
    for dirpath, dirnames, _ in os.walk(base):
        if len(Path(dirpath).parts) - base_depth >= 5:
            dirnames[:] = []
            continue
        for d in dirnames:
            if container_id in d:
                return Path(dirpath) / d
    return None


def _ensure_io_delegated(cgroup: Path, root: Path) -> None:
    """cgroup v2: enable the io controller on every ancestor of `cgroup`.

    Without it the container scope has no io.max file. Docker only enables it
    when a blkio option is set at create time, which Swarm never does.
    """
    rel = cgroup.relative_to(root)
    ancestors = [root] + [root.joinpath(*rel.parts[:i]) for i in range(1, len(rel.parts))]
    for anc in ancestors:
        ctl = anc / 'cgroup.subtree_control'
        try:
            if 'io' in ctl.read_text().split():
                continue
            ctl.write_text('+io')
            log.info('enabled io controller on %s', '/' + str(anc.relative_to(root)) if anc != root else '/')
        except OSError as exc:
            log.warning('cannot enable io controller on %s: %s', anc, exc)


def _parse_io_max(text: str) -> dict[str, int]:
    """'8:0 rbps=max wbps=26214400 riops=max wiops=max' -> {'8:0': 26214400}."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        for kv in parts[1:]:
            k, _, v = kv.partition('=')
            if k == 'wbps':
                out[parts[0]] = 0 if v == 'max' else int(v)
    return out


def apply_v2(cgroup: Path, root: Path, devices: list[str], bps: int) -> bool:
    """Returns True if something was changed."""
    io_max = cgroup / 'io.max'
    if not io_max.exists():
        _ensure_io_delegated(cgroup, root)
        if not io_max.exists():
            raise RuntimeError(f'{io_max} missing (io controller not available)')
    current = _parse_io_max(io_max.read_text())
    changed = False
    for dev in devices:
        if current.get(dev, 0) == bps:
            continue
        try:
            # One device per write: the kernel parses a single line per write().
            io_max.write_text(f'{dev} wbps={bps or "max"}')
            changed = True
        except OSError as exc:
            # Partitions / devices without a request queue are rejected; skip.
            log.debug('io.max rejected %s on %s: %s', dev, cgroup.name, exc)
    return changed


def apply_v1(cgroup: Path, devices: list[str], bps: int) -> bool:
    f = cgroup / 'blkio.throttle.write_bps_device'
    current = {}
    for line in f.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2:
            current[parts[0]] = int(parts[1])
    changed = False
    for dev in devices:
        if current.get(dev, 0) == bps:
            continue
        try:
            f.write_text(f'{dev} {bps}')
            changed = True
        except OSError as exc:
            log.debug('blkio throttle rejected %s on %s: %s', dev, cgroup.name, exc)
    return changed


def reconcile_container(container_id: str, rate: str, devices: list[str],
                        root: Path = CGROUP_ROOT) -> bool:
    bps = parse_rate(rate)
    v2 = is_cgroup_v2(root)
    base = root if v2 else root / 'blkio'
    cgroup = find_container_cgroup(container_id, base)
    if cgroup is None:
        raise RuntimeError('cgroup not found')
    return apply_v2(cgroup, root, devices, bps) if v2 else apply_v1(cgroup, devices, bps)


def reconcile_once() -> None:
    devices = block_devices()
    if not devices:
        log.warning('no block device detected; nothing to throttle')
        return
    for cid, rate in labelled_containers():
        short = cid[:12]
        try:
            if reconcile_container(cid, rate, devices):
                log.info('%s: write limit %s applied on %s', short, rate, ','.join(devices))
        except Exception as exc:  # one bad container must not stop the others
            log.warning('%s: cannot apply write limit %r: %s', short, rate, exc)


def main() -> int:
    logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    if not CGROUP_ROOT.is_dir():
        log.error('%s is not mounted; bind-mount the host /sys/fs/cgroup there', CGROUP_ROOT)
        return 1
    log.info('starting (cgroup %s, interval %ss, label %s)',
             'v2' if is_cgroup_v2() else 'v1', INTERVAL, LABEL)
    while True:
        try:
            reconcile_once()
        except Exception as exc:
            log.warning('reconcile failed: %s', exc)
        time.sleep(INTERVAL)


if __name__ == '__main__':
    sys.exit(main())
