import type { FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { en } from './db.js';

export type Rolle = 'kalkulator' | 'sidemann' | 'leser';

export interface Bruker {
  id: string;
  navn: string;
  epost: string;
}

/**
 * Auth-laget. I v1 brukes UtviklingsAuth, som finner brukeren fra e-post i en header eller fra .env.
 * Entra ID kobles på ved å lage en klasse som validerer Bearer-tokenet (MSAL) og slår opp
 * brukeren på entra_objekt_id. Resten av appen ser bare dette grensesnittet.
 */
export interface Autentisering {
  hentBruker(req: FastifyRequest): Promise<Bruker | null>;
}

export class UtviklingsAuth implements Autentisering {
  constructor(
    private db: Db,
    private standardEpost: string,
  ) {}

  async hentBruker(req: FastifyRequest): Promise<Bruker | null> {
    const header = req.headers['x-bruker-epost'];
    const epost = (Array.isArray(header) ? header[0] : header) ?? this.standardEpost;
    return en<Bruker>(this.db, 'select id, navn, epost from bruker where epost = $1 and aktiv', [epost]);
  }
}
