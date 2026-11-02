import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { type Autentisering, type Bruker, UtviklingsAuth } from './auth.js';
import { config } from './config.js';
import type { Db } from './db.js';
import { type DokumentLagring, LokalLagring } from './lagring.js';
import { evalueringRuter } from './ruter/evaluering.js';
import { grunndataRuter } from './ruter/grunndata.js';
import { prosjektRuter } from './ruter/prosjekt.js';
import { tilbudRuter } from './ruter/tilbud.js';

declare module 'fastify' {
  interface FastifyRequest {
    bruker: Bruker;
  }
}

export interface AppAvhengigheter {
  db: Db;
  auth?: Autentisering;
  lagring?: DokumentLagring;
  logger?: boolean;
}

export interface Ctx {
  db: Db;
  lagring: DokumentLagring;
}

/** Norske meldinger for databasefeil som brukeren kan rette selv. */
function databasefeil(e: { code?: string; constraint?: string; detail?: string }): string | null {
  switch (e.code) {
    case '23505':
      return 'Finnes fra før' + (e.detail ? `: ${e.detail}` : '.');
    case '23514':
      return 'Verdien bryter en regel i datamodellen (f.eks. mangler kilde eller begrunnelse)' + (e.constraint ? ` [${e.constraint}]` : '.');
    case '23503':
      return 'Raden henger sammen med andre data og kan ikke endres eller slettes slik.';
    case '22P02':
      return 'Ugyldig verdi.';
    default:
      return null;
  }
}

export async function byggApp(avh: AppAvhengigheter): Promise<FastifyInstance> {
  const app = Fastify({ logger: avh.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  const auth = avh.auth ?? new UtviklingsAuth(avh.db, config.devBrukerEpost);
  const ctx: Ctx = { db: avh.db, lagring: avh.lagring ?? new LokalLagring(config.dokumentmappe) };

  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 20 } });

  app.decorateRequest('bruker', null as unknown as Bruker);
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const bruker = await auth.hentBruker(req);
    if (!bruker) return reply.code(401).send({ feil: 'Ikke innlogget, eller brukeren finnes ikke.' });
    req.bruker = bruker;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ feil: err.issues.map((i) => i.message).join('. '), felt: err.issues.map((i) => i.path.join('.')) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ feil: (err as Error).message });
    const db = databasefeil(err as never);
    if (db) return reply.code(400).send({ feil: db });
    app.log.error(err);
    return reply.code(500).send({ feil: 'Uventet feil på serveren.' });
  });

  app.get('/api/meg', async (req) => req.bruker);

  await grunndataRuter(app, ctx);
  await prosjektRuter(app, ctx);
  await tilbudRuter(app, ctx);
  await evalueringRuter(app, ctx);
  return app;
}
