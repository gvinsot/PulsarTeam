"""Unit tests for io_limiter (stdlib unittest; run: python -m unittest -v)."""
import tempfile
import unittest
from pathlib import Path

import io_limiter as m


class ParseRateTest(unittest.TestCase):
    def test_units(self):
        self.assertEqual(m.parse_rate('25M'), 25 * 1024 * 1024)
        self.assertEqual(m.parse_rate('25MiB'), 25 * 1024 * 1024)
        self.assertEqual(m.parse_rate('25m/s'), 25 * 1024 * 1024)
        self.assertEqual(m.parse_rate('512k'), 512 * 1024)
        self.assertEqual(m.parse_rate('1G'), 1024 ** 3)
        self.assertEqual(m.parse_rate('26214400'), 26214400)

    def test_unlimited(self):
        for v in ('', '0', 'max', 'none', 'off'):
            self.assertEqual(m.parse_rate(v), 0)

    def test_invalid(self):
        with self.assertRaises(ValueError):
            m.parse_rate('fast')


class FakeHostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_block_devices_skips_virtual(self):
        sys_block = self.root / 'block'
        for name, dev in (('sda', '8:0'), ('nvme0n1', '259:0'), ('loop0', '7:0'), ('zram0', '252:0')):
            (sys_block / name).mkdir(parents=True)
            (sys_block / name / 'dev').write_text(dev + '\n')
        self.assertEqual(m.block_devices(sys_block), ['259:0', '8:0'])

    def test_v2_systemd_scope_and_delegation(self):
        cid = 'a' * 64
        (self.root / 'cgroup.controllers').write_text('cpu io memory pids\n')
        (self.root / 'cgroup.subtree_control').write_text('cpu io memory pids\n')
        slice_ = self.root / 'system.slice'
        scope = slice_ / f'docker-{cid}.scope'
        scope.mkdir(parents=True)
        (slice_ / 'cgroup.subtree_control').write_text('cpu memory pids\n')
        # Regular files don't model the kernel's per-line semantics; emulate
        # io.max appearing once the controller is delegated.
        orig = m._ensure_io_delegated

        def delegated(cg, root):
            orig(cg, root)
            (cg / 'io.max').write_text('')
        m._ensure_io_delegated = delegated
        try:
            self.assertTrue(m.reconcile_container(cid, '25M', ['8:0'], self.root))
        finally:
            m._ensure_io_delegated = orig
        self.assertEqual((slice_ / 'cgroup.subtree_control').read_text(), '+io')
        self.assertEqual((scope / 'io.max').read_text(), '8:0 wbps=26214400')

    def test_v2_idempotent(self):
        cid = 'b' * 64
        (self.root / 'cgroup.controllers').write_text('io\n')
        scope = self.root / 'docker' / cid
        scope.mkdir(parents=True)
        (scope / 'io.max').write_text('8:0 rbps=max wbps=26214400 riops=max wiops=max\n')
        self.assertFalse(m.reconcile_container(cid, '25M', ['8:0'], self.root))

    def test_v1_blkio(self):
        cid = 'c' * 64
        scope = self.root / 'blkio' / 'docker' / cid
        scope.mkdir(parents=True)
        (scope / 'blkio.throttle.write_bps_device').write_text('')
        self.assertTrue(m.reconcile_container(cid, '25M', ['8:0'], self.root))
        self.assertEqual((scope / 'blkio.throttle.write_bps_device').read_text(), '8:0 26214400')

    def test_nested_cgroup_parent_found_by_walk(self):
        cid = 'd' * 64
        (self.root / 'cgroup.controllers').write_text('io\n')
        scope = self.root / 'custom.slice' / 'sub.slice' / f'docker-{cid}.scope'
        scope.mkdir(parents=True)
        self.assertEqual(m.find_container_cgroup(cid, self.root), scope)

    def test_missing_cgroup(self):
        (self.root / 'cgroup.controllers').write_text('io\n')
        with self.assertRaises(RuntimeError):
            m.reconcile_container('e' * 64, '25M', ['8:0'], self.root)


if __name__ == '__main__':
    unittest.main()
