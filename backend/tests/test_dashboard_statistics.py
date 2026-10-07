import sqlite3
import unittest

from app.db import SCHEMA
from app.user_history import remember_users, statistics


class DashboardStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.addCleanup(self.conn.close)

    def account(self, server, username, date, source='auth_log', observed='2026-10-06T12:00:00+00:00'):
        self.conn.execute(
            '''INSERT OR REPLACE INTO server_users(server_id,username,uid,gid,home,shell,is_sudo,is_disabled,
            scanned_at,created_at,created_at_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
            (server, username, 0 if username == 'root' else 1000, 1000, '/home/' + username,
             '/bin/bash', 0, 0, observed, date, source),
        )

    def test_counts_all_accounts_once_and_uses_earliest_creation_across_hosts(self):
        self.account(1, 'root', '2020-01-01T00:00:00Z')
        self.account(2, 'root', '2024-01-01T00:00:00Z')
        self.account(1, 'srvmgr', '2021-01-01T00:00:00Z')
        self.account(1, 'ssh-operator', '2022-01-01T00:00:00Z')
        self.account(1, 'daemon', '2023-01-01T00:00:00Z')
        self.account(1, 'alice', '2025-01-01T00:00:00Z')
        self.account(2, 'alice', '2024-01-01T00:00:00Z')
        remember_users(self.conn)
        result = statistics(self.conn, '2026-10-06T12:00:00Z')
        self.assertEqual(result['total_unique_users'], 5)
        self.assertEqual(result['dated_users'], 5)
        self.assertEqual([point['total'] for point in result['history']], [1, 2, 3, 4, 5])
        self.assertEqual(result['history'][-1]['date'], '2024-01-01')

    def test_unknown_yearless_naive_and_future_dates_are_not_invented(self):
        for name, date in [('missing', None), ('yearless', 'Aug 9 10:11:12'), ('invalid', 'bad'),
                           ('naive', '2025-01-01T00:00:00'), ('future', '2099-01-01T00:00:00Z')]:
            self.account(1, name, date)
        remember_users(self.conn)
        result = statistics(self.conn, '2026-10-06T12:00:00Z')
        self.assertEqual(result['total_unique_users'], 5)
        self.assertEqual(result['undated_users'], 5)
        self.assertEqual(result['history'], [])

    def test_history_survives_removal_repeated_sync_and_date_backfill(self):
        self.account(1, 'alice', None)
        remember_users(self.conn)
        self.account(1, 'alice', '2020-01-01T00:00:00Z')
        remember_users(self.conn)
        remember_users(self.conn)
        self.conn.execute('DELETE FROM server_users')
        result = statistics(self.conn, '2026-10-06T12:00:00Z')
        self.assertEqual(result['total_unique_users'], 1)
        self.assertEqual(result['history'], [{'date': '2020-01-01', 'total': 1, 'added': 1}])
        self.account(2, 'alice', '2026-01-01T00:00:00Z')
        remember_users(self.conn)
        self.assertEqual(statistics(self.conn, '2026-10-06T12:00:00Z')['history'], result['history'])

    def test_same_day_counts_utc_timezone_conversion_and_recent_growth(self):
        self.account(1, 'alice', '2026-10-06T01:00:00+08:00')
        self.account(1, 'bob', '2026-10-05T19:00:00Z')
        self.account(1, 'charlie', '2020-01-01T00:00:00Z')
        remember_users(self.conn)
        result = statistics(self.conn, '2026-10-06T12:00:00Z')
        self.assertEqual(result['history'][-1], {'date': '2026-10-05', 'total': 3, 'added': 2})
        self.assertEqual(result['new_users_30d'], 2)
        self.assertEqual(result['through'], '2026-10-06')

    def test_log_dates_correct_home_directory_estimates(self):
        self.account(1, 'alice', '2020-01-01T00:00:00Z', 'home_birth')
        remember_users(self.conn)
        self.account(1, 'alice', '2021-01-01T00:00:00Z', 'auth_log')
        remember_users(self.conn)
        self.account(2, 'alice', '2019-01-01T00:00:00Z', 'home_birth')
        remember_users(self.conn)
        result = statistics(self.conn, '2026-10-06T12:00:00Z')
        self.assertEqual(result['history'], [{'date': '2021-01-01', 'total': 1, 'added': 1}])

    def test_scan_parser_includes_system_and_management_accounts(self):
        from app.ansible_service import _parse_scan
        accounts = _parse_scan('host', {'passwd': '\n'.join([
            'root:x:0:0::/root:/bin/bash', 'daemon:x:1:1::/:/bin/false',
            'srvmgr:x:999:999::/home/srvmgr:/bin/bash', 'operator:x:998:998::/home/operator:/bin/bash',
            'nobody:x:65534:65534::/nonexistent:/bin/false',
        ])})
        self.assertEqual([user['username'] for user in accounts], ['root', 'daemon', 'srvmgr', 'operator', 'nobody'])
