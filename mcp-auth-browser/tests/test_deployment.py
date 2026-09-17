import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / 'devops' / 'configure-auth-browser.py'
spec = importlib.util.spec_from_file_location('browser_deployment', path)
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTests(unittest.TestCase):
    def test_update_preserves_other_settings_and_is_idempotent(self):
        current = {'Version': {'Index': 7}, 'Spec': {
            'Labels': {'com.docker.stack.namespace': 'qa-pulsarteam'},
            'TaskTemplate': {'ContainerSpec': {
                'Image': 'registry/mcp-auth-browser:1', 'ReadOnly': True,
                'CapabilityDrop': ['ALL'], 'Secrets': [{'SecretID': 'test'}],
                'Mounts': [{'Type': 'tmpfs', 'Target': '/tmp'}],
            }}
        }}
        original = copy.deepcopy(current['Spec']['TaskTemplate']['ContainerSpec'])
        updates = []

        def request(method, path, data=None):
            self.assertTrue(path.startswith('/services/qa-pulsarteam_mcp-auth-browser'))
            if method == 'POST':
                self.assertIn('registryAuthFrom=spec', path)
                updates.append(data)
                current['Spec'] = copy.deepcopy(data)
                return {}
            return copy.deepcopy(current)

        with patch.object(deployment, 'request', request):
            deployment.configure('qa-pulsarteam')
            deployment.configure('qa-pulsarteam')
        self.assertEqual(len(updates), 1)
        container = current['Spec']['TaskTemplate']['ContainerSpec']
        privileges = container.pop('Privileges')
        self.assertTrue(privileges['NoNewPrivileges'])
        self.assertEqual(privileges['Seccomp']['Mode'], 'custom')
        self.assertEqual(container, original)

    def test_rejects_wrong_stack_before_mutation(self):
        with patch.object(deployment, 'request', return_value={
            'Spec': {'Labels': {'com.docker.stack.namespace': 'another-stack'}}
        }) as request:
            with self.assertRaises(ValueError):
                deployment.configure('qa-pulsarteam')
            self.assertEqual(request.call_count, 1)
        with self.assertRaises(ValueError):
            deployment.configure('../other')
