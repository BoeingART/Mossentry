"""Output classification uses local fixtures and never contacts a server."""
import unittest

from app.operation_diagnostics import analyze_output, job_status, result_status, MAX_MATCHES, MAX_LINE_LENGTH


class OutputDiagnosticTests(unittest.TestCase):
    def test_both_streams_keep_original_output_and_locatable_evidence(self):
        stdout = 'Setting up example...\r\n/var/lib/dpkg/info/example.postinst: 148: [: Illegal number: yes\r\nCould not execute systemctl: at /usr/bin/deb-systemd-invoke line 148.\r\n'
        stderr = 'debconf: unable to initialize frontend: Dialog\ndebconf: falling back to frontend: Readline\n'
        original = {'stdout': stdout, 'stderr': stderr, 'exit_code': 0}
        result = analyze_output(original)
        self.assertEqual(result_status(result), 'completed_with_warnings')
        self.assertEqual((result['stdout'], result['stderr'], result['exit_code']), (stdout, stderr, 0))
        self.assertNotIn('output_diagnostics', original)
        by_code = {item['code']: item for item in result['output_diagnostics']}
        self.assertEqual(by_code['shell']['stream'], 'stdout')
        self.assertEqual(by_code['shell']['matches'][0]['line'], 2)
        self.assertEqual(by_code['shell']['matches'][0]['text'], stdout.splitlines()[1])
        self.assertEqual(by_code['service']['matches'][0]['line'], 3)
        self.assertEqual(by_code['configuration']['stream'], 'stderr')
        self.assertEqual(by_code['configuration']['count'], 2)

    def test_nonempty_stderr_and_error_words_are_not_diagnostics(self):
        result = analyze_output({
            'stdout': '0 errors\nNo errors found\n0 failed tests\nWriting /tmp/error.log\n',
            'stderr': 'Downloading 100%\nProgress: 50%\nEverything is up to date.\n',
            'exit_code': 0, 'risk_warnings': ['Package changes may restart services.'],
        })
        self.assertEqual(result['output_diagnostics'], [])
        self.assertEqual(result_status(result), 'completed')

    def test_explicit_messages_are_detected_in_either_stream_including_ansi(self):
        messages = [
            'WARNING: apt does not have a stable CLI interface.',
            'E: Unable to correct problems, you have held broken packages.',
            'tool: error: the request could not be processed',
            'tool: fatal: the request could not be processed',
            'rm: cannot remove file: Permission denied',
            'bash: missing_program: command not found',
            'Failed to restart example.service: Unit not found.',
            'Traceback (most recent call last):',
        ]
        for stream in ('stdout', 'stderr'):
            for message in messages:
                with self.subTest(stream=stream, message=message):
                    raw = '\x1b[31m' + message + '\x1b[0m'
                    result = analyze_output({stream: raw, 'exit_code': 0})
                    self.assertEqual(result_status(result), 'completed_with_warnings')
                    self.assertEqual(result['output_diagnostics'][0]['matches'][0]['text'], raw)
                    self.assertEqual(result['output_diagnostics'][0]['stream'], stream)

    def test_evidence_is_bounded_without_losing_counts_or_original_output(self):
        long_line = 'WARNING: ' + 'x' * (MAX_LINE_LENGTH + 1)
        output = (long_line + '\n') * (MAX_MATCHES + 3)
        result = analyze_output({'stdout': output, 'exit_code': 0})
        diagnostic, = result['output_diagnostics']
        self.assertEqual(diagnostic['count'], MAX_MATCHES + 3)
        self.assertEqual(len(diagnostic['matches']), MAX_MATCHES)
        self.assertEqual(len(diagnostic['matches'][0]['text']), MAX_LINE_LENGTH)
        self.assertTrue(diagnostic['matches'][0]['truncated'])
        self.assertEqual(result['stdout'], output)

    def test_failure_signals_take_priority_and_real_exit_code_is_preserved(self):
        for overrides in ({'exit_code': 100}, {'exit_code': -9, 'timed_out': True},
                          {'exit_code': 0, 'timed_out': True}, {'exit_code': 0, 'syntax_ok': False}):
            with self.subTest(overrides=overrides):
                result = analyze_output({'stdout': 'ERROR: problem\n', **overrides})
                self.assertEqual(result_status(result), 'failed')
                self.assertEqual(result['exit_code'], overrides['exit_code'])

    def test_job_aggregation_distinguishes_warning_only_from_partial_failure(self):
        cases = [
            (['completed', 'completed'], 'completed'),
            (['completed', 'completed_with_warnings'], 'completed_with_warnings'),
            (['completed_with_warnings', 'completed_with_warnings'], 'completed_with_warnings'),
            (['completed_with_warnings', 'failed'], 'partial'),
            (['completed', 'failed'], 'partial'),
            (['failed', 'failed'], 'failed'),
        ]
        for states, expected in cases:
            with self.subTest(states=states):
                self.assertEqual(job_status(states), expected)
