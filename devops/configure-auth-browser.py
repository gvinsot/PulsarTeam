#!/usr/bin/env python3
"""Apply per-service Chromium seccomp options omitted by `docker stack deploy`.

The Docker CLI has no service --security-opt switch. Engine's ServiceSpec
supports Privileges.Seccomp and NoNewPrivileges; use the local manager socket.
Never print the ServiceSpec, environment, or secrets. Idempotent.
"""
import base64
import http.client
import json
import re
import socket
import sys
from pathlib import Path
from urllib.parse import quote


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect('/var/run/docker.sock')


def request(method, path, data=None):
    conn = DockerHTTP('localhost')
    try:
        conn.request(method, path, body=json.dumps(data) if data is not None else None,
                     headers={'Content-Type': 'application/json'})
        response = conn.getresponse()
        body = response.read()
        if response.status >= 300:
            raise RuntimeError(f'Docker API returned HTTP {response.status} for {method} {path}')
        return json.loads(body) if body else {}
    finally:
        conn.close()


def configure(stack):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', stack):
        raise ValueError('Invalid stack name')
    name = stack + '_mcp-auth-browser'
    path = '/services/' + quote(name, safe='')
    service = request('GET', path)
    spec = service['Spec']
    if spec.get('Labels', {}).get('com.docker.stack.namespace') != stack:
        raise ValueError('Service does not belong to the expected stack')
    profile = json.loads(Path(__file__).with_name('auth-browser-seccomp.json').read_text())
    if profile.get('defaultAction') != 'SCMP_ACT_ERRNO':
        raise ValueError('Expected an allowlist seccomp profile')
    seccomp = {'Mode': 'custom', 'Profile': base64.b64encode(json.dumps(profile).encode()).decode()}
    container = spec['TaskTemplate']['ContainerSpec']
    privileges = container.setdefault('Privileges', {})
    if privileges.get('Seccomp') == seccomp and privileges.get('NoNewPrivileges') is True:
        print(name + ': sandbox profile already configured')
        return
    privileges['Seccomp'] = seccomp
    privileges['NoNewPrivileges'] = True
    # Keep the image, mounts, placement, dropped capabilities and secrets intact.
    request('POST', path + f"/update?version={service['Version']['Index']}&registryAuthFrom=spec", spec)
    actual = request('GET', path)['Spec']['TaskTemplate']['ContainerSpec'].get('Privileges', {})
    if actual.get('Seccomp') != seccomp or actual.get('NoNewPrivileges') is not True:
        raise RuntimeError('Docker did not retain the sandbox security options')
    print(name + ': Chromium sandbox profile and no-new-privileges applied')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: configure-auth-browser.py STACK_NAME')
    configure(sys.argv[1])
