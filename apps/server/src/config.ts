import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(serverRot, '.env'));
} catch {
  // Ingen .env-fil: standardverdiene under brukes.
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/tilbud',
  port: Number(process.env.PORT ?? 3001),
  dokumentmappe: path.resolve(serverRot, process.env.DOKUMENTMAPPE ?? '../../data/dokumenter'),
  devBrukerEpost: process.env.DEV_BRUKER_EPOST ?? 'kalkulator@eksempel.no',
  migreringsmappe: path.join(serverRot, 'db', 'migrations'),
};
