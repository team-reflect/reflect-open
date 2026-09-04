"""Isolated FTS maintenance, including implemented note_search bookkeeping.

Uses synthetic in-memory data. Excludes the remaining note projection writes,
disk, IPC and native launch/UI latency. Timings are not application speedups.
Run: python3 fts-benchmark.py /path/to/reflect-open
"""
import json
import pathlib
import sqlite3
import statistics
import sys
import time

ROOT = pathlib.Path(sys.argv[1])
MIGRATION = (ROOT / "crates/index-schema/migrations/0021_search_fts_identity.sql").read_text()


def connect(mode):
    connection = sqlite3.connect(":memory:")
    connection.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE notes(path TEXT PRIMARY KEY NOT NULL);
        CREATE VIRTUAL TABLE search_fts USING fts5(path UNINDEXED, title, body);
    """)
    if mode == "indexed_mapping":
        connection.executescript(MIGRATION)
    return connection


def remove(connection, mode, path):
    if mode == "path_scan":
        connection.execute("DELETE FROM notes WHERE path=?", (path,))
        connection.execute("DELETE FROM search_fts WHERE path=?", (path,))
        return None
    row = connection.execute("SELECT rowid FROM note_search WHERE note_path=?", (path,)).fetchone()
    rowid = row[0] if row else None
    if rowid is not None:
        connection.execute("DELETE FROM search_fts WHERE rowid=?", (rowid,))
    connection.execute("DELETE FROM notes WHERE path=?", (path,))
    return rowid


def apply(connection, mode, path):
    rowid = remove(connection, mode, path)
    connection.execute("INSERT INTO notes(path) VALUES(?)", (path,))
    if mode == "path_scan":
        connection.execute("INSERT INTO search_fts(path,title,body) VALUES(?,?,?)", (path, "Title", "Short body text"))
    else:
        rowid = connection.execute("INSERT INTO note_search(rowid,note_path) VALUES(?,?) RETURNING rowid", (rowid, path)).fetchone()[0]
        connection.execute("INSERT INTO search_fts(rowid,path,title,body) VALUES(?,?,?,?)", (rowid, path, "Title", "Short body text"))


report = {"sqlite_version": sqlite3.sqlite_version, "maintenance_trials": [], "delete_trials": []}
for count in (2000, 10000):
    for mode in ("path_scan", "indexed_mapping"):
        connection = connect(mode)
        for phase in ("populate", "replace"):
            start = time.perf_counter()
            for index in range(count):
                apply(connection, mode, f"notes/{index}.md")
            connection.commit()
            report["maintenance_trials"].append({"rows": count, "mode": mode, "phase": phase, "seconds": round(time.perf_counter() - start, 4)})
        connection.close()

for count in (1000, 10000, 50000):
    for mode in ("path_scan", "indexed_mapping"):
        connection = connect(mode)
        connection.executemany("INSERT INTO notes(path) VALUES(?)", ((f"notes/{index}.md",) for index in range(count)))
        connection.executemany("INSERT INTO search_fts(rowid,path,title,body) VALUES(?,?,?,?)", ((index + 1, f"notes/{index}.md", "Title", "Short body text") for index in range(count)))
        if mode == "indexed_mapping":
            connection.execute("INSERT INTO note_search(rowid,note_path) SELECT rowid,path FROM search_fts")
        connection.commit()
        for path in (f"notes/{count-1}.md", "notes/missing.md"):
            times = []
            for trial in range(20):
                connection.execute("SAVEPOINT bench")
                start = time.perf_counter()
                remove(connection, mode, path)
                times.append((time.perf_counter() - start) * 1000)
                connection.execute("ROLLBACK TO bench")
                connection.execute("RELEASE bench")
            steps = [0]
            def instruction():
                steps[0] += 1
                return 0
            connection.execute("SAVEPOINT bench")
            connection.set_progress_handler(instruction, 1)
            remove(connection, mode, path)
            connection.set_progress_handler(None, 0)
            connection.execute("ROLLBACK TO bench")
            connection.execute("RELEASE bench")
            report["delete_trials"].append({"rows": count, "mode": mode, "path": path, "median_ms": round(statistics.median(times), 4), "vm_instructions": steps[0]})
        if mode == "indexed_mapping":
            report["mapping_plan"] = list(connection.execute("EXPLAIN QUERY PLAN SELECT rowid FROM note_search WHERE note_path=?", ("notes/missing.md",)))
            report["rename_plan"] = list(connection.execute("EXPLAIN QUERY PLAN UPDATE search_fts SET path=? WHERE rowid=(SELECT rowid FROM note_search WHERE note_path=?)", ("notes/moved.md", "notes/moved.md")))
        connection.close()

print(json.dumps(report, indent=2))
