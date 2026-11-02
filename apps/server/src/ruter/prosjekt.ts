import { D, sammenlignFagnummer } from '@tilbud/beregning';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { alle, en, iTransaksjon } from '../db.js';
import { hentEvaluering, IkkeFunnet } from '../evalueringsdata.js';
import { belop, dato, tekst, tidspunkt, uuid } from '../skjema.js';

const prosjektSkjema = z.object({
  nummer: tekst.min(1, 'Prosjektnummer mangler'),
  navn: tekst.min(1, 'Prosjektnavn mangler'),
  byggherre: tekst.nullish(),
  kontraktsform: z.enum(['NS 8407', 'NS 8405', 'annet']).nullish(),
  btaM2: z.string().regex(/^\d+(\.\d{1,2})?$/, 'BTA må være et positivt tall').nullish(),
  byggtype: tekst.nullish(),
  tilbudsfristBh: tidspunkt.nullish(),
  vedstaelseBhTil: dato.nullish(),
  forventetKontraktsdato: dato.nullish(),
  status: z.enum(['kalkulasjon', 'levert', 'vunnet', 'tapt', 'avsluttet']).optional(),
});

const fagStatus = z.enum(['ikke_aktuell', 'forespurt', 'delvis_mottatt', 'under_evaluering', 'evaluert', 'lagt_til_grunn', 'kontrahert']);

const prosjektFagSkjema = z.object({
  status: fagStatus.optional(),
  foresporres: z.boolean().optional(),
  mal: z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
  ueTilbudsfrist: tidspunkt.nullable().optional(),
  heAnslag: belop.nullable().optional(),
  heAnslagBegrunnelse: tekst.nullable().optional(),
  inkludertIKalkyle: z.boolean().optional(),
  nesteSteg: tekst.nullable().optional(),
  ansvarlig: tekst.nullable().optional(),
  merknad: tekst.nullable().optional(),
});

const KOLONNER: Record<string, string> = {
  nummer: 'nummer',
  navn: 'navn',
  byggherre: 'byggherre',
  kontraktsform: 'kontraktsform',
  btaM2: 'bta_m2',
  byggtype: 'byggtype',
  tilbudsfristBh: 'tilbudsfrist_bh',
  vedstaelseBhTil: 'vedstaelse_bh_til',
  forventetKontraktsdato: 'forventet_kontraktsdato',
  status: 'status',
  foresporres: 'foresporres',
  mal: 'mal',
  ueTilbudsfrist: 'ue_tilbudsfrist',
  heAnslag: 'he_anslag',
  heAnslagBegrunnelse: 'he_anslag_begrunnelse',
  inkludertIKalkyle: 'inkludert_i_kalkyle',
  nesteSteg: 'neste_steg',
  ansvarlig: 'ansvarlig',
  merknad: 'merknad',
};

/** Bygger «set a = $2, b = $3» for feltene som faktisk er sendt. */
export function settDeler(b: Record<string, unknown>, kolonner: Record<string, string>, start = 2) {
  const deler: string[] = [];
  const verdier: unknown[] = [];
  for (const [felt, verdi] of Object.entries(b)) {
    const kol = kolonner[felt];
    if (!kol || verdi === undefined) continue;
    verdier.push(verdi === '' ? null : verdi);
    deler.push(`${kol} = $${start + verdier.length - 1}`);
  }
  return { sql: deler.join(', '), verdier };
}

export async function prosjektRuter(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/api/prosjekter', async () =>
    alle(
      db,
      `select p.id, p.nummer, p.navn, p.byggherre, p.status, p.bta_m2, p.tilbudsfrist_bh,
              (select count(*) from prosjekt_fag pf where pf.prosjekt_id = p.id and pf.status <> 'ikke_aktuell')::int as antall_fag
         from prosjekt p order by p.nummer desc`,
    ),
  );

  app.post('/api/prosjekter', async (req) => {
    const b = prosjektSkjema.parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const p = await en<{ id: string }>(
        k,
        `insert into prosjekt (nummer, navn, byggherre, kontraktsform, bta_m2, byggtype, tilbudsfrist_bh, vedstaelse_bh_til, forventet_kontraktsdato)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [b.nummer, b.navn, b.byggherre ?? null, b.kontraktsform ?? null, b.btaM2 ?? null, b.byggtype ?? null,
         b.tilbudsfristBh ?? null, b.vedstaelseBhTil ?? null, b.forventetKontraktsdato ?? null],
      );
      await k.query(`insert into prosjekt_rolle (bruker_id, prosjekt_id, rolle) values ($1, $2, 'kalkulator')`, [req.bruker.id, p!.id]);
      return p;
    });
  });

  app.get('/api/prosjekter/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const p = await en(db, 'select * from prosjekt where id = $1', [id]);
    if (!p) throw new IkkeFunnet('Prosjektet finnes ikke');
    return p;
  });

  app.patch('/api/prosjekter/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = prosjektSkjema.partial().parse(req.body);
    const { sql, verdier } = settDeler(b, KOLONNER);
    if (!sql) return en(db, 'select * from prosjekt where id = $1', [id]);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const p = await en(k, `update prosjekt set ${sql} where id = $1 returning *`, [id, ...verdier]);
      if (!p) throw new IkkeFunnet('Prosjektet finnes ikke');
      return p;
    });
  });

  /** Legger fagkapitler til prosjektet. Fag som allerede er med, hoppes over. */
  app.post('/api/prosjekter/:id/fag', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ fagkapittelIder: z.array(uuid).min(1) }).parse(req.body);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const r = await k.query(
        `insert into prosjekt_fag (prosjekt_id, fagkapittel_id, mal)
         select $1, f.id, f.standard_mal from fagkapittel f where f.id = any($2)
         on conflict (prosjekt_id, fagkapittel_id) do nothing`,
        [id, b.fagkapittelIder],
      );
      return { lagtTil: r.rowCount };
    });
  });

  app.patch('/api/prosjekt-fag/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = prosjektFagSkjema.parse(req.body);
    const ekstra: Record<string, unknown> = {};
    if (b.heAnslag !== undefined) ekstra.heAnslagKildeType = b.heAnslag === null ? null : b.heAnslagBegrunnelse ? 'forutsetning' : 'beregnet';
    const { sql, verdier } = settDeler({ ...b, ...ekstra }, { ...KOLONNER, heAnslagKildeType: 'he_anslag_kilde_type' });
    if (!sql) return en(db, 'select * from prosjekt_fag where id = $1', [id]);
    return iTransaksjon(db, req.bruker.id, async (k) => {
      const r = await en(k, `update prosjekt_fag set ${sql} where id = $1 returning *`, [id, ...verdier]);
      if (!r) throw new IkkeFunnet('Faget finnes ikke i prosjektet');
      return r;
    });
  });

  /** Ett fag: foresporsler med tilbud (alle versjoner) og dokumenter, og evalueringene. */
  app.get('/api/prosjekt-fag/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const fag = await en<{ id: string; prosjekt_id: string }>(
      db,
      `select pf.*, f.nummer, f.navn, p.nummer as prosjekt_nummer, p.navn as prosjekt_navn
         from prosjekt_fag pf join fagkapittel f on f.id = pf.fagkapittel_id join prosjekt p on p.id = pf.prosjekt_id
        where pf.id = $1`,
      [id],
    );
    if (!fag) throw new IkkeFunnet('Faget finnes ikke i prosjektet');
    const foresporsler = await alle(
      db,
      `select fo.id, fo.status, fo.dato_forespurt, fo.kommentar, ty.id as tilbyder_id, ty.firmanavn, ty.orgnr, ty.kontaktperson,
              coalesce((select json_agg(json_build_object(
                  'id', t.id, 'versjon', t.versjon, 'tilbudsnr', t.tilbudsnr, 'tilbudsdato', t.tilbudsdato,
                  'mottatt_tid', t.mottatt_tid, 'etter_frist', t.etter_frist, 'vedstaelsesfrist', t.vedstaelsesfrist,
                  'tilbudssum', t.tilbudssum, 'kilde_type', t.kilde_type, 'kilde_dokument_id', t.kilde_dokument_id,
                  'kilde_ref', t.kilde_ref, 'kilde_begrunnelse', t.kilde_begrunnelse,
                  'dokumenter', coalesce((select json_agg(json_build_object('id', d.id, 'filnavn', d.filnavn, 'filtype', d.filtype,
                                          'storrelse_byte', d.storrelse_byte) order by d.opprettet_tid)
                                          from dokument d where d.tilbud_id = t.id), '[]'::json)
                ) order by t.versjon desc) from tilbud t where t.foresporsel_id = fo.id), '[]'::json) as tilbud
         from foresporsel fo join tilbyder ty on ty.id = fo.tilbyder_id
        where fo.prosjekt_fag_id = $1 order by ty.firmanavn`,
      [id],
    );
    const evalueringer = await alle(
      db,
      'select id, revisjon, mal, status, laast, ks_tid, endret_tid from evaluering where prosjekt_fag_id = $1 order by revisjon desc',
      [id],
    );
    return { fag, foresporsler, evalueringer };
  });

  /**
   * Prosjektoversikten (samlearket): én rad per fag, med tall fra siste evaluering.
   * Total UE-kost teller bare fag inkludert i kalkylen, og bare underkapitlene når både 05 og 05.1 har beløp.
   */
  app.get('/api/prosjekter/:id/oversikt', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const prosjekt = await en<{ id: string; bta_m2: string | null }>(db, 'select * from prosjekt where id = $1', [id]);
    if (!prosjekt) throw new IkkeFunnet('Prosjektet finnes ikke');

    const rader = await alle<{
      id: string;
      nummer: string;
      navn: string;
      status: string;
      foresporres: boolean;
      mal: string | null;
      he_anslag: string | null;
      inkludert_i_kalkyle: boolean;
      neste_steg: string | null;
      ansvarlig: string | null;
      merknad: string | null;
      antall_forespurt: number;
      antall_mottatt: number;
      evaluering_id: string | null;
      evaluering_status: string | null;
      revisjon: number | null;
      ks_tid: string | null;
      ks_av: string | null;
    }>(
      db,
      `select pf.id, f.nummer, f.navn, pf.status, pf.foresporres, pf.mal, pf.he_anslag, pf.inkludert_i_kalkyle,
              pf.neste_steg, pf.ansvarlig, pf.merknad,
              (select count(*) from foresporsel fo where fo.prosjekt_fag_id = pf.id)::int as antall_forespurt,
              (select count(distinct fo.id) from foresporsel fo join tilbud t on t.foresporsel_id = fo.id
                where fo.prosjekt_fag_id = pf.id)::int as antall_mottatt,
              e.id as evaluering_id, e.status as evaluering_status, e.revisjon, e.ks_tid, b.navn as ks_av
         from prosjekt_fag pf
         join fagkapittel f on f.id = pf.fagkapittel_id
         left join lateral (select * from evaluering e where e.prosjekt_fag_id = pf.id order by e.revisjon desc limit 1) e on true
         left join bruker b on b.id = e.ks_av
        where pf.prosjekt_id = $1`,
      [id],
    );
    rader.sort((a, b) => sammenlignFagnummer(a.nummer, b.nummer));

    const ut = [];
    for (const r of rader) {
      let tilKalkyle: string | null = null;
      let valgtUe: string | null = null;
      let laveste: string | null = null;
      if (r.evaluering_id) {
        const d = await hentEvaluering(db, r.evaluering_id);
        tilKalkyle = d.sammendrag.tilKalkyle;
        valgtUe = d.sammendrag.valgt?.navn ?? null;
        laveste = d.sammendrag.laveste?.navn ?? null;
      }
      ut.push({ ...r, tilKalkyle, valgtUe, laveste });
    }

    const medBelop = ut.filter((r) => r.inkludert_i_kalkyle && r.tilKalkyle !== null && r.status !== 'ikke_aktuell');
    const harUnderkapittel = (nr: string) => medBelop.some((x) => x.nummer.startsWith(nr + '.'));
    const tellende = medBelop.filter((r) => !harUnderkapittel(r.nummer));
    const dobbelt = medBelop.filter((r) => harUnderkapittel(r.nummer)).map((r) => r.nummer);
    const total = tellende.reduce((s, r) => s.plus(r.tilKalkyle!), new D(0));
    const bta = prosjekt.bta_m2 ? new D(prosjekt.bta_m2) : null;

    return {
      prosjekt,
      fag: ut,
      total: {
        ueKost: total.toFixed(2),
        nokPerM2: bta && !bta.isZero() ? total.dividedBy(bta).toFixed(2) : null,
        antallFagIKalkyle: tellende.length,
      },
      advarsler: dobbelt.map((nr) => `${nr} har beløp både på hovedkapittelet og underkapitler. Bare underkapitlene er talt med.`),
    };
  });
}
