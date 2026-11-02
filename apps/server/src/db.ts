import pg from 'pg';

// NUMERIC kommer som tekst fra pg. Det beholdes slik, så beløp aldri går via flyttall.
// DATE (1082) leveres som tekst «2026-11-10» i stedet for en Date i lokal tidssone.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Klient = pg.PoolClient;

export function lagPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Kjører fn i én transaksjon med app.bruker_id satt, slik at sporingskolonnene og endringsloggen
 * får riktig bruker. Alt som skriver til databasen skal gå gjennom denne.
 */
export async function iTransaksjon<T>(db: Db, brukerId: string | null, fn: (k: Klient) => Promise<T>): Promise<T> {
  const k = await db.connect();
  try {
    await k.query('begin');
    if (brukerId) await k.query(`select set_config('app.bruker_id', $1, true)`, [brukerId]);
    const res = await fn(k);
    await k.query('commit');
    return res;
  } catch (e) {
    await k.query('rollback');
    throw e;
  } finally {
    k.release();
  }
}

export async function en<T extends pg.QueryResultRow>(k: Klient | Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await k.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function alle<T extends pg.QueryResultRow>(k: Klient | Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await k.query<T>(sql, params);
  return r.rows;
}
