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

  // 2: projects, scenes, versions, assets, webhook outbox
  `
  CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE scenes   (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), n INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX scenes_project ON scenes(project_id, n);
  CREATE TABLE versions (id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id), number INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX versions_scene ON versions(scene_id, number);
  CREATE TABLE assets   (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
  CREATE INDEX assets_project ON assets(project_id);
  CREATE TABLE outbox (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    payload  TEXT NOT NULL,
    state    TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at  TEXT NOT NULL
  );
  CREATE INDEX outbox_due ON outbox(state, next_at);
  `,
];
