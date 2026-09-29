// Append-only list. Never edit a migration that has shipped; add the next one.
export const MIGRATIONS: readonly string[] = [
  // 1: jobs and their event log
  `
  CREATE TABLE jobs (
    id         TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    pipeline   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX jobs_state ON jobs(state, created_at);
  CREATE TABLE events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    type   TEXT NOT NULL,
    at     TEXT NOT NULL,
    data   TEXT NOT NULL
  );
  CREATE INDEX events_job ON events(job_id, id);
  `,
];
