"""Local, bounded log hints. Diagnostics never replace the command's exit code."""
from __future__ import annotations

import re

DIAGNOSTICS_VERSION = 1
MAX_MATCHES = 5
MAX_LINE_LENGTH = 2000
ANSI_ESCAPE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')

# Match explicit diagnostic forms rather than arbitrary mentions of "error" or
# "failed" (for example, "0 errors" and "*.error.log" are ordinary output).
RULES = [
    ('shell', 'A shell or package script reported an error.',
     r':\s*(?:Illegal number|integer expression expected|syntax error|unbound variable|bad substitution|command not found)\b'),
    ('service', 'A service operation reported a problem.',
     r'(?:^|:\s*)(?:Could not execute systemctl\b|(?:Failed|Unable) to (?:start|stop|restart|reload|enable|disable)\b)'),
    ('configuration', 'Package configuration reported a problem or used a fallback.',
     r'^(?:debconf|dpkg-preconfigure):\s*(?:unable to|falling back to)\b'),
    ('packages', 'The package manager reported a problem.',
     r'^(?:E:\s*|dpkg:\s*(?:error|warning):|.*\bpackages have unmet dependencies:)'),
    ('access', 'The command reported an access or storage problem.',
     r':\s*(?:Permission denied|Operation not permitted|No space left on device|Read-only file system)\b'),
    ('exception', 'The command reported an exception.',
     r'^Traceback \(most recent call last\):'),
    ('error', 'The command reported an error.',
     r'^(?:[\w./-]+(?:\[\d+\])?:\s*)?(?:error|fatal|critical)\s*:'),
    ('warning', 'The command reported a warning.',
     r'^(?:[\w./-]+(?:\[\d+\])?:\s*)?(?:warning|warn)\s*:'),
]
RULES = [(code, summary, re.compile(pattern, re.IGNORECASE)) for code, summary, pattern in RULES]


def analyze_output(result):
    """Keep verbatim evidence from both streams, grouped by rule and source."""
    diagnostics = {}
    for stream in ('stdout', 'stderr'):
        output = result.get(stream)
        if not isinstance(output, str):
            continue
        for line_number, line in enumerate(output.splitlines(), 1):
            plain = ANSI_ESCAPE.sub('', line).strip()
            for code, summary, pattern in RULES:
                if not pattern.search(plain):
                    continue
                item = diagnostics.setdefault((stream, code), {
                    'code': code, 'summary': summary, 'stream': stream, 'count': 0, 'matches': [],
                })
                item['count'] += 1
                if len(item['matches']) < MAX_MATCHES:
                    item['matches'].append({
                        'line': line_number, 'text': line[:MAX_LINE_LENGTH],
                        'truncated': len(line) > MAX_LINE_LENGTH,
                    })
                break
    return {**result, 'output_diagnostics': list(diagnostics.values()),
            'output_diagnostics_version': DIAGNOSTICS_VERSION}


def result_status(result):
    if result.get('exit_code', 0) != 0 or result.get('timed_out', False) or result.get('syntax_ok') is False:
        return 'failed'
    return 'completed_with_warnings' if result.get('output_diagnostics') else 'completed'


def job_status(states):
    if states and all(state in {'completed', 'completed_with_warnings'} for state in states):
        return 'completed_with_warnings' if 'completed_with_warnings' in states else 'completed'
    return 'failed' if states and all(state == 'failed' for state in states) else 'partial'
