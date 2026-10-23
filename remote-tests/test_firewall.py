import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('firewall', Path(__file__).resolve().parents[1] / 'src-tauri/remote/firewall.py')
fw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fw)
PEER = '192.0.2.10 50000 192.0.2.1 2222'
ALLOW = '-A ufw-user-input -p tcp --dport 2222 -j ACCEPT'


class FirewallTests(unittest.TestCase):
    def test_persisted_rules_check_port_protocol_source_destination_and_order(self):
        cases = [
            ('', False), (ALLOW, True),
            (ALLOW.replace('2222', '22'), False),
            (ALLOW.replace('tcp', 'udp'), False),
            (ALLOW.replace('user-input', 'user-output'), False),
            ('-A ufw-user-input -s 192.0.2.0/24 -p tcp -m tcp --dport 2222 -j ACCEPT', True),
            ('-A ufw-user-input -s 198.51.100.1/32 -p tcp --dport 2222 -j ACCEPT', False),
            ('-A ufw-user-input -d 198.51.100.1/32 -p tcp --dport 2222 -j ACCEPT', False),
            ('-A ufw-user-input -p tcp -m multiport --dports 22,2200:2300 -j ACCEPT', True),
            (ALLOW.replace('ACCEPT', 'DROP') + '\n' + ALLOW, False),
            (ALLOW.replace('2222', '80').replace('ACCEPT', 'REJECT') + '\n' + ALLOW, True),
            ('-A ufw-user-input -i eth0 -p tcp --dport 2222 -j ACCEPT', False),
            ('-A ufw-user-input -p tcp --dport 2222 -j ufw-user-limit\n' + ALLOW, False),
            ('-A ufw-user-input -p tcp --dport 2222 -j LOG\n' + ALLOW, True),
            (ALLOW + '\n' + ALLOW.replace('ACCEPT', 'DROP'), True),
            (ALLOW.replace('2222', 'bad'), False),
            ('-A ufw-user-input ! -s 192.0.2.10 -j ACCEPT', False),
        ]
        for rules, expected in cases:
            with self.subTest(rules=rules), patch.object(fw.Path, 'read_text', return_value=rules):
                self.assertEqual(fw.ssh_allowed(fw.connection(PEER)), expected)

    def test_ipv6_profiles_expand_to_tcp_rules_and_fail_closed_on_missing_context(self):
        peer = fw.connection('2001:db8::10 50000 2001:db8::1 2222')
        def read(path):
            return 'IPV6=yes\n' if str(path) == '/etc/default/ufw' else ALLOW
        with patch.object(fw.Path, 'read_text', read):
            self.assertTrue(fw.ssh_allowed(peer))
        with patch.object(fw.Path, 'read_text', return_value='IPV6=no\n'):
            self.assertFalse(fw.ssh_allowed(peer))
        with patch.object(fw.Path, 'read_text', side_effect=FileNotFoundError):
            self.assertFalse(fw.ssh_allowed(fw.connection(PEER)))
        for value in ('', PEER.replace('2222', '0'), 'bad context'):
            self.assertIsNone(fw.connection(value))
            self.assertFalse(fw.ssh_allowed(fw.connection(value)))

    def test_enable_without_allow_never_executes_enable_even_if_client_claims_safe(self):
        with patch.object(fw.shutil, 'which', return_value='/usr/sbin/ufw'), patch.object(fw, 'command', side_effect=lambda args: 'Status: inactive\n' if args[-1] == 'status' else 'Added user rules:\n'), patch.object(fw.Path, 'read_text', return_value='') as read:
            with patch.object(fw, 'command', wraps=fw.command) as command:
                result = fw.run({'operation': 'enable', 'ssh_allowed': True}, PEER)
                self.assertEqual(result['error'], fw.SSH_BLOCKED)
                self.assertFalse(any('enable' in call.args[0] for call in command.call_args_list))
                self.assertTrue(read.called)

    def test_enable_rechecks_in_remote_operation_and_uses_force(self):
        enabled = False
        def command(args):
            nonlocal enabled
            if args[-1] == 'status':
                return 'Status: active\n' if enabled else 'Status: inactive\n'
            if args[-1] == 'added':
                return 'Added user rules:\nufw allow 2222/tcp\n'
            self.assertEqual(args, ['/usr/sbin/ufw', '--force', 'enable'])
            enabled = True
            return ''
        with patch.object(fw.shutil, 'which', return_value='/usr/sbin/ufw'), patch.object(fw, 'command', command), patch.object(fw.Path, 'read_text', return_value=ALLOW):
            self.assertTrue(fw.run({'operation': 'enable'}, PEER)['enabled'])
        with patch.object(fw.shutil, 'which', return_value='/usr/sbin/ufw'), patch.object(fw, 'snapshot', return_value={'enabled': False}), patch.object(fw, 'ssh_allowed', return_value=False), patch.object(fw, 'command') as command:
            self.assertEqual(fw.run({'operation': 'enable'}, PEER)['error'], fw.SSH_BLOCKED)
            command.assert_not_called()

    def test_inactive_rules_remain_visible_and_delete_is_snapshot_bound(self):
        output = "Added user rules:\nufw allow 2222/tcp\nufw allow from 192.0.2.10 to any port 80 proto tcp\n"
        def command(args):
            return 'Status: inactive\n' if args[-1] == 'status' else output
        with patch.object(fw.shutil, 'which', return_value='/usr/sbin/ufw'), patch.object(fw, 'command', side_effect=command) as cmd, patch.object(fw.Path, 'read_text', return_value=ALLOW):
            state = fw.run({'operation': 'status'}, PEER)
            self.assertFalse(state['enabled'])
            self.assertEqual(len(state['rules']), 2)
            cmd.reset_mock()
            self.assertIn('error', fw.run({'operation': 'delete', 'rule_id': 0, 'revision': 'stale'}, PEER))
            self.assertFalse(any('delete' in c.args[0] for c in cmd.call_args_list))
            fw.run({'operation': 'delete', 'rule_id': 0, 'revision': state['revision']}, PEER)
            self.assertIn(unittest.mock.call(['/usr/sbin/ufw', '--force', 'delete', 'allow', '2222/tcp']), cmd.call_args_list)

    def test_add_validates_source_and_argv_without_a_shell(self):
        base = {'port': 443, 'protocol': 'tcp', 'action': 'allow', 'source': 'any'}
        self.assertEqual(fw.rule_args(base), ['allow', 'in', 'from', 'any', 'to', 'any', 'port', '443', 'proto', 'tcp'])
        self.assertIn('2001:db8::1/128', fw.rule_args({**base, 'source': '2001:db8::1'}))
        for field, value in [('source', 'any; touch /tmp/pwn'), ('source', ''), ('source', None), ('port', True), ('port', 0), ('port', 65536), ('port', '22'), ('protocol', 'tcp;id'), ('action', 'reset')]:
            with self.subTest(field=field, value=value), patch.object(fw.shutil, 'which', return_value='ufw'), patch.object(fw, 'command') as command:
                with self.assertRaises(ValueError):
                    fw.run({'operation': 'add', **base, field: value})
                command.assert_not_called()

    def test_missing_ufw_and_disable_keeps_saved_rules(self):
        with patch.object(fw.shutil, 'which', return_value=None), patch.object(fw, 'command') as command:
            self.assertEqual(fw.run({'operation': 'status'}), {'available': False})
            command.assert_not_called()
        with patch.object(fw.shutil, 'which', return_value='ufw'), patch.object(fw, 'command') as command, patch.object(fw, 'snapshot', return_value={'enabled': False}):
            fw.run({'operation': 'disable'}, PEER)
            command.assert_called_once_with(['ufw', '--force', 'disable'])

    def test_route_and_quoted_comments_delete_as_literal_arguments(self):
        output = "Added user rules:\nufw route allow from 192.0.2.0/24 to any port 80\nufw allow 443/tcp comment '中文; $(id)'\n"
        with patch.object(fw.shutil, 'which', return_value='ufw'), patch.object(fw, 'command', return_value=output) as command, patch.object(fw, 'snapshot', return_value={}):
            _, revision = fw.saved_rules('ufw')
            fw.run({'operation': 'delete', 'rule_id': 0, 'revision': revision})
            self.assertIn(unittest.mock.call(['ufw', '--force', 'route', 'delete', 'allow', 'from', '192.0.2.0/24', 'to', 'any', 'port', '80']), command.call_args_list)
            fw.run({'operation': 'delete', 'rule_id': 1, 'revision': revision})
            self.assertIn(unittest.mock.call(['ufw', '--force', 'delete', 'allow', '443/tcp', 'comment', '中文; $(id)']), command.call_args_list)

    def test_enable_checks_result_and_does_not_claim_success_if_still_inactive(self):
        with patch.object(fw.shutil, 'which', return_value='ufw'), patch.object(fw, 'command'), patch.object(fw, 'snapshot', return_value={'enabled': False}), patch.object(fw, 'ssh_allowed', return_value=True):
            self.assertIn('error', fw.run({'operation': 'enable'}, PEER))
