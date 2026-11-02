import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { en, iTransaksjon, type Klient } from '../db.js';
import { lagSammendragXlsx } from '../excel/sammendrag.js';
import {
  evalueringForEvalTilbud,
  hentEvaluering,
  IkkeFunnet,
  Konflikt,
  sjekkApen,
  STANDARD_OMFANG_MAL_B,
} from '../evalueringsdata.js';
import { belop, faktor, kildefelt, kildeKolonner, mengde, sjekkKilde, tekst, uuid } from '../skjema.js';
import { settDeler } from './prosjekt.js';

const idParam = z.object({ id: uuid });
const omfangGruppe = z.enum(['generelt', 'hovedleveranse', 'grensesnitt', 'krav', 'opsjoner']);
const omfangStatus = z.enum(['inkl', 'ikke_inkl', 'uavklart', 'forbehold', 'avvik', 'andre', 'overlapp', 'ikke_relevant']);
const justeringType = z.enum(['mangler', 'uavklart', 'forbehold', 'overlapp']);

const forutsetningSkjema = z.object({
  tekst: tekst.min(1, 'Tekst mangler'),
  belop,
  grunnlag: tekst.min(1, 'Grunnlag/begrunnelse er påkrevd for en kalkulatorisk forutsetning'),
  mengde: mengde.nullish(),
  enhet: tekst.nullish(),
  enhetspris: belop.nullish(),
  erfaringspostId: uuid.nullish(),
});

const justeringSkjema = z
  .object({
    type: justeringType,
    forutsetningId: uuid.nullish(),
    tilbudspostId: uuid.nullish(),
    omfangspunktId: uuid.nullish(),
    overlappFagId: uuid.nullish(),
    fortegn: z.union([z.literal(1), z.literal(-1)]).default(1),
    faktor: faktor.default('1'),
    begrunnelse: tekst.nullish(),
  })
  .superRefine((j, ctx) => {
    if (!j.forutsetningId === !j.tilbudspostId) {
      ctx.addIssue({ code: 'custom', message: 'En justering må peke på én forutsetning eller én post i tilbudet, ikke et fritt beløp' });
    }
    if (Number(j.faktor) !== 1 && !j.begrunnelse) {
      ctx.addIssue({ code: 'custom', message: 'Annen faktor enn 1,0 krever begrunnelse' });
    }
    if (j.type === 'overlapp' && !j.overlappFagId) {
      ctx.addIssue({ code: 'custom', message: 'Overlapp må angi hvilket fag det overlapper med' });
    }
  });

const forbeholdSkjema = z
  .object({
    tilbudId: uuid.nullish(),
    type: z.enum(['forbehold', 'forutsetning', 'sporsmal']).default('forbehold'),
    tekst: tekst.min(1, 'Tekst mangler'),
    kategori: z.enum(['detaljprosjektering', 'seriositet', 'fremdrift', 'pris', 'omfang', 'kontrakt', 'annet']).nullish(),
    konsekvens: tekst.nullish(),
    status: z.number().int().min(0).max(3).default(2),
    vesentlig: z.boolean().default(false),
  })
  .merge(kildefelt);

export async function evalueringRuter(app: FastifyInstance, { db }: Ctx) {
  /** Starter evaluering (revisjon 1) av et fag. Alle mottatte tilbud (siste versjon) tas med. */
  app.post('/api/prosjekt-fag/:id/evalueringer', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ mal: z.enum(['A', 'B', 'C']).default('B') }).parse(req.body ?? {});
    if (b.mal !== 'B') throw Object.assign(new Error('Bare mal B er tilgjengelig i denne versjonen. Mal A og C kommer i fase 3.'), { statusCode: 400 });
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const finnes = await en(k, 'select 1 from evaluering where prosjekt_fag_id = $1', [id]);
      if (finnes) throw new Konflikt('Faget har allerede en evaluering.');
      const e = await en<{ id: string }>(
        k,
        `insert into evaluering (prosjekt_fag_id, revisjon, mal) values ($1, 1, $2) returning id`,
        [id, b.mal],
      );
      await k.query(
        `insert into evaluering_tilbud (evaluering_id, tilbud_id, rekkefolge)
         select $1, t.id, row_number() over (order by ty.firmanavn) - 1
           from foresporsel fo
           join tilbyder ty on ty.id = fo.tilbyder_id
           join lateral (select id from tilbud where foresporsel_id = fo.id order by versjon desc limit 1) t on true
          where fo.prosjekt_fag_id = $2`,
        [e!.id, id],
      );
      for (const [i, p] of STANDARD_OMFANG_MAL_B.entries()) {
        await k.query('insert into omfangspunkt (evaluering_id, gruppe, tekst, rekkefolge) values ($1,$2,$3,$4)', [e!.id, p.gruppe, p.tekst, i * 10]);
      }
      await k.query(`update prosjekt_fag set status = 'under_evaluering', mal = coalesce(mal, $2) where id = $1`, [id, b.mal]);
      return e;
    });
  });

  app.get('/api/evalueringer/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return hentEvaluering(db, id);
  });

  app.patch('/api/evalueringer/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        valgtTilbudId: uuid.nullable().optional(),
        risikotillegg: belop.optional(),
        risikotilleggBegrunnelse: tekst.nullable().optional(),
        anbefaling: tekst.nullable().optional(),
        storsteRisikoer: tekst.nullable().optional(),
      })
      .parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, id);
      const { sql, verdier } = settDeler(b, {
        valgtTilbudId: 'valgt_tilbud_id',
        risikotillegg: 'risikotillegg',
        risikotilleggBegrunnelse: 'risikotillegg_begrunnelse',
        anbefaling: 'anbefaling',
        storsteRisikoer: 'storste_risikoer',
      });
      if (sql) await k.query(`update evaluering set ${sql} where id = $1`, [id, ...verdier]);
      return hentEvaluering(k, id);
    });
  });

  /** Statusendring. «Ferdig evaluert» blokkeres når kontrollen ikke går opp; et øyeblikksbilde lagres. */
  app.post('/api/evalueringer/:id/status', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ status: z.enum(['under_evaluering', 'ferdig_evaluert']) }).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, id);
      const d = await hentEvaluering(k, id);
      if (b.status === 'ferdig_evaluert') {
        if (!d.ferdigKontroll.ok) {
          throw new Konflikt(`Kan ikke settes til ferdig evaluert: ${d.ferdigKontroll.avvik.map((a) => (a.navn ? `${a.navn}: ` : '') + a.grunn).join('; ')}`);
        }
        await k.query(`insert into evaluering_resultat (evaluering_id, hendelse, resultat) values ($1, 'ferdig_evaluert', $2)`, [
          id,
          JSON.stringify({ tilbud: d.tilbud.map((t) => ({ tilbyder: t.tilbyder, ...t.resultat })), sammendrag: d.sammendrag }),
        ]);
        await k.query(`update prosjekt_fag set status = 'evaluert' where id = $1 and status in ('forespurt','delvis_mottatt','under_evaluering')`, [d.evaluering.prosjekt_fag_id]);
      }
      await k.query('update evaluering set status = $2 where id = $1', [id, b.status]);
      return hentEvaluering(k, id);
    });
  });

  app.patch('/api/evaluering-tilbud/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({
        medIEvaluering: z.boolean().optional(),
        kompletthet: z.enum(['komplett', 'mindre_mangler', 'vesentlige_mangler']).nullable().optional(),
        kompletthetsvurdering: tekst.nullable().optional(),
      })
      .parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const evId = await evalueringForEvalTilbud(k, id);
      await sjekkApen(k, evId);
      const { sql, verdier } = settDeler(b, {
        medIEvaluering: 'med_i_evaluering',
        kompletthet: 'kompletthet',
        kompletthetsvurdering: 'kompletthetsvurdering',
      });
      if (sql) await k.query(`update evaluering_tilbud set ${sql} where id = $1`, [id, ...verdier]);
      return { ok: true };
    });
  });

  // --- Omfangssjekkliste -----------------------------------------------------

  app.post('/api/evalueringer/:id/omfangspunkter', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ gruppe: omfangGruppe, tekst: tekst.min(1), kravId: uuid.nullish() }).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, id);
      return en(
        k,
        `insert into omfangspunkt (evaluering_id, gruppe, tekst, krav_id, rekkefolge)
         values ($1,$2,$3,$4,(select coalesce(max(rekkefolge), 0) + 10 from omfangspunkt where evaluering_id = $1)) returning *`,
        [id, b.gruppe, b.tekst, b.kravId ?? null],
      );
    });
  });

  app.patch('/api/omfangspunkter/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ gruppe: omfangGruppe.optional(), tekst: tekst.min(1).optional(), rekkefolge: z.number().int().optional() }).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'omfangspunkt', id));
      const { sql, verdier } = settDeler(b, { gruppe: 'gruppe', tekst: 'tekst', rekkefolge: 'rekkefolge' });
      return en(k, `update omfangspunkt set ${sql || 'tekst = tekst'} where id = $1 returning *`, [id, ...verdier]);
    });
  });

  app.delete('/api/omfangspunkter/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'omfangspunkt', id));
      await k.query('delete from omfangspunkt where id = $1', [id]);
      return { ok: true };
    });
  });

  app.put('/api/omfangsvurderinger', async (req) => {
    const b = z
      .object({ evalueringTilbudId: uuid, omfangspunktId: uuid, status: omfangStatus.nullable(), kommentar: tekst.nullish() })
      .merge(kildefelt)
      .superRefine(sjekkKilde)
      .parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringForEvalTilbud(k, b.evalueringTilbudId));
      return en(
        k,
        `insert into omfangsvurdering (evaluering_tilbud_id, omfangspunkt_id, status, kommentar, kilde_type, kilde_dokument_id, kilde_ref, kilde_begrunnelse)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (evaluering_tilbud_id, omfangspunkt_id) do update
           set status = excluded.status, kommentar = excluded.kommentar, kilde_type = excluded.kilde_type,
               kilde_dokument_id = excluded.kilde_dokument_id, kilde_ref = excluded.kilde_ref, kilde_begrunnelse = excluded.kilde_begrunnelse
         returning *`,
        [b.evalueringTilbudId, b.omfangspunktId, b.status, b.kommentar ?? null, ...kildeKolonner(b)],
      );
    });
  });

  // --- Forutsetninger (felles anslag) -----------------------------------------

  app.post('/api/evalueringer/:id/forutsetninger', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = forutsetningSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, id);
      return en(
        k,
        `insert into forutsetning (evaluering_id, nr, tekst, belop, grunnlag, mengde, enhet, enhetspris, erfaringspost_id)
         values ($1, (select coalesce(max(nr), 0) + 1 from forutsetning where evaluering_id = $1), $2,$3,$4,$5,$6,$7,$8) returning *`,
        [id, b.tekst, b.belop, b.grunnlag, b.mengde ?? null, b.enhet ?? null, b.enhetspris ?? null, b.erfaringspostId ?? null],
      );
    });
  });

  app.patch('/api/forutsetninger/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = forutsetningSkjema.partial().parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'forutsetning', id));
      const { sql, verdier } = settDeler(b, { tekst: 'tekst', belop: 'belop', grunnlag: 'grunnlag', mengde: 'mengde', enhet: 'enhet', enhetspris: 'enhetspris' });
      return en(k, `update forutsetning set ${sql || 'nr = nr'} where id = $1 returning *`, [id, ...verdier]);
    });
  });

  app.delete('/api/forutsetninger/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'forutsetning', id));
      const brukt = await en<{ n: number }>(k, 'select count(*)::int as n from justering where forutsetning_id = $1', [id]);
      if (brukt && brukt.n > 0) throw new Konflikt(`Forutsetningen brukes i ${brukt.n} justering(er). Fjern dem først.`);
      await k.query('delete from forutsetning where id = $1', [id]);
      return { ok: true };
    });
  });

  // --- Justeringer ------------------------------------------------------------

  app.post('/api/evaluering-tilbud/:id/justeringer', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = justeringSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const evId = await evalueringForEvalTilbud(k, id);
      await sjekkApen(k, evId);
      if (b.forutsetningId) {
        const f = await en(k, 'select 1 from forutsetning where id = $1 and evaluering_id = $2', [b.forutsetningId, evId]);
        if (!f) throw Object.assign(new Error('Forutsetningen hører ikke til denne evalueringen'), { statusCode: 400 });
      }
      return en(
        k,
        `insert into justering (evaluering_tilbud_id, type, forutsetning_id, tilbudspost_id, omfangspunkt_id, overlapp_fag_id, fortegn, faktor, begrunnelse)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [id, b.type, b.forutsetningId ?? null, b.tilbudspostId ?? null, b.omfangspunktId ?? null, b.overlappFagId ?? null, b.fortegn, b.faktor, b.begrunnelse ?? null],
      );
    });
  });

  app.patch('/api/justeringer/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ type: justeringType.optional(), fortegn: z.union([z.literal(1), z.literal(-1)]).optional(), faktor: faktor.optional(), begrunnelse: tekst.nullable().optional(), overlappFagId: uuid.nullable().optional() })
      .parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'justering', id));
      const { sql, verdier } = settDeler(b, { type: 'type', fortegn: 'fortegn', faktor: 'faktor', begrunnelse: 'begrunnelse', overlappFagId: 'overlapp_fag_id' });
      return en(k, `update justering set ${sql || 'type = type'} where id = $1 returning *`, [id, ...verdier]);
    });
  });

  app.delete('/api/justeringer/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await sjekkApen(k, await evalueringFra(k, 'justering', id));
      await k.query('delete from justering where id = $1', [id]);
      return { ok: true };
    });
  });

  // --- Forbehold og avklaringer (registeret) ------------------------------------

  app.post('/api/prosjekt-fag/:id/forbehold', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = forbeholdSkjema.superRefine(sjekkKilde).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const pf = await en<{ prosjekt_id: string }>(k, 'select prosjekt_id from prosjekt_fag where id = $1', [id]);
      if (!pf) throw new IkkeFunnet('Faget finnes ikke');
      return en(
        k,
        `insert into forbehold (prosjekt_id, prosjekt_fag_id, tilbud_id, nr, type, tekst, kategori, konsekvens, status, vesentlig,
                                kilde_type, kilde_dokument_id, kilde_ref, kilde_begrunnelse)
         values ($1,$2,$3,(select coalesce(max(nr), 0) + 1 from forbehold where prosjekt_id = $1),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [pf.prosjekt_id, id, b.tilbudId ?? null, b.type, b.tekst, b.kategori ?? null, b.konsekvens ?? null, b.status, b.vesentlig, ...kildeKolonner(b)],
      );
    });
  });

  app.patch('/api/forbehold/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = forbeholdSkjema.partial().superRefine(sjekkKilde).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const { sql, verdier } = settDeler(b, {
        tilbudId: 'tilbud_id', type: 'type', tekst: 'tekst', kategori: 'kategori', konsekvens: 'konsekvens', status: 'status',
        vesentlig: 'vesentlig', kildeType: 'kilde_type', kildeDokumentId: 'kilde_dokument_id', kildeRef: 'kilde_ref', kildeBegrunnelse: 'kilde_begrunnelse',
      });
      const r = await en(k, `update forbehold set ${sql || 'tekst = tekst'} where id = $1 returning *`, [id, ...verdier]);
      if (!r) throw new IkkeFunnet('Forbeholdet finnes ikke');
      return r;
    });
  });

  app.delete('/api/forbehold/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      await k.query('delete from forbehold where id = $1', [id]);
      return { ok: true };
    });
  });

  // --- Eksport ----------------------------------------------------------------------

  app.get('/api/evalueringer/:id/eksport.xlsx', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const d = await hentEvaluering(db, id);
    const fil = await lagSammendragXlsx(d);
    const navn = `${d.evaluering.fag_nummer} ${d.evaluering.fag_navn} - Tilbudsevaluering - ${d.evaluering.prosjekt_nummer}.xlsx`;
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(navn)}`);
    return reply.send(fil);
  });
}

/** Finner evalueringen en rad hører til, for låsesjekk. */
async function evalueringFra(k: Klient, tabell: 'omfangspunkt' | 'forutsetning' | 'justering', id: string): Promise<string> {
  const sql =
    tabell === 'justering'
      ? 'select et.evaluering_id from justering j join evaluering_tilbud et on et.id = j.evaluering_tilbud_id where j.id = $1'
      : `select evaluering_id from ${tabell} where id = $1`;
  const r = await en<{ evaluering_id: string }>(k, sql, [id]);
  if (!r) throw new IkkeFunnet('Raden finnes ikke');
  return r.evaluering_id;
}
