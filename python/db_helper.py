"""
Thin read-only wrapper around the app's SQLite database for future Python workers.

In v1 no Python child touches the DB directly — all writes go through main.js.
This module is scaffolded so Phase 2 workers (CDI rule engine, embedding indexers, etc.)
have a documented, tested entry point rather than ad-hoc sqlite3 usage.

Usage (read-only by default):
    from db_helper import get_db
    db = get_db('/path/to/AI Medical Notes/app.db')
    rows = db.execute('SELECT * FROM cases WHERE status = ?', ('completed',)).fetchall()
"""

import sqlite3
import os


def get_db(db_path: str, write: bool = False) -> sqlite3.Connection:
    """Open a connection to app.db.

    Args:
        db_path: Absolute path to app.db inside the notes directory.
        write:   Set True only if this worker needs to INSERT/UPDATE rows.
                 Default is read-only (uri=True with mode=ro).

    Returns:
        A sqlite3.Connection with row_factory set to sqlite3.Row.
    """
    if not os.path.exists(db_path):
        raise FileNotFoundError(f'app.db not found at: {db_path}')

    if write:
        conn = sqlite3.connect(db_path, timeout=5.0, check_same_thread=False)
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute('PRAGMA foreign_keys = ON')
        conn.execute('PRAGMA busy_timeout = 5000')
    else:
        uri = f'file:{db_path}?mode=ro'
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)

    conn.row_factory = sqlite3.Row
    return conn
