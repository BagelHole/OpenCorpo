import type { Database } from "bun:sqlite";

export type Migration = {
  id: string;
  up: string[];
};

export type MigrationResult = {
  applied: string[];
  currentVersion: string | null;
};

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?;`
    )
    .get(table) as { name?: string } | null;
  return Boolean(row?.name);
}

function tableColumns(db: Database, table: string) {
  const rows = db
    .query(`PRAGMA table_info(${table});`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

const baseMigrations: Migration[] = [
  {
    id: "2026_02_11_001_base_schema",
    up: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        tool TEXT,
        policy TEXT,
        metadata_json TEXT,
        prev_hash TEXT,
        entry_hash TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        requested_by TEXT NOT NULL,
        tool TEXT,
        action TEXT,
        metadata_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT,
        capabilities_json TEXT,
        definition_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        status TEXT NOT NULL,
        output_json TEXT,
        error TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS plugin_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS tool_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        tool TEXT NOT NULL,
        actor TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_id INTEGER,
        job_id INTEGER,
        job_run_id INTEGER,
        input_json TEXT,
        output_json TEXT,
        error TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS capability_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS secret_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        ref TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS control_plane_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        summary TEXT,
        before_json TEXT,
        after_json TEXT,
        risk TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS code_change_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_path TEXT NOT NULL,
        summary TEXT,
        reason TEXT,
        before_content TEXT,
        after_content TEXT NOT NULL,
        approval_id INTEGER,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS diagnostics_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash);`,
      `CREATE INDEX IF NOT EXISTS idx_capability_token ON capability_grants(token);`
    ]
  },
  {
    id: "2026_02_11_002_audit_hash_columns",
    up: []
  },
  {
    id: "2026_02_17_003_ai_memory_tables",
    up: [
      `CREATE TABLE IF NOT EXISTS ai_user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        note_key TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(subject, note_key)
      );`,
      `CREATE TABLE IF NOT EXISTS ai_memory_store (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        data_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_type, owner_id, namespace, data_key)
      );`,
      `CREATE INDEX IF NOT EXISTS idx_ai_user_notes_subject ON ai_user_notes(subject);`,
      `CREATE INDEX IF NOT EXISTS idx_ai_memory_owner ON ai_memory_store(owner_type, owner_id);`
    ]
  }
];

function ensureColumn(db: Database, table: string, column: string, sqlType = "TEXT") {
  const columns = tableColumns(db, table);
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType};`);
  }
}

export function runMigrations(db: Database): MigrationResult {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  // Ensure audit_log has hash columns before any migration that references them.
  // Fixes existing DBs created before these columns were added.
  if (tableExists(db, "audit_log")) {
    ensureColumn(db, "audit_log", "prev_hash");
    ensureColumn(db, "audit_log", "entry_hash");
  }

  const rows = db
    .query(`SELECT version FROM schema_migrations ORDER BY id ASC;`)
    .all() as Array<{ version: string }>;
  const applied = new Set(rows.map((row) => row.version));
  const justApplied: string[] = [];

  for (const migration of baseMigrations) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.up) {
      db.exec(statement);
    }

    if (migration.id === "2026_02_11_002_audit_hash_columns") {
      ensureColumn(db, "audit_log", "prev_hash");
      ensureColumn(db, "audit_log", "entry_hash");
    }

    db.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);`
    ).run(migration.id, new Date().toISOString());
    justApplied.push(migration.id);
  }

  // Safety for existing DBs created before migrations package existed.
  ensureColumn(db, "audit_log", "prev_hash");
  ensureColumn(db, "audit_log", "entry_hash");

  const currentVersion = (
    db
      .query(
        `SELECT version FROM schema_migrations ORDER BY id DESC LIMIT 1;`
      )
      .get() as { version?: string } | null
  )?.version ?? null;

  return {
    applied: justApplied,
    currentVersion
  };
}
