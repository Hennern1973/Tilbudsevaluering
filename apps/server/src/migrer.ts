import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { type Db, lagPool } from './db.js';

/**
 * Kjører SQL-filene i db/migrations i navnerekkefølge, hver i sin transaksjon.
 * Kjørte filer registreres i skjema_migrering og kjøres aldri på nytt.
 */
export async function migrer(db: Db, mappe = config.migreringsmappe, logg = console.log): Promise<string[]> {
  await db.query(`create table if not exists skjema_migrering (
    navn text primary key, kjort_tid timestamptz not null default now())`);
  const kjort = new Set((await db.query<{ navn: string }>('select navn from skjema_migrering')).rows.map((r) => r.navn));
  const filer = (await readdir(mappe)).filter((f) => f.endsWith('.sql')).sort();
  const nye: string[] = [];

  for (const fil of filer) {
    if (kjort.has(fil)) continue;
    const sql = await readFile(path.join(mappe, fil), 'utf8');
    const k = await db.connect();
    try {
      await k.query('begin');
      await k.query(sql);
      await k.query('insert into skjema_migrering (navn) values ($1)', [fil]);
      await k.query('commit');
      logg(`Kjørte ${fil}`);
      nye.push(fil);
    } catch (e) {
      await k.query('rollback');
      throw new Error(`Migreringen ${fil} feilet: ${(e as Error).message}`);
    } finally {
      k.release();
    }
  }
  if (nye.length === 0) logg('Databasen er oppdatert.');
  return nye;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = lagPool(config.databaseUrl);
  migrer(db)
    .then(() => db.end())
    .catch(async (e) => {
      console.error(e.message);
      await db.end();
      process.exit(1);
    });
}
