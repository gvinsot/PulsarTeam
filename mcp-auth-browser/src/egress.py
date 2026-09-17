"""HTTPS CONNECT proxy: resolve once, validate every answer, connect to that IP.

Chromium uses this loopback proxy for ALL network requests (including redirects
and subresources). No private destinations, plain HTTP, or arbitrary TCP ports.
Never log URLs, proxy bytes, or browser authentication material.
"""
import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit


def https_origin(value: str) -> str:
    u = urlsplit(value)
    if (u.scheme != "https" or not u.hostname or u.username or u.password
            or u.port not in (None, 443) or "\\" in value):
        raise ValueError("Only HTTPS URLs on port 443 without credentials are allowed")
    host = u.hostname.encode("idna").decode("ascii").lower()
    if ":" in host:
        host = f"[{host}]"
    return f"https://{host}"


def public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value)
    if isinstance(ip, ipaddress.IPv6Address):
        # Reject transition mechanisms as well as mapped private addresses.
        if ip.ipv4_mapped:
            return public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour or ip.teredo or ip in ipaddress.ip_network("64:ff9b::/96"):
            return False
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


async def public_addresses(host: str):
    records = await asyncio.get_running_loop().getaddrinfo(
        host, 443, type=socket.SOCK_STREAM)
    if not records or any(not public_ip(r[4][0]) for r in records):
        raise ValueError("Private or special network destination blocked")
    return records


class PublicProxy:
    def __init__(self):
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0, limit=16384)
        return f"http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        remote = None
        pipes = []
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
            method, authority, version = header.split(b"\r\n", 1)[0].decode("ascii").split()
            if method != "CONNECT" or version not in ("HTTP/1.0", "HTTP/1.1"):
                raise ValueError("HTTPS only")
            target = urlsplit("https://" + authority)
            https_origin("https://" + authority)
            if target.path or target.query or target.fragment or target.port != 443:
                raise ValueError("Invalid proxy destination")
            records = await asyncio.wait_for(public_addresses(target.hostname), 10)
            # Pass a literal IP, never the hostname: prevents DNS rebinding.
            family, _, _, _, address = records[0]
            upstream, remote = await asyncio.wait_for(
                asyncio.open_connection(address[0], 443, family=family), 15)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()

            async def pipe(src, dst):
                while data := await asyncio.wait_for(src.read(65536), 120):
                    dst.write(data)
                    await dst.drain()

            pipes = [asyncio.create_task(pipe(reader, remote)),
                     asyncio.create_task(pipe(upstream, writer))]
            await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
        except (Exception, asyncio.CancelledError):
            pass
        finally:
            for p in pipes:
                p.cancel()
            await asyncio.gather(*pipes, return_exceptions=True)
            if remote:
                remote.close()
            writer.close()
            self.tasks.discard(task)
