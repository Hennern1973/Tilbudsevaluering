import { overordnetNummer } from '@tilbud/beregning';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { alle, en, iTransaksjon } from '../db.js';
import { lesFagkapitler } from '../excel/fagkapitler.js';
import { IkkeFunnet } from '../evalueringsdata.js';
import { tekst, uuid } from '../skjema.js';

const fagSkjema = z.object({
  nummer: tekst.regex(/^\d+(\.\d+)*$/, 'Kapittelnummer må være tall med punktum, f.eks. 05.1 eller 82.10'),
  navn: tekst.min(1, 'Navn mangler'),
  standardMal: z.enum(['A', 'B', 'C', 'D']).nullish(),
});

const tilbyderSkjema = z.object({
  firmanavn: tekst.min(1, 'Firmanavn mangler'),
  orgnr: tekst
    .transform((s) => s.replace(/\s/g, ''))
    .pipe(z.string().regex(/^\d{9}$/, 'Org.nr. må ha 9 siffer'))
    .nullish()
    .or(z.literal('').transform(() => null)),
  kontaktperson: tekst.nullish(),
  epost: tekst.nullish(),
  telefon: tekst.nullish(),
});

export async function grunndataRuter(app: FastifyInstance, { db }: Ctx) {
  app.get('/api/fagkapitler', async () =>
    alle(
      db,
      `select f.id, f.nummer, f.navn, f.standard_mal, f.aktiv, o.nummer as overordnet_nummer
         from fagkapittel f left join fagkapittel o on o.id = f.overordnet_id
        order by f.sorteringsnokkel, f.nummer`,
    ),
  );

  app.post('/api/fagkapitler', async (req) => {
    const b = fagSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const rad = await en(k, 'insert into fagkapittel (nummer, navn, standard_mal) values ($1, $2, $3) returning *', [
        b.nummer,
        b.navn,
        b.standardMal ?? null,
      ]);
      await koblOverordnet(k);
      return rad;
    });
  });

  /**
   * Import fra Excel (arket «Fagkapitler»). Eksisterende kapitler får oppdatert navn, nye legges til.
   * Ingenting slettes. Svaret forteller hva som ble gjort, med advarsler per rad.
   */
  app.post('/api/fagkapitler/import', async (req) => {
    const fil = await req.file();
    if (!fil) throw Object.assign(new Error('Ingen fil mottatt'), { statusCode: 400 });
    if (!/\.(xlsx|xlsm)$/i.test(fil.filename)) {
      throw Object.assign(new Error('Filen må være .xlsx eller .xlsm'), { statusCode: 400 });
    }
    let resultat;
    try {
      resultat = await lesFagkapitler(await fil.toBuffer());
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { statusCode: 400 });
    }
    return iTransaksjon(db, req.bruker.id, async (k) => {
      let nye = 0;
      let endret = 0;
      for (const f of resultat.fag) {
        const fra = await en<{ navn: string }>(k, 'select navn from fagkapittel where nummer = $1', [f.nummer]);
        if (!fra) {
          await k.query('insert into fagkapittel (nummer, navn) values ($1, $2)', [f.nummer, f.navn]);
          nye++;
        } else if (fra.navn !== f.navn) {
          await k.query('update fagkapittel set navn = $2 where nummer = $1', [f.nummer, f.navn]);
          endret++;
        }
      }
      await koblOverordnet(k);
      return { lest: resultat.fag.length, nye, endret, advarsler: resultat.advarsler };
    });
  });

  app.get('/api/tilbydere', async () =>
    alle(db, 'select id, firmanavn, orgnr, kontaktperson, epost, telefon from tilbyder order by firmanavn'),
  );

  app.post('/api/tilbydere', async (req) => {
    const b = tilbyderSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, (k) =>
      en(
        k,
        'insert into tilbyder (firmanavn, orgnr, kontaktperson, epost, telefon) values ($1,$2,$3,$4,$5) returning *',
        [b.firmanavn, b.orgnr ?? null, b.kontaktperson ?? null, b.epost ?? null, b.telefon ?? null],
      ),
    );
  });

  app.patch('/api/tilbydere/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = tilbyderSkjema.partial().parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const rad = await en(
        k,
        `update tilbyder set firmanavn = coalesce($2, firmanavn), orgnr = case when $7 then $3 else orgnr end,
                kontaktperson = coalesce($4, kontaktperson), epost = coalesce($5, epost), telefon = coalesce($6, telefon)
          where id = $1 returning *`,
        [id, b.firmanavn ?? null, b.orgnr ?? null, b.kontaktperson ?? null, b.epost ?? null, b.telefon ?? null, 'orgnr' in b],
      );
      if (!rad) throw new IkkeFunnet('Tilbyderen finnes ikke');
      return rad;
    });
  });

  app.get('/api/endringslogg', async (req) => {
    const q = z.object({ tabell: tekst.optional(), radId: tekst.optional(), grense: z.coerce.number().max(500).default(100) }).parse(req.query);
    return alle(
      db,
      `select l.id, l.tabell, l.rad_id, l.handling, l.felt, l.gammel, l.ny, l.tidspunkt, b.navn as bruker
         from endringslogg l left join bruker b on b.id = l.bruker_id
        where ($1::text is null or l.tabell = $1) and ($2::text is null or l.rad_id = $2)
        order by l.id desc limit $3`,
      [q.tabell ?? null, q.radId ?? null, q.grense],
    );
  });
}

/** Setter overordnet kapittel ut fra nummeret («05.1» → «05») der det overordnede finnes. */
async function koblOverordnet(k: import('../db.js').Klient) {
  const fag = await alle<{ id: string; nummer: string; overordnet_id: string | null }>(k, 'select id, nummer, overordnet_id from fagkapittel');
  const perNummer = new Map(fag.map((f) => [f.nummer, f.id]));
  for (const f of fag) {
    const o = overordnetNummer(f.nummer);
    const oid = o ? (perNummer.get(o) ?? null) : null;
    if (oid !== f.overordnet_id) await k.query('update fagkapittel set overordnet_id = $2 where id = $1', [f.id, oid]);
  }
}
