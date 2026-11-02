import {
  type D,
  type Sammendrag,
  type TilbudResultat,
  evaluerMalB,
  finnVarsler,
  justeringsbelop,
  kanSettesFerdig,
  lagSammendrag,
} from '@tilbud/beregning';
import { alle, en, type Db, type Klient } from './db.js';

export class IkkeFunnet extends Error {
  statusCode = 404;
}
export class Konflikt extends Error {
  statusCode = 409;
}

const tekst2 = (d: D | null) => (d === null ? null : d.toFixed(2));
const tekst6 = (d: D | null) => (d === null ? null : d.toFixed(6));

export interface EvalueringRad {
  id: string;
  prosjekt_fag_id: string;
  revisjon: number;
  mal: string;
  status: string;
  laast: boolean;
  valgt_tilbud_id: string | null;
  risikotillegg: string;
  risikotillegg_begrunnelse: string | null;
  anbefaling: string | null;
  storste_risikoer: string | null;
  ks_tid: string | null;
  endret_tid: string;
  fag_nummer: string;
  fag_navn: string;
  he_anslag: string | null;
  prosjekt_id: string;
  prosjekt_nummer: string;
  prosjekt_navn: string;
  bta_m2: string | null;
  forventet_kontraktsdato: string | null;
  ue_tilbudsfrist: string | null;
}

/** Stopper endringer i en låst (KS-godkjent) evaluering. Endringer etter KS skal gi ny revisjon. */
export async function sjekkApen(k: Klient | Db, evalueringId: string): Promise<void> {
  const e = await en<{ laast: boolean }>(k, 'select laast from evaluering where id = $1', [evalueringId]);
  if (!e) throw new IkkeFunnet('Evalueringen finnes ikke');
  if (e.laast) throw new Konflikt('Evalueringen er låst etter KS-godkjenning. Lag en ny revisjon for å endre.');
}

export async function evalueringForEvalTilbud(k: Klient | Db, evalueringTilbudId: string): Promise<string> {
  const r = await en<{ evaluering_id: string }>(k, 'select evaluering_id from evaluering_tilbud where id = $1', [evalueringTilbudId]);
  if (!r) throw new IkkeFunnet('Tilbudet finnes ikke i evalueringen');
  return r.evaluering_id;
}

/** Henter alt som trengs for å vise og eksportere én evaluering, og regner ut resultatet. */
export async function hentEvaluering(db: Db | Klient, id: string) {
  const ev = await en<EvalueringRad>(
    db,
    `select e.id, e.prosjekt_fag_id, e.revisjon, e.mal, e.status, e.laast, e.valgt_tilbud_id, e.risikotillegg,
            e.risikotillegg_begrunnelse, e.anbefaling, e.storste_risikoer, e.ks_tid, e.endret_tid,
            f.nummer as fag_nummer, f.navn as fag_navn, pf.he_anslag, pf.ue_tilbudsfrist,
            p.id as prosjekt_id, p.nummer as prosjekt_nummer, p.navn as prosjekt_navn, p.bta_m2, p.forventet_kontraktsdato
       from evaluering e
       join prosjekt_fag pf on pf.id = e.prosjekt_fag_id
       join fagkapittel f on f.id = pf.fagkapittel_id
       join prosjekt p on p.id = pf.prosjekt_id
      where e.id = $1`,
    [id],
  );
  if (!ev) throw new IkkeFunnet('Evalueringen finnes ikke');

  const tilbud = await alle<{
    evaluering_tilbud_id: string;
    tilbud_id: string;
    med_i_evaluering: boolean;
    kompletthet: 'komplett' | 'mindre_mangler' | 'vesentlige_mangler' | null;
    kompletthetsvurdering: string | null;
    tilbyder_id: string;
    tilbyder: string;
    versjon: number;
    tilbudsnr: string | null;
    tilbudsdato: string | null;
    mottatt_tid: string | Date;
    etter_frist: boolean;
    vedstaelsesfrist: string | null;
    tilbudssum: string | null;
    kilde_type: string | null;
    kilde_dokument_id: string | null;
    kilde_ref: string | null;
    kilde_begrunnelse: string | null;
  }>(
    db,
    `select et.id as evaluering_tilbud_id, t.id as tilbud_id, et.med_i_evaluering, et.kompletthet, et.kompletthetsvurdering,
            ty.id as tilbyder_id, ty.firmanavn as tilbyder, t.versjon, t.tilbudsnr, t.tilbudsdato, t.mottatt_tid,
            t.etter_frist, t.vedstaelsesfrist, t.tilbudssum, t.kilde_type, t.kilde_dokument_id, t.kilde_ref, t.kilde_begrunnelse
       from evaluering_tilbud et
       join tilbud t on t.id = et.tilbud_id
       join foresporsel fo on fo.id = t.foresporsel_id
       join tilbyder ty on ty.id = fo.tilbyder_id
      where et.evaluering_id = $1
      order by et.rekkefolge, ty.firmanavn`,
    [id],
  );
  const tilbudIder = tilbud.map((t) => t.tilbud_id);

  const justeringer = await alle<{
    id: string;
    evaluering_tilbud_id: string;
    type: string;
    forutsetning_id: string | null;
    tilbudspost_id: string | null;
    omfangspunkt_id: string | null;
    overlapp_fag_id: string | null;
    overlapp_fag: string | null;
    fortegn: number;
    faktor: string;
    begrunnelse: string | null;
    grunnbelop: string | null;
    grunntekst: string | null;
  }>(
    db,
    `select j.id, j.evaluering_tilbud_id, j.type, j.forutsetning_id, j.tilbudspost_id, j.omfangspunkt_id, j.overlapp_fag_id,
            fk.nummer || ' ' || fk.navn as overlapp_fag, j.fortegn, j.faktor, j.begrunnelse,
            coalesce(fu.belop, tp.sum_tilbudt) as grunnbelop, coalesce(fu.tekst, tp.tekst) as grunntekst
       from justering j
       join evaluering_tilbud et on et.id = j.evaluering_tilbud_id
       left join forutsetning fu on fu.id = j.forutsetning_id
       left join tilbudspost tp on tp.id = j.tilbudspost_id
       left join fagkapittel fk on fk.id = j.overlapp_fag_id
      where et.evaluering_id = $1
      order by j.opprettet_tid`,
    [id],
  );

  const prisfordeling = await alle<{ id: string; tilbud_id: string; kode: string | null; beskrivelse: string; belop: string; kilde_ref: string | null; kilde_dokument_id: string | null }>(
    db,
    'select id, tilbud_id, kode, beskrivelse, belop, kilde_ref, kilde_dokument_id from tilbud_prisfordeling where tilbud_id = any($1) order by rekkefolge, kode',
    [tilbudIder],
  );

  const omfangspunkter = await alle<{ id: string; gruppe: string; tekst: string; krav_id: string | null; rekkefolge: number }>(
    db,
    'select id, gruppe, tekst, krav_id, rekkefolge from omfangspunkt where evaluering_id = $1 order by rekkefolge, opprettet_tid',
    [id],
  );
  const vurderinger = await alle<{
    id: string;
    evaluering_tilbud_id: string;
    omfangspunkt_id: string;
    status: string | null;
    kommentar: string | null;
    kilde_type: string | null;
    kilde_dokument_id: string | null;
    kilde_ref: string | null;
    kilde_begrunnelse: string | null;
  }>(
    db,
    `select v.id, v.evaluering_tilbud_id, v.omfangspunkt_id, v.status, v.kommentar, v.kilde_type, v.kilde_dokument_id, v.kilde_ref, v.kilde_begrunnelse
       from omfangsvurdering v join evaluering_tilbud et on et.id = v.evaluering_tilbud_id
      where et.evaluering_id = $1`,
    [id],
  );

  const forutsetninger = await alle<{ id: string; nr: number; tekst: string; mengde: string | null; enhet: string | null; enhetspris: string | null; belop: string; grunnlag: string }>(
    db,
    'select id, nr, tekst, mengde, enhet, enhetspris, belop, grunnlag from forutsetning where evaluering_id = $1 order by nr',
    [id],
  );

  const forbehold = await alle<{
    id: string;
    tilbud_id: string | null;
    nr: number | null;
    type: string;
    tekst: string;
    kategori: string | null;
    konsekvens: string | null;
    status: number;
    vesentlig: boolean;
    kilde_type: string | null;
    kilde_dokument_id: string | null;
    kilde_ref: string | null;
  }>(
    db,
    `select id, tilbud_id, nr, type, tekst, kategori, konsekvens, status, vesentlig, kilde_type, kilde_dokument_id, kilde_ref
       from forbehold where prosjekt_fag_id = $1 order by nr nulls last, opprettet_tid`,
    [ev.prosjekt_fag_id],
  );

  const dokumenter = await alle<{ id: string; tilbud_id: string; filnavn: string; filtype: string | null; storrelse_byte: string | null }>(
    db,
    'select id, tilbud_id, filnavn, filtype, storrelse_byte from dokument where tilbud_id = any($1) order by opprettet_tid',
    [tilbudIder],
  );

  const foresporsler = await alle<{ id: string; tilbyder: string; status: string; dato_forespurt: string | null; kommentar: string | null }>(
    db,
    `select fo.id, ty.firmanavn as tilbyder, fo.status, fo.dato_forespurt, fo.kommentar
       from foresporsel fo join tilbyder ty on ty.id = fo.tilbyder_id
      where fo.prosjekt_fag_id = $1 order by ty.firmanavn`,
    [ev.prosjekt_fag_id],
  );

  // Beregning
  const resultater: TilbudResultat[] = evaluerMalB(
    tilbud.map((t) => ({
      id: t.tilbud_id,
      navn: t.tilbyder,
      medIEvaluering: t.med_i_evaluering,
      tilbudssum: t.tilbudssum,
      justeringer: justeringer
        .filter((j) => j.evaluering_tilbud_id === t.evaluering_tilbud_id)
        .map((j) => ({ grunnbelop: j.grunnbelop ?? '0', faktor: j.faktor, fortegn: j.fortegn === -1 ? -1 : 1 })),
      prisfordeling: prisfordeling.filter((p) => p.tilbud_id === t.tilbud_id).map((p) => p.belop),
    })),
    { bta: ev.bta_m2 },
  );
  const sammendrag: Sammendrag = lagSammendrag({
    resultater,
    valgtTilbudId: ev.valgt_tilbud_id,
    risikotillegg: ev.risikotillegg,
    heAnslag: ev.he_anslag,
    bta: ev.bta_m2,
  });
  const ferdigKontroll = kanSettesFerdig(resultater);

  const apnePunkter = (evalTilbudId: string) =>
    omfangspunkter.filter((p) => {
      const v = vurderinger.find((x) => x.omfangspunkt_id === p.id && x.evaluering_tilbud_id === evalTilbudId);
      return p.gruppe !== 'opsjoner' && !(v?.status === 'inkl' || v?.status === 'ikke_relevant');
    }).length;

  const varsler = finnVarsler(
    resultater,
    tilbud
      .filter((t) => t.med_i_evaluering)
      .map((t) => ({
        id: t.tilbud_id,
        etterFrist: t.etter_frist,
        vedstaelsesfrist: t.vedstaelsesfrist ? new Date(t.vedstaelsesfrist) : null,
        apneOmfangspunkter: apnePunkter(t.evaluering_tilbud_id),
        kompletthet: t.kompletthet,
        forbeholdKategorier: forbehold.filter((f) => f.tilbud_id === t.tilbud_id && f.kategori).map((f) => f.kategori!),
      })),
    { forventetKontraktsdato: ev.forventet_kontraktsdato ? new Date(ev.forventet_kontraktsdato) : null },
  );

  return {
    evaluering: ev,
    tilbud: tilbud.map((t) => {
      const r = resultater.find((x) => x.id === t.tilbud_id)!;
      return {
        ...t,
        apneOmfangspunkter: apnePunkter(t.evaluering_tilbud_id),
        dokumenter: dokumenter.filter((d) => d.tilbud_id === t.tilbud_id),
        prisfordeling: prisfordeling.filter((p) => p.tilbud_id === t.tilbud_id),
        justeringer: justeringer
          .filter((j) => j.evaluering_tilbud_id === t.evaluering_tilbud_id)
          .map((j) => ({
            ...j,
            belop: justeringsbelop({ grunnbelop: j.grunnbelop ?? '0', faktor: j.faktor, fortegn: j.fortegn === -1 ? -1 : 1 }).toFixed(2),
          })),
        resultat: {
          tilbudssum: tekst2(r.tilbudssum),
          sumJusteringer: tekst2(r.sumJusteringer),
          sumTillegg: tekst2(r.sumTillegg),
          evaluertSum: tekst2(r.evaluertSum),
          kontrolldifferanse: tekst2(r.kontrolldifferanse),
          kontrollOk: r.kontrollOk,
          andelKalkTillegg: tekst6(r.andelKalkTillegg),
          rangering: r.rangering,
          diffMotLaveste: tekst2(r.diffMotLaveste),
          diffProsent: tekst6(r.diffProsent),
          nokPerM2: tekst2(r.nokPerM2),
        },
      };
    }),
    omfangspunkter,
    vurderinger,
    forutsetninger,
    forbehold,
    foresporsler,
    sammendrag: {
      laveste: sammendrag.laveste && { ...sammendrag.laveste, evaluertSum: tekst2(sammendrag.laveste.evaluertSum) },
      antallEvaluert: sammendrag.antallEvaluert,
      valgt: sammendrag.valgt && {
        ...sammendrag.valgt,
        tilbudssum: tekst2(sammendrag.valgt.tilbudssum),
        evaluertSum: tekst2(sammendrag.valgt.evaluertSum),
      },
      risikotillegg: tekst2(sammendrag.risikotillegg),
      tilKalkyle: tekst2(sammendrag.tilKalkyle),
      tilKalkylePerM2: tekst2(sammendrag.tilKalkylePerM2),
      heAnslag: tekst2(sammendrag.heAnslag),
      avvikHeAnslag: tekst2(sammendrag.avvikHeAnslag),
      avvikHeAnslagProsent: tekst6(sammendrag.avvikHeAnslagProsent),
    },
    ferdigKontroll,
    varsler,
  };
}

export type EvalueringData = Awaited<ReturnType<typeof hentEvaluering>>;

/** Standard omfangssjekkliste for mal B (fra «Mal B - Totalunderentreprise», rad 10–29). */
export const STANDARD_OMFANG_MAL_B: { gruppe: string; tekst: string }[] = [
  { gruppe: 'generelt', tekst: 'Prosjektering / detaljprosjektering for egen leveranse, inkl. dokumentasjon av ytelser' },
  { gruppe: 'generelt', tekst: 'Rigg og drift, byggeplassledelse, byggemøter, fremdrift iht. HEs plan' },
  { gruppe: 'generelt', tekst: 'Igangkjøring, innregulering, merking, FDV og opplæring' },
  { gruppe: 'generelt', tekst: 'Prøvedrift 12 mnd etter overtakelse (iht. kontrakt / Del II)' },
  { gruppe: 'generelt', tekst: 'Kran, heising, lift/stillas for egne arbeider' },
  { gruppe: 'generelt', tekst: 'Container / avfallshåndtering og sortering' },
  { gruppe: 'generelt', tekst: 'Hjelpearbeider: hulltaking, kjerneboring, branntetting, lydtetting' },
  { gruppe: 'grensesnitt', tekst: 'Grensesnitt mot automatikk / SD (motorer, følere, trafoer, FO, buss/protokoll)' },
  { gruppe: 'grensesnitt', tekst: 'Grensesnitt mot elektro (kraftforsyning, brannalarmstyringer)' },
  { gruppe: 'grensesnitt', tekst: 'Grensesnitt mot andre fag (overlapp eller hull?)' },
  { gruppe: 'krav', tekst: 'Miljøkrav: utslippsfri byggeplass, materialkrav, dokumentasjon (EPD o.l.)' },
  { gruppe: 'krav', tekst: 'Seriøsitetskrav: lærlinger, andel faglærte, lønns- og arbeidsvilkår' },
  { gruppe: 'krav', tekst: 'Digitale verktøy / samhandling (Dalux, Lean, BIM-krav)' },
  { gruppe: 'krav', tekst: 'Vedståelse frem til kontrakt med BH + tillegg' },
  { gruppe: 'opsjoner', tekst: 'Opsjoner etterspurt i forespørselen (prises separat, ikke med i evaluert sum)' },
];
