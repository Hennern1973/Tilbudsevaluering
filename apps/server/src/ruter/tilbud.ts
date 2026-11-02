import { etterFrist } from '@tilbud/beregning';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { alle, en, iTransaksjon, type Klient } from '../db.js';
import { IkkeFunnet, Konflikt } from '../evalueringsdata.js';
import type { LagretFil } from '../lagring.js';
import { belop, dato, kildefelt, kildeKolonner, sjekkKilde, tekst, tidspunkt, uuid } from '../skjema.js';
import { settDeler } from './prosjekt.js';

const foresporselStatus = z.enum(['forespurt', 'tilbud_mottatt', 'regner_ikke', 'ikke_svart']);

const tilbudSkjema = z
  .object({
    tilbudsnr: tekst.nullish(),
    tilbudsdato: dato.nullish(),
    mottattTid: tidspunkt.optional(),
    vedstaelsesfrist: dato.nullish(),
    tilbudssum: belop.nullish(),
  })
  .merge(kildefelt);

const prisfordelingSkjema = z.array(
  z
    .object({
      kode: tekst.nullish(),
      beskrivelse: tekst.min(1, 'Beskrivelse mangler'),
      belop,
    })
    .merge(kildefelt)
    .superRefine(sjekkKilde),
);

export async function tilbudRuter(app: FastifyInstance, { db, lagring }: Ctx) {
  app.post('/api/prosjekt-fag/:id/foresporsler', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ tilbyderId: uuid, datoForespurt: dato.nullish(), kommentar: tekst.nullish() }).parse(req.body);
    return iTransaksjon(db, req.bruker.id, (k) =>
      en(
        k,
        'insert into foresporsel (prosjekt_fag_id, tilbyder_id, dato_forespurt, kommentar) values ($1,$2,$3,$4) returning *',
        [id, b.tilbyderId, b.datoForespurt ?? null, b.kommentar ?? null],
      ),
    );
  });

  app.patch('/api/foresporsler/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ status: foresporselStatus.optional(), datoForespurt: dato.nullable().optional(), kommentar: tekst.nullable().optional() }).parse(req.body);
    const { sql, verdier } = settDeler(b, { status: 'status', datoForespurt: 'dato_forespurt', kommentar: 'kommentar' });
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const r = await en(k, `update foresporsel set ${sql || 'status = status'} where id = $1 returning *`, [id, ...verdier]);
      if (!r) throw new IkkeFunnet('Forespørselen finnes ikke');
      return r;
    });
  });

  /**
   * Registrerer et mottatt tilbud. Første tilbud blir versjon 1 og markeres automatisk «etter frist»
   * når det er mottatt etter fagets UE-frist. Et nytt tilbud på samme forespørsel blir en revidert versjon:
   * det arver «etter frist» fra versjon 1 og erstatter forrige versjon i åpne evalueringer.
   */
  app.post('/api/foresporsler/:id/tilbud', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = tilbudSkjema.superRefine(sjekkKilde).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const fo = await en<{ prosjekt_fag_id: string; ue_tilbudsfrist: Date | null }>(
        k,
        `select fo.prosjekt_fag_id, pf.ue_tilbudsfrist from foresporsel fo join prosjekt_fag pf on pf.id = fo.prosjekt_fag_id where fo.id = $1`,
        [id],
      );
      if (!fo) throw new IkkeFunnet('Forespørselen finnes ikke');
      const forrige = await en<{ id: string; versjon: number }>(
        k,
        'select id, versjon from tilbud where foresporsel_id = $1 order by versjon desc limit 1',
        [id],
      );
      const forste = await en<{ etter_frist: boolean }>(k, 'select etter_frist from tilbud where foresporsel_id = $1 and versjon = 1', [id]);
      const mottatt = b.mottattTid ? new Date(b.mottattTid) : new Date();
      const sent = forste ? forste.etter_frist : etterFrist(mottatt, fo.ue_tilbudsfrist);

      const t = await en<{ id: string }>(
        k,
        `insert into tilbud (foresporsel_id, versjon, erstatter_id, tilbudsnr, tilbudsdato, mottatt_tid, etter_frist, vedstaelsesfrist,
                             tilbudssum, kilde_type, kilde_dokument_id, kilde_ref, kilde_begrunnelse)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [id, (forrige?.versjon ?? 0) + 1, forrige?.id ?? null, b.tilbudsnr ?? null, b.tilbudsdato ?? null, mottatt, sent,
         b.vedstaelsesfrist ?? null, b.tilbudssum ?? null, ...kildeKolonner(b)],
      );
      await k.query(`update foresporsel set status = 'tilbud_mottatt' where id = $1 and status <> 'tilbud_mottatt'`, [id]);
      await k.query(`update prosjekt_fag set status = 'delvis_mottatt' where id = $1 and status = 'forespurt'`, [fo.prosjekt_fag_id]);
      await knyttTilApneEvalueringer(k, fo.prosjekt_fag_id, t!.id, forrige?.id ?? null);
      return t;
    });
  });

  app.patch('/api/tilbud/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = tilbudSkjema.partial().superRefine(sjekkKilde).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkTilbudApent(k, id);
      const { sql, verdier } = settDeler(b, {
        tilbudsnr: 'tilbudsnr',
        tilbudsdato: 'tilbudsdato',
        mottattTid: 'mottatt_tid',
        vedstaelsesfrist: 'vedstaelsesfrist',
        tilbudssum: 'tilbudssum',
        kildeType: 'kilde_type',
        kildeDokumentId: 'kilde_dokument_id',
        kildeRef: 'kilde_ref',
        kildeBegrunnelse: 'kilde_begrunnelse',
      });
      const r = await en(k, `update tilbud set ${sql || 'versjon = versjon'} where id = $1 returning *`, [id, ...verdier]);
      if (!r) throw new IkkeFunnet('Tilbudet finnes ikke');
      return r;
    });
  });

  app.get('/api/tilbud/:id/prisfordeling', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return alle(db, 'select * from tilbud_prisfordeling where tilbud_id = $1 order by rekkefolge', [id]);
  });

  app.put('/api/tilbud/:id/prisfordeling', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const linjer = prisfordelingSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkTilbudApent(k, id);
      await k.query('delete from tilbud_prisfordeling where tilbud_id = $1', [id]);
      for (const [i, l] of linjer.entries()) {
        await k.query(
          `insert into tilbud_prisfordeling (tilbud_id, kode, beskrivelse, belop, rekkefolge, kilde_type, kilde_dokument_id, kilde_ref, kilde_begrunnelse)
           values ($1,$2,$3,$4,$5,coalesce($6,'tilbud'),$7,$8,$9)`,
          [id, l.kode ?? null, l.beskrivelse, l.belop, i, ...kildeKolonner(l)],
        );
      }
      return alle(k, 'select * from tilbud_prisfordeling where tilbud_id = $1 order by rekkefolge', [id]);
    });
  });

  app.post('/api/tilbud/:id/dokumenter', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const info = await en<{ prosjekt_id: string; prosjektnr: string; kapittel: string; tilbyder: string }>(
      db,
      `select p.id as prosjekt_id, p.nummer as prosjektnr, f.nummer as kapittel, ty.firmanavn as tilbyder
         from tilbud t join foresporsel fo on fo.id = t.foresporsel_id join tilbyder ty on ty.id = fo.tilbyder_id
         join prosjekt_fag pf on pf.id = fo.prosjekt_fag_id join fagkapittel f on f.id = pf.fagkapittel_id
         join prosjekt p on p.id = pf.prosjekt_id where t.id = $1`,
      [id],
    );
    if (!info) throw new IkkeFunnet('Tilbudet finnes ikke');
    const lagret: { fil: { filename: string; mimetype: string }; l: LagretFil }[] = [];
    for await (const fil of req.files()) {
      const innhold = await fil.toBuffer();
      const l = await lagring.lagre({ prosjektnr: info.prosjektnr, kapittel: info.kapittel, tilbyder: info.tilbyder, filnavn: fil.filename, innhold });
      lagret.push({ fil, l });
    }
    if (lagret.length === 0) throw Object.assign(new Error('Ingen filer mottatt'), { statusCode: 400 });
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const ut = [];
      for (const { fil, l } of lagret) {
        ut.push(
          await en(
            k,
            `insert into dokument (prosjekt_id, tilbud_id, filnavn, filtype, storrelse_byte, sha256, lagringstype, lagringsnokkel, mappesti)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, filnavn, filtype, storrelse_byte`,
            [info.prosjekt_id, id, fil.filename, fil.mimetype, l.storrelse, l.sha256, l.lagringstype, l.lagringsnokkel, l.mappesti],
          ),
        );
      }
      return ut;
    });
  });

  app.get('/api/dokumenter/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = await en<{ filnavn: string; filtype: string | null; lagringsnokkel: string }>(
      db,
      'select filnavn, filtype, lagringsnokkel from dokument where id = $1',
      [id],
    );
    if (!d) throw new IkkeFunnet('Dokumentet finnes ikke');
    const innhold = await lagring.hent(d.lagringsnokkel);
    reply.header('content-type', d.filtype ?? 'application/octet-stream');
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(d.filnavn)}`);
    return reply.send(innhold);
  });
}

/** Et tilbud som brukes i en låst evaluering, kan ikke endres. */
async function sjekkTilbudApent(k: Klient, tilbudId: string) {
  const laast = await en(
    k,
    'select 1 from evaluering_tilbud et join evaluering e on e.id = et.evaluering_id where et.tilbud_id = $1 and e.laast',
    [tilbudId],
  );
  if (laast) throw new Konflikt('Tilbudet inngår i en KS-godkjent evaluering og kan ikke endres. Registrer et revidert tilbud i stedet.');
}

async function knyttTilApneEvalueringer(k: Klient, prosjektFagId: string, tilbudId: string, forrigeId: string | null) {
  if (forrigeId) {
    await k.query(
      `update evaluering_tilbud et set tilbud_id = $2 from evaluering e
        where e.id = et.evaluering_id and not e.laast and et.tilbud_id = $1`,
      [forrigeId, tilbudId],
    );
  } else {
    await k.query(
      `insert into evaluering_tilbud (evaluering_id, tilbud_id, rekkefolge)
       select e.id, $2, coalesce((select max(rekkefolge) + 1 from evaluering_tilbud where evaluering_id = e.id), 0)
         from evaluering e where e.prosjekt_fag_id = $1 and not e.laast
       on conflict do nothing`,
      [prosjektFagId, tilbudId],
    );
  }
}
