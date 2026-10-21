import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src-tauri" / "remote"))

import unittest
from unittest.mock import patch, MagicMock

class RemoteSafetyTests(unittest.TestCase):
    def test_protected_and_missing_accounts_are_rejected_before_commands(self):
        import remote_actions
        with patch.object(remote_actions.sys, 'platform', 'linux'), \
             patch.object(remote_actions, 'account', return_value=MagicMock(pw_uid=0)), \
             patch.object(remote_actions.os, 'geteuid', return_value=0), \
             patch.object(remote_actions, 'command') as command:
            for name in ['root', 'nobody', 'operator', 'bad;name']:
                with self.assertRaises(ValueError):
                    remote_actions.run({'operation': 'delete_user', 'managed_username': name, 'ssh_user': 'operator'})
            command.assert_not_called()

    def test_delete_keeps_home_and_does_not_force(self):
        import remote_actions
        with patch.object(remote_actions, 'account', return_value=MagicMock(pw_uid=1001)), \
             patch.object(remote_actions.os, 'geteuid', return_value=0), \
             patch.object(remote_actions.sys, 'platform', 'linux'), \
             patch.object(remote_actions, 'command') as command:
            remote_actions.run({'operation': 'delete_user', 'managed_username': 'alice', 'ssh_user': 'operator'})
            command.assert_called_once_with(['userdel', 'alice'])


if __name__ == '__main__':
    unittest.main()
