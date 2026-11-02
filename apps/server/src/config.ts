import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(serverRot, '.env'));
} catch {
  // Ingen .env-fil: standardverdiene under brukes.
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://tilbud:tilbud@localhost:5432/tilbud',
  port: Number(process.env.PORT ?? 3001),
  /** 127.0.0.1 = bare denne maskinen. 0.0.0.0 = også andre på nettverket (testserver). */
  host: process.env.HOST ?? '127.0.0.1',
  /** Ferdigbygd nettside (npm run build). Serveres av API-serveren når mappen finnes. */
  webmappe: path.resolve(serverRot, '../web/dist'),
  dokumentmappe: path.resolve(serverRot, process.env.DOKUMENTMAPPE ?? '../../data/dokumenter'),
  devBrukerEpost: process.env.DEV_BRUKER_EPOST ?? 'kalkulator@eksempel.no',
  migreringsmappe: path.join(serverRot, 'db', 'migrations'),
};
