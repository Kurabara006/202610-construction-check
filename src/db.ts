import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RecordEntry } from './types';

interface CheckDB extends DBSchema {
  entries: {
    key: string;
    value: RecordEntry;
    indexes: { 'by-created': number };
  };
}

const DB_NAME = 'construction-check';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<CheckDB>> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<CheckDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('by-created', 'createdAt');
      },
    });
  }
  return dbPromise;
}

export async function listEntries(): Promise<RecordEntry[]> {
  const db = await getDb();
  return db.getAllFromIndex('entries', 'by-created');
}

export async function addEntry(entry: RecordEntry): Promise<void> {
  const db = await getDb();
  await db.put('entries', entry);
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('entries', id);
}

export async function clearAllEntries(): Promise<void> {
  const db = await getDb();
  await db.clear('entries');
}
