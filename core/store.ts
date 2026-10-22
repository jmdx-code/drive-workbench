import { DatabaseSync } from 'node:sqlite';
import type { Account, Connection, Settings, Task, TaskItem } from './types.js';
import { sumCounters } from './telemetry.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './types.js';

export interface Repository {
  accounts(): Account[];
  saveAccount(a: Account): void;
  connections(): Connection[];
  saveConnection(c: Connection): void;
  deleteConnection(id: string): void;
  deleteTasks(ids: string[]): void;
  deleteAccount(id: string): void;
  reset(): void;
  tasks(): Task[];
  taskSummaries(): Task[];
  saveTask(t: Task, items?: TaskItem[]): void;
  settings(): Settings;
  saveSettings(s: Settings): void;
}
export class MemoryStore implements Repository {
  protected a = new Map<string, Account>();
  protected c = new Map<string, Connection>();
  protected t = new Map<string, Task>();
  protected s = { ...DEFAULT_SETTINGS };
  accounts() {
    return [...this.a.values()].map((a) => ({
      ...a,
      connections: this.connections().filter((c) => c.accountId === a.id).length,
      ready: this.connections().some((c) => c.accountId === a.id && !c.disabled),
    }));
  }
  saveAccount(a: Account) {
    this.a.set(a.id, structuredClone(a));
  }
  connections() {
    return [...this.c.values()].map((c) => structuredClone(c));
  }
  saveConnection(c: Connection) {
    this.c.set(c.id, structuredClone(c));
  }
  deleteConnection(id: string) {
    this.c.delete(id);
  }
  deleteTasks(ids: string[]) {
    for (const id of ids) this.t.delete(id);
  }
  deleteAccount(id: string) {
    this.a.delete(id);
    for (const c of this.connections()) if (c.accountId === id) this.c.delete(c.id);
  }
  reset() {
    this.a.clear();
    this.c.clear();
    this.t.clear();
    this.s = { ...DEFAULT_SETTINGS };
  }
  tasks() {
    return [...this.t.values()]
      .map((t) => structuredClone(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveTask(t: Task) {
    this.t.set(t.id, structuredClone(t));
  }
  taskSummaries() {
    return this.tasks().map((t) => ({
      ...t,
      api: t.items.some((i) => i.api) ? sumCounters(t.items) : undefined,
      total: t.items.length,
      skipped: t.items.filter((i) => i.state === 'skipped').length,
      succeeded: t.items.filter((i) => i.state === 'succeeded').length,
      items: [],
    }));
  }
  settings() {
    return normalizeSettings(this.s);
  }
  saveSettings(s: Settings) {
    this.s = normalizeSettings(s);
  }
}
export class SqliteStore implements Repository {
  private db: DatabaseSync;
  constructor(
    path: string,
    private encrypt: (s: string) => string,
    private decrypt: (s: string) => string,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS task_items (task_id TEXT NOT NULL, file_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task_id,file_id))',
    );
  }
  private read<T>(kind: string): T[] {
    return (
      this.db.prepare('SELECT body FROM records WHERE kind=?').all(kind) as { body: string }[]
    ).map((r) => JSON.parse(kind === 'connection' ? this.decrypt(r.body) : r.body));
  }
  private write(kind: string, id: string, value: unknown) {
    const raw = JSON.stringify(value);
    this.db
      .prepare(
        'INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',
      )
      .run(kind, id, kind === 'connection' ? this.encrypt(raw) : raw);
  }
  accounts() {
    const cs = this.connections();
    return this.read<Account>('account').map((a) => ({
      ...a,
      connections: cs.filter((c) => c.accountId === a.id).length,
      ready: cs.some((c) => c.accountId === a.id && !c.disabled),
    }));
  }
  saveAccount(a: Account) {
    this.write('account', a.id, a);
  }
  connections() {
    return this.read<Connection>('connection');
  }
  saveConnection(c: Connection) {
    this.write('connection', c.id, c);
  }
  deleteConnection(id: string) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('connection', id);
  }
  private transaction(fn: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  deleteTasks(ids: string[]) {
    this.transaction(() => {
      const items = this.db.prepare('DELETE FROM task_items WHERE task_id=?');
      const record = this.db.prepare(
        "DELETE FROM records WHERE kind IN ('task','taskstate') AND id=?",
      );
      for (const id of ids) {
        items.run(id);
        record.run(id);
      }
    });
  }
  deleteAccount(id: string) {
    const connections = this.connections().filter((c) => c.accountId === id);
    this.transaction(() => {
      for (const c of connections) this.deleteConnection(c.id);
      this.db.prepare("DELETE FROM records WHERE kind='account' AND id=?").run(id);
    });
  }
  reset() {
    this.transaction(() => {
      this.db.exec('DELETE FROM task_items; DELETE FROM records');
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  tasks() {
    const items = this.db.prepare('SELECT task_id,body FROM task_items ORDER BY rowid').all() as {
      task_id: string;
      body: string;
    }[];
    const groups = new Map<string, TaskItem[]>();
    for (const row of items) {
      const group = groups.get(row.task_id) || [];
      group.push(JSON.parse(row.body));
      groups.set(row.task_id, group);
    }
    const states = new Map(
      this.read<Pick<Task, 'id' | 'status' | 'paused' | 'updatedAt'>>('taskstate').map((s) => [
        s.id,
        s,
      ]),
    );
    return this.read<Task>('task')
      .map((t) => ({ ...t, ...states.get(t.id), items: groups.get(t.id) || t.items || [] }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  taskSummaries() {
    const counts = this.db
      .prepare(
        "SELECT task_id,COUNT(*) AS total,SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,SUM(CASE WHEN state='skipped' THEN 1 ELSE 0 END) AS skipped,SUM(COALESCE(json_extract(body,'$.api.reads'),0)) AS reads,SUM(COALESCE(json_extract(body,'$.api.writes'),0)) AS writes,SUM(COALESCE(json_extract(body,'$.api.retries'),0)) AS retries,SUM(COALESCE(json_extract(body,'$.api.rateLimits'),0)) AS rateLimits,SUM(CASE WHEN json_type(body,'$.api') IS NOT NULL THEN 1 ELSE 0 END) AS measured FROM task_items GROUP BY task_id",
      )
      .all() as {
      task_id: string;
      total: number;
      succeeded: number;
      skipped: number;
      reads: number;
      writes: number;
      retries: number;
      rateLimits: number;
      measured: number;
    }[];
    const byId = new Map(counts.map((c) => [c.task_id, c]));
    const states = new Map(
      this.read<Pick<Task, 'id' | 'status' | 'paused' | 'updatedAt'>>('taskstate').map((s) => [
        s.id,
        s,
      ]),
    );
    return this.read<Task>('task')
      .map((t) => {
        const c = byId.get(t.id);
        return {
          ...t,
          ...states.get(t.id),
          api: c?.measured
            ? { reads: c.reads, writes: c.writes, retries: c.retries, rateLimits: c.rateLimits }
            : undefined,
          total: c?.total ?? t.items.length,
          skipped: c?.skipped ?? t.items.filter((i) => i.state === 'skipped').length,
          succeeded: c?.succeeded ?? t.items.filter((i) => i.state === 'succeeded').length,
          items: [],
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveTask(t: Task, items = t.items) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=?').get('task', t.id))
        this.write('task', t.id, { ...t, items: [] });
      this.write('taskstate', t.id, {
        id: t.id,
        status: t.status,
        paused: t.paused,
        updatedAt: t.updatedAt,
      });
      const stmt = this.db.prepare(
        'INSERT INTO task_items VALUES (?,?,?,?) ON CONFLICT(task_id,file_id) DO UPDATE SET state=excluded.state,body=excluded.body',
      );
      for (const i of items) stmt.run(t.id, i.file.id, i.state, JSON.stringify(i));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  settings() {
    return normalizeSettings(this.read<Settings>('settings')[0]);
  }
  saveSettings(s: Settings) {
    this.write('settings', 'default', normalizeSettings(s));
  }
  close() {
    this.db.close();
  }
}
