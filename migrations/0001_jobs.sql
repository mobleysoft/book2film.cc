CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_owner ON jobs(owner, created_at);
CREATE UNIQUE INDEX one_active_job_per_owner ON jobs(owner)
  WHERE status NOT IN ('complete', 'deleted');
