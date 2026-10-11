"""Exercise remote protection assertions without changing real accounts."""
import re
import unittest
from pathlib import Path

import yaml
from jinja2 import Environment


class RemoteAccountProtectionTests(unittest.TestCase):
    def test_playbooks_allow_named_exceptions_and_keep_other_protections(self):
        environment = Environment()
        environment.tests['match'] = lambda value, pattern: re.match(pattern, value) is not None
        environment.filters['bool'] = bool
        directory = Path(__file__).resolve().parents[1] / 'ansible'
        cases = [
            ('srvmgr', 999, 'operator', True),
            ('srvmgr', 999, 'srvmgr', True),
            ('sync', 4, 'operator', True),
            ('sync', 4, 'sync', True),
            ('alice', 1000, 'operator', True),
            ('daemon', 1, 'operator', False),
            ('root', 0, 'root', False),
            ('nobody', 65534, 'operator', False),
            ('operator', 1000, 'operator', False),
        ]
        for filename in ('preflight.yml', 'delete_user.yml'):
            play = yaml.safe_load((directory / filename).read_text())[0]
            assertions = [
                environment.compile_expression(expression)
                for task in play['tasks'] if 'ansible.builtin.assert' in task
                for expression in task['ansible.builtin.assert']['that']
            ]
            for username, uid, ssh_user, allowed in cases:
                with self.subTest(playbook=filename, username=username, ssh_user=ssh_user):
                    context = {
                        'managed_username': username, 'ansible_user': ssh_user,
                        'managed_create': False,
                        'target_account': {'rc': 0, 'stdout': f'{username}:x:{uid}:{uid}::/:/bin/sh'},
                    }
                    self.assertEqual(all(check(**context) for check in assertions), allowed)
