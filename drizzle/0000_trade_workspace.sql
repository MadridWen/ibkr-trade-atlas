CREATE TABLE user_workspaces (
  owner_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE workspace_chunks (
  owner_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  rows_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, snapshot_id, chunk_no)
);
--> statement-breakpoint
CREATE INDEX workspace_chunks_created ON workspace_chunks(owner_id, created_at);
