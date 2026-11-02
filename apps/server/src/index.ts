import { byggApp } from './app.js';
import { config } from './config.js';
import { lagPool } from './db.js';
import { migrer } from './migrer.js';

const db = lagPool(config.databaseUrl);
await migrer(db);
const app = await byggApp({ db, logger: true, webmappe: config.webmappe });
await app.listen({ port: config.port, host: config.host });
