"""Persistent username history and aggregate dashboard statistics."""
from collections import Counter
from datetime import UTC, datetime, timedelta


def creation_time(value):
    if not value:
        return None
    try:
        date = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    # Yearless auth.log entries cannot be placed on a historical timeline.
    return date.astimezone(UTC) if date.tzinfo is not None else None


def remember_users(conn):
    for account in conn.execute('SELECT username,created_at,created_at_source,scanned_at FROM server_users'):
        previous = conn.execute('SELECT * FROM user_history WHERE username=?', (account['username'],)).fetchone()
        if previous is None:
            conn.execute(
                '''INSERT INTO user_history(username,created_at,created_at_source,first_seen_at,last_seen_at)
                VALUES(?,?,?,?,?)''',
                (account['username'], account['created_at'], account['created_at_source'], account['scanned_at'], account['scanned_at']),
            )
            continue
        before, candidate = creation_time(previous['created_at']), creation_time(account['created_at'])
        priority = {'auth_log': 0, 'journal': 0, 'home_birth': 1}
        old_priority = priority.get(previous['created_at_source'], 2)
        new_priority = priority.get(account['created_at_source'], 2)
        # A real useradd record can correct an earlier home-directory estimate.
        # Among equally reliable records, keep the earliest date across hosts.
        replace = candidate is not None and (before is None or new_priority < old_priority
                   or (new_priority == old_priority and candidate < before))
        conn.execute(
            '''UPDATE user_history SET created_at=?,created_at_source=?,first_seen_at=?,last_seen_at=?
            WHERE username=?''',
            (account['created_at'] if replace else previous['created_at'],
             account['created_at_source'] if replace else previous['created_at_source'],
             min(previous['first_seen_at'], account['scanned_at']),
             max(previous['last_seen_at'], account['scanned_at']), account['username']),
        )


def statistics(conn, current_time):
    end = creation_time(current_time)
    daily = Counter()
    total = 0
    recent = 0
    for user in conn.execute('SELECT created_at FROM user_history'):
        total += 1
        date = creation_time(user['created_at'])
        if date is not None and date <= end:
            daily[date.date().isoformat()] += 1
            if date >= end - timedelta(days=30):
                recent += 1
    running = 0
    history = []
    for date, added in sorted(daily.items()):
        running += added
        history.append({'date': date, 'total': running, 'added': added})
    return {
        'total_unique_users': total,
        'dated_users': running,
        'undated_users': total - running,
        'new_users_30d': recent,
        'history': history,
        'through': end.date().isoformat(),
    }
