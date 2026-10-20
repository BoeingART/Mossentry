"""Durable, per-host maintenance history. Workers never retry remote mutations."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
from threading import Thread

from . import ansible_service, db
from .errors import friendly_error
from .operations_probe import command_risks

MUTATIONS = {'start', 'stop', 'restart', 'enable', 'disable'}
INTERRUPTED = 'The app stopped before a result was recorded. Check the server before retrying.'


def recover_interrupted():
    with db.connect() as conn:
        conn.execute("UPDATE operation_results SET status='interrupted',error=?,finished_at=? WHERE status IN ('queued','running')",
                     (INTERRUPTED, db.now()))
        conn.execute("UPDATE operation_jobs SET status='interrupted',finished_at=? WHERE status='running'", (db.now(),))


def run_remote(name, payload):
    with tempfile.TemporaryDirectory(prefix='operation-', dir=db.DATA_DIR / 'jobs') as directory:
        result = ansible_service._run('operations.yml', name, {
            'operation_payload': payload,
            'operation_become': payload['operation'] != 'dry_run' and (payload['operation'] in MUTATIONS or payload.get('elevated', False)),
            'operation_output_dir': directory,
        }, timeout=payload.get('timeout', 300) + 30 if payload['operation'] == 'command' else 100)
        path = Path(directory) / (name + '.json')
        if not result.ok or not path.exists():
            raise RuntimeError(result.output or 'No operation result received')
        if path.stat().st_size > 4 * 1024 * 1024:
            raise RuntimeError('Operation result exceeded the size limit')
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or 'checked_at' not in value:
            raise ValueError('Invalid operation response')
        if value.get('error'):
            raise RuntimeError(value['error'])
        return value


def execute_job(job_id, names, payload, actor, lock):
    try:
        for name in names:
            db.execute("UPDATE operation_results SET status='running',started_at=? WHERE job_id=? AND server_name=?",
                       (db.now(), job_id, name))
            try:
                result = run_remote(name, payload)
                failed = result.get('exit_code', 0) != 0 or result.get('timed_out', False) or result.get('syntax_ok') is False
                db.execute("UPDATE operation_results SET status=?,result_json=?,finished_at=? WHERE job_id=? AND server_name=?",
                           ('failed' if failed else 'completed', json.dumps(result, ensure_ascii=False), db.now(), job_id, name))
            except Exception as exc:
                # Raw transport errors can include remote content. Store only a
                # friendly error here; log contents are never copied into audit.
                error = friendly_error(str(exc))
                db.execute("UPDATE operation_results SET status='failed',error=?,finished_at=? WHERE job_id=? AND server_name=?",
                           (error, db.now(), job_id, name))
            db.audit(actor, 'operation_host_finished', name, {'job_id': job_id, 'operation': payload['operation']}, None)
        states = [item['status'] for item in db.rows('SELECT status FROM operation_results WHERE job_id=?', (job_id,))]
        status = 'completed' if all(s == 'completed' for s in states) else 'failed' if all(s == 'failed' for s in states) else 'partial'
        db.execute('UPDATE operation_jobs SET status=?,finished_at=? WHERE id=?', (status, db.now(), job_id))
    except Exception:
        # A local persistence error must not leave a job looking live forever.
        with db.connect() as conn:
            conn.execute("UPDATE operation_results SET status='interrupted',error=?,finished_at=? WHERE job_id=? AND status IN ('queued','running')", (INTERRUPTED, db.now(), job_id))
            conn.execute("UPDATE operation_jobs SET status='interrupted',finished_at=? WHERE id=?", (db.now(), job_id))
    finally:
        lock.release()


def start_job(names, body, actor, lock):
    payload = body.model_dump(exclude={'servers', 'confirmation', 'risk_acknowledged'})
    with db.connect() as conn:
        job_id = conn.execute("INSERT INTO operation_jobs(operation,payload_json,status,requested_by,created_at) VALUES(?,?,'running',?,?)",
                              (body.operation, json.dumps(payload), actor, db.now())).lastrowid
        conn.executemany("INSERT INTO operation_results(job_id,server_name,status) VALUES(?,?,'queued')", [(job_id, name) for name in names])
    worker = Thread(target=execute_job, args=(job_id, names, payload, actor, lock), daemon=True, name=f'mossentry-operation-{job_id}')
    try:
        worker.start()
    except Exception:
        with db.connect() as conn:
            conn.execute("UPDATE operation_jobs SET status='failed',finished_at=? WHERE id=?", (db.now(), job_id))
            conn.execute("UPDATE operation_results SET status='failed',error='Could not start local worker',finished_at=? WHERE job_id=?", (db.now(), job_id))
        raise
    return job_id


def validate_command_request(body):
    if not body.command.strip():
        raise ValueError('Enter a Linux command (up to 32768 characters)')
    if body.operation == 'dry_run':
        return
    if command_risks(body.command, body.elevated) and not body.risk_acknowledged:
        raise ValueError('Acknowledge the command warnings before execution.')


def job_detail(job_id):
    job = db.row('SELECT * FROM operation_jobs WHERE id=?', (job_id,))
    if not job:
        return None
    job['payload'] = json.loads(job.pop('payload_json'))
    job['results'] = db.rows('SELECT * FROM operation_results WHERE job_id=? ORDER BY server_name', (job_id,))
    for item in job['results']:
        item['result'] = json.loads(item.pop('result_json') or 'null')
    return job
