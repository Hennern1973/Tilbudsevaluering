import { D } from '@tilbud/beregning';
import type { CellValueChangedEvent, ColDef, GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  belopParser,
  datoTekst,
  Feil,
  Fargeforklaring,
  GRUPPE_OMFANG,
  KATEGORI_FORBEHOLD,
  KOMPLETTHET,
  kr,
  norskGrid,
  pst,
  Seksjon,
  STATUS_EVALUERING,
  STATUS_FORBEHOLD,
  STATUS_OMFANG,
  tema,
  tidTekst,
  tilApiBelop,
  useExcelUtklipp,
  useLast,
  utfor,
  valgEditor,
} from '../felles';

// --- Typer for svaret fra GET /api/evalueringer/:id ------------------------------

interface Justering {
  id: string;
  evaluering_tilbud_id: string;
  type: string;
  forutsetning_id: string | null;
  tilbudspost_id: string | null;
  overlapp_fag: string | null;
  fortegn: number;
  faktor: string;
  begrunnelse: string | null;
  grunnbelop: string | null;
  grunntekst: string | null;
  belop: string;
}

interface Tilbud {
  evaluering_tilbud_id: string;
  tilbud_id: string;
  med_i_evaluering: boolean;
  kompletthet: string | null;
  kompletthetsvurdering: string | null;
  tilbyder: string;
  versjon: number;
  tilbudsnr: string | null;
  mottatt_tid: string;
  etter_frist: boolean;
  vedstaelsesfrist: string | null;
  tilbudssum: string | null;
  kilde_type: string | null;
  kilde_dokument_id: string | null;
  kilde_ref: string | null;
  apneOmfangspunkter: number;
  dokumenter: { id: string; filnavn: string }[];
  prisfordeling: { id: string; kode: string | null; beskrivelse: string; belop: string; kilde_ref: string | null }[];
  justeringer: Justering[];
  resultat: {
    tilbudssum: string | null;
    sumJusteringer: string | null;
    evaluertSum: string | null;
    kontrolldifferanse: string | null;
    kontrollOk: boolean;
    rangering: number | null;
    diffMotLaveste: string | null;
    diffProsent: string | null;
    nokPerM2: string | null;
  };
}

interface Forutsetning {
  id: string;
  nr: number;
  tekst: string;
  mengde: string | null;
  enhet: string | null;
  enhetspris: string | null;
  belop: string;
  grunnlag: string;
}

interface Omfangspunkt {
  id: string;
  gruppe: string;
  tekst: string;
  rekkefolge: number;
}

interface Vurdering {
  evaluering_tilbud_id: string;
  omfangspunkt_id: string;
  status: string | null;
  kommentar: string | null;
}

interface Forbehold {
  id: string;
  tilbud_id: string | null;
  nr: number | null;
  type: string;
  tekst: string;
  kategori: string | null;
  konsekvens: string | null;
  status: number;
  vesentlig: boolean;
}

interface EvalueringData {
  evaluering: {
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
    endret_tid: string;
    fag_nummer: string;
    fag_navn: string;
    prosjekt_id: string;
    prosjekt_nummer: string;
    prosjekt_navn: string;
    bta_m2: string | null;
    ue_tilbudsfrist: string | null;
  };
  tilbud: Tilbud[];
  omfangspunkter: Omfangspunkt[];
  vurderinger: Vurdering[];
  forutsetninger: Forutsetning[];
  forbehold: Forbehold[];
  foresporsler: { id: string; tilbyder: string; status: string; kommentar: string | null }[];
  sammendrag: {
    laveste: { id: string; navn: string; evaluertSum: string | null } | null;
    antallEvaluert: number;
    valgt: { id: string; navn: string; tilbudssum: string | null; evaluertSum: string | null; erLaveste: boolean; valgtManuelt: boolean } | null;
    risikotillegg: string | null;
    tilKalkyle: string | null;
    tilKalkylePerM2: string | null;
    heAnslag: string | null;
    avvikHeAnslag: string | null;
    avvikHeAnslagProsent: string | null;
  };
  ferdigKontroll: { ok: boolean; avvik: { id: string; navn: string; grunn: string }[] };
  varsler: { tilbudId: string; type: string; tekst: string }[];
}

const TYPE_JUSTERING: Record<string, string> = {
  mangler: 'Mangler i tilbud',
  uavklart: 'Uavklart',
  forbehold: 'Forbehold',
  overlapp: 'Overlapp',
};

const TYPE_FORBEHOLD: Record<string, string> = {
  forbehold: 'Forbehold',
  forutsetning: 'Forutsetning',
  sporsmal: 'Spørsmål',
};

/** «1.0000» → «1», «0.5000» → «0,5». */
function faktorTekst(f: string | null | undefined): string {
  if (!f) return '';
  return new D(f).toString().replace('.', ',');
}

/** «0,5» → «0.5». Tom → null. Kaster ved ugyldig tall. */
function faktorFraTekst(t: string): string | null {
  const s = t.trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) throw new Error(`«${t}» er ikke en gyldig faktor. Bruk f.eks. 1 eller 0,5.`);
  return s;
}

export function EvalueringSide() {
  const { id } = useParams();
  const { data, feil, last, setFeil } = useLast<EvalueringData>(() => api.get(`/evalueringer/${id}`), [id]);
  const [visLogg, setVisLogg] = useState(false);

  if (!data) return <Feil melding={feil} />;
  const ev = data.evaluering;
  const laast = ev.laast;
  const navnFor = (tilbudId: string) => data.tilbud.find((t) => t.tilbud_id === tilbudId)?.tilbyder ?? '';

  const settStatus = (status: string) => utfor(() => api.send('POST', `/evalueringer/${ev.id}/status`, { status }), last, setFeil);

  const eksporter = () =>
    utfor(
      async () => {
        const r = await fetch(`/api/evalueringer/${ev.id}/eksport.xlsx`, { headers: hentBrukerHeader() });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.feil ?? `Eksport feilet (${r.status})`);
        const blob = await r.blob();
        const navn = decodeURIComponent((r.headers.get('content-disposition') ?? '').split("''")[1] ?? 'tilbudsevaluering.xlsx');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = navn;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      undefined,
      setFeil,
    );

  return (
    <>
      <div className="brodsmuler">
        <Link to="/">Prosjekter</Link> / <Link to={`/prosjekter/${ev.prosjekt_id}`}>{ev.prosjekt_nummer} {ev.prosjekt_navn}</Link> /{' '}
        <Link to={`/fag/${ev.prosjekt_fag_id}`}>
          {ev.fag_nummer} {ev.fag_navn}
        </Link>{' '}
        / Evaluering
      </div>
      <div className="sidehode">
        <div>
          <h1>
            {ev.fag_nummer} {ev.fag_navn}: tilbudsevaluering
          </h1>
          <div className="dempet">
            Mal {ev.mal} · Revisjon {ev.revisjon} · <b>{STATUS_EVALUERING[ev.status] ?? ev.status}</b>
            {laast && ' · låst etter KS'} · sist endret {tidTekst(ev.endret_tid)}
            {ev.ue_tilbudsfrist && ` · UE-frist ${tidTekst(ev.ue_tilbudsfrist)}`}
          </div>
        </div>
        <div className="knapper">
          {ev.status === 'under_evaluering' && (
            <button
              className="primar"
              disabled={laast || !data.ferdigKontroll.ok}
              title={data.ferdigKontroll.ok ? '' : 'Kontrollen går ikke opp. Se listen under.'}
              onClick={() => void settStatus('ferdig_evaluert')}
            >
              Sett ferdig evaluert
            </button>
          )}
          {ev.status === 'ferdig_evaluert' && !laast && <button onClick={() => void settStatus('under_evaluering')}>Gjenåpne</button>}
          <button onClick={() => void eksporter()}>Eksporter til Excel</button>
          <button className="lenke" onClick={() => setVisLogg((v) => !v)}>
            {visLogg ? 'Skjul historikk' : 'Historikk'}
          </button>
        </div>
      </div>
      <Feil melding={feil} lukk={() => setFeil(null)} />

      {!data.ferdigKontroll.ok && ev.status === 'under_evaluering' && (
        <div className="feil">
          Kan ikke settes ferdig evaluert ennå:
          <ul style={{ margin: '4px 0 0' }}>
            {data.ferdigKontroll.avvik.map((a, i) => (
              <li key={i}>
                {a.navn ? `${a.navn}: ` : ''}
                {a.grunn}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.varsler.length > 0 && (
        <Seksjon tittel={`Risikoflagg (${data.varsler.length})`}>
          <ul className="varsler">
            {data.varsler.map((v, i) => (
              <li key={i}>
                <b>{navnFor(v.tilbudId)}:</b> {v.tekst}
              </li>
            ))}
          </ul>
        </Seksjon>
      )}
      {visLogg && <Historikk evalueringId={ev.id} />}

      <Sammendrag data={data} laast={laast} etter={last} visFeil={setFeil} />
      <TilKalkyle data={data} laast={laast} etter={last} visFeil={setFeil} />
      <Forutsetninger data={data} laast={laast} etter={last} visFeil={setFeil} />
      <AlleJusteringer data={data} laast={laast} etter={last} visFeil={setFeil} />
      <Omfang data={data} laast={laast} etter={last} visFeil={setFeil} />
      <ForbeholdRegister data={data} etter={last} visFeil={setFeil} />
      <Anbefaling data={data} laast={laast} etter={last} visFeil={setFeil} />
    </>
  );
}

function hentBrukerHeader(): Record<string, string> {
  try {
    const e = localStorage.getItem('bruker-epost');
    return e ? { 'x-bruker-epost': e } : {};
  } catch {
    return {};
  }
}

interface DelProps {
  data: EvalueringData;
  laast: boolean;
  etter: () => Promise<void>;
  visFeil: (m: string) => void;
}

/** Felles AG Grid-oppsett med Excel-liming. */
function Grid<T>(props: {
  rader: T[];
  kolonner: ColDef<T>[];
  radId: (r: T) => string;
  endret?: (e: CellValueChangedEvent<T>) => void;
  hoyde?: number;
  bunnrader?: T[];
}) {
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const ref = useExcelUtklipp(gridApi);
  const hoyde = props.hoyde ?? Math.min(80 + (props.rader.length + (props.bunnrader?.length ?? 0)) * 30, 640);
  return (
    <div ref={ref} className="grid" style={{ height: hoyde }}>
      <AgGridReact<T>
        theme={tema}
        localeText={norskGrid}
        rowData={props.rader}
        columnDefs={props.kolonner}
        pinnedBottomRowData={props.bunnrader}
        getRowId={(p) => props.radId(p.data)}
        onGridReady={(e) => setGridApi(e.api)}
        onCellValueChanged={props.endret}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={300}
      />
    </div>
  );
}

// --- Sammendrag -----------------------------------------------------------------

function Sammendrag({ data, laast, etter, visFeil }: DelProps) {
  const kolonner = useMemo<ColDef<Tilbud>[]>(
    () => [
      { field: 'tilbyder', headerName: 'Tilbyder', width: 190, pinned: 'left' },
      {
        headerName: 'Versjon',
        width: 110,
        valueGetter: (p) => (p.data ? `v${p.data.versjon}${p.data.etter_frist ? ' (etter frist)' : ''}` : ''),
        cellClass: (p) => (p.data?.etter_frist ? 'kontrollavvik' : ''),
      },
      { field: 'med_i_evaluering', headerName: 'Med', width: 70, editable: !laast, cellDataType: 'boolean' },
      { field: 'kompletthet', headerName: 'Kompletthet', width: 150, editable: !laast, ...valgEditor(KOMPLETTHET) },
      {
        headerName: 'Tilbudssum',
        width: 130,
        type: 'rightAligned',
        valueGetter: (p) => p.data?.resultat.tilbudssum,
        valueFormatter: (p) => kr(p.value),
        cellClass: (p) => (p.data?.kilde_type === 'tilbud' ? 'fra-tilbud' : ''),
        tooltipValueGetter: (p) => {
          const t = p.data;
          const d = t?.dokumenter.find((x) => x.id === t.kilde_dokument_id);
          return d ? `Kilde: ${d.filnavn}, ${t?.kilde_ref}` : 'Ingen kilde';
        },
      },
      {
        headerName: 'Justeringer',
        width: 120,
        type: 'rightAligned',
        valueGetter: (p) => p.data?.resultat.sumJusteringer,
        valueFormatter: (p) => kr(p.value),
      },
      {
        headerName: 'Evaluert sum',
        width: 130,
        type: 'rightAligned',
        valueGetter: (p) => p.data?.resultat.evaluertSum,
        valueFormatter: (p) => kr(p.value),
        cellStyle: { fontWeight: 600 },
      },
      { headerName: 'Rang', width: 70, type: 'rightAligned', valueGetter: (p) => p.data?.resultat.rangering },
      {
        headerName: 'Diff. mot laveste',
        width: 140,
        type: 'rightAligned',
        valueGetter: (p) => p.data?.resultat.diffMotLaveste,
        valueFormatter: (p) => kr(p.value),
      },
      { headerName: 'Diff. %', width: 80, type: 'rightAligned', valueGetter: (p) => p.data?.resultat.diffProsent, valueFormatter: (p) => pst(p.value) },
      { headerName: 'kr/m² BTA', width: 100, type: 'rightAligned', valueGetter: (p) => p.data?.resultat.nokPerM2, valueFormatter: (p) => kr(p.value) },
      {
        headerName: 'Kontroll prisfordeling',
        width: 150,
        type: 'rightAligned',
        valueGetter: (p) => (p.data?.prisfordeling.length ? p.data.resultat.kontrolldifferanse : null),
        valueFormatter: (p) => (p.value === null ? 'ingen fordeling' : p.data?.resultat.kontrollOk ? 'OK' : kr(p.value)),
        cellClass: (p) => (p.data && !p.data.resultat.kontrollOk ? 'kontrollavvik' : 'ok-tekst'),
      },
      { field: 'apneOmfangspunkter', headerName: 'Åpne punkter', width: 110, type: 'rightAligned' },
      { headerName: 'Vedstår til', width: 110, valueGetter: (p) => datoTekst(p.data?.vedstaelsesfrist) },
      { field: 'kompletthetsvurdering', headerName: 'Kommentar kompletthet', flex: 1, minWidth: 200, editable: !laast },
    ],
    [laast],
  );

  const endret = (e: CellValueChangedEvent<Tilbud>) => {
    const felt = e.colDef.field;
    const kart: Record<string, string> = { med_i_evaluering: 'medIEvaluering', kompletthet: 'kompletthet', kompletthetsvurdering: 'kompletthetsvurdering' };
    if (!felt || !kart[felt] || !e.data) return;
    void utfor(() => api.send('PATCH', `/evaluering-tilbud/${e.data!.evaluering_tilbud_id}`, { [kart[felt]!]: e.newValue === '' ? null : e.newValue }), etter, visFeil);
  };

  const ikkeMed = data.foresporsler.filter((f) => !data.tilbud.some((t) => t.tilbyder === f.tilbyder));

  return (
    <Seksjon tittel="Sammendrag" hoyre={<Fargeforklaring />}>
      <Grid rader={data.tilbud} kolonner={kolonner} radId={(r) => r.evaluering_tilbud_id} endret={endret} />
      {ikkeMed.length > 0 && (
        <p className="dempet" style={{ fontSize: 12 }}>
          Uten tilbud: {ikkeMed.map((f) => `${f.tilbyder} (${f.status.replace('_', ' ')}${f.kommentar ? `: ${f.kommentar}` : ''})`).join(', ')}
        </p>
      )}
      <p className="dempet" style={{ fontSize: 12, marginBottom: 0 }}>
        Evaluert sum = tilbudssum + justeringer. Opsjoner er ikke med. Kontrollen sammenligner prisfordelingen med tilbudssummen, avrundet til hele kroner.
      </p>
    </Seksjon>
  );
}

// --- Til kalkyle ---------------------------------------------------------------

function TilKalkyle({ data, laast, etter, visFeil }: DelProps) {
  const ev = data.evaluering;
  const s = data.sammendrag;
  const rangerte = data.tilbud.filter((t) => t.resultat.rangering !== null);

  const lagre = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void utfor(
      () =>
        api.send('PATCH', `/evalueringer/${ev.id}`, {
          valgtTilbudId: String(f.get('valgt') ?? '') || null,
          risikotillegg: tilApiBelop(String(f.get('risiko') ?? '')) ?? '0',
          risikotilleggBegrunnelse: String(f.get('risikoBegrunnelse') ?? '').trim() || null,
        }),
      etter,
      visFeil,
    );
  };

  return (
    <Seksjon tittel="Til kalkyle">
      <div className="nokkeltall" style={{ marginBottom: 10 }}>
        <Tall tittel="Laveste evaluerte" verdi={s.laveste ? `${kr(s.laveste.evaluertSum)}` : '–'} under={s.laveste?.navn} />
        <Tall tittel="Valgt UE" verdi={s.valgt ? kr(s.valgt.evaluertSum) : '–'} under={s.valgt ? `${s.valgt.navn}${s.valgt.erLaveste ? ' (laveste)' : ' (ikke laveste)'}` : undefined} />
        <Tall tittel="Risikotillegg" verdi={kr(s.risikotillegg)} />
        <Tall tittel="Til kalkyle" verdi={kr(s.tilKalkyle)} under={s.tilKalkylePerM2 ? `${kr(s.tilKalkylePerM2)} kr/m² BTA` : undefined} />
        <Tall
          tittel="Mot HE-anslag"
          verdi={s.avvikHeAnslag ? kr(s.avvikHeAnslag) : '–'}
          under={s.heAnslag ? `anslag ${kr(s.heAnslag)} (${pst(s.avvikHeAnslagProsent)})` : 'ingen HE-anslag'}
        />
      </div>
      <form className="skjema" onSubmit={lagre} key={`${ev.valgt_tilbud_id}-${ev.risikotillegg}-${ev.risikotillegg_begrunnelse}`}>
        <label>
          Valgt UE
          <select name="valgt" defaultValue={ev.valgt_tilbud_id ?? ''} disabled={laast}>
            <option value="">Laveste evaluerte (standard)</option>
            {rangerte.map((t) => (
              <option key={t.tilbud_id} value={t.tilbud_id}>
                {t.tilbyder} ({kr(t.resultat.evaluertSum)})
              </option>
            ))}
          </select>
        </label>
        <label>
          Risikotillegg (kr)
          <input name="risiko" className="tall forutsetning" defaultValue={kr(ev.risikotillegg)} disabled={laast} inputMode="decimal" />
        </label>
        <label style={{ flex: 1, minWidth: 260 }}>
          Begrunnelse for risikotillegg
          <input name="risikoBegrunnelse" defaultValue={ev.risikotillegg_begrunnelse ?? ''} disabled={laast} />
        </label>
        <button disabled={laast}>Lagre</button>
      </form>
      <p className="dempet" style={{ fontSize: 12, marginBottom: 0 }}>
        Risikotillegget er det eneste tillatte avviket fra evaluert sum. Det krever begrunnelse og vises separat i eksporten.
      </p>
    </Seksjon>
  );
}

function Tall({ tittel, verdi, under }: { tittel: string; verdi: ReactNode; under?: string }) {
  return (
    <div>
      <span>{tittel}</span>
      <b>{verdi}</b>
      {under && <span>{under}</span>}
    </div>
  );
}

// --- Forutsetninger × tilbydere ------------------------------------------------------

type ForutsetningRad = Forutsetning & Record<string, unknown>;

function Forutsetninger({ data, laast, etter, visFeil }: DelProps) {
  const ev = data.evaluering;

  /** Justering for (tilbyder, forutsetning), hvis den finnes. */
  const finn = (etId: string, fId: string) => data.tilbud.find((t) => t.evaluering_tilbud_id === etId)?.justeringer.find((j) => j.forutsetning_id === fId);

  const rader = useMemo<ForutsetningRad[]>(
    () =>
      data.forutsetninger.map((f) => {
        const r: ForutsetningRad = { ...f };
        for (const t of data.tilbud) r[`t_${t.evaluering_tilbud_id}`] = faktorTekst(t.justeringer.find((j) => j.forutsetning_id === f.id)?.faktor);
        return r;
      }),
    [data],
  );

  const sumRad = useMemo(() => {
    const r: Record<string, unknown> = { id: 'sum', nr: '', tekst: 'Sum justeringer fra forutsetninger' };
    for (const t of data.tilbud) {
      r[`t_${t.evaluering_tilbud_id}`] = t.justeringer
        .filter((j) => j.forutsetning_id)
        .reduce((s, j) => s.plus(j.belop), new D(0))
        .toFixed(2);
    }
    return [r as ForutsetningRad];
  }, [data]);

  const kolonner = useMemo<ColDef<ForutsetningRad>[]>(
    () => [
      { field: 'nr', headerName: 'F', width: 60, pinned: 'left', valueFormatter: (p) => (p.value === '' ? '' : `F${p.value}`) },
      { field: 'tekst', headerName: 'Forutsetning', width: 260, pinned: 'left', editable: (p) => !laast && p.data?.id !== 'sum' },
      { field: 'mengde', headerName: 'Mengde', width: 90, type: 'rightAligned', editable: (p) => !laast && p.data?.id !== 'sum' },
      { field: 'enhet', headerName: 'Enhet', width: 70, editable: (p) => !laast && p.data?.id !== 'sum' },
      { field: 'enhetspris', headerName: 'Enh.pris', width: 100, type: 'rightAligned', editable: (p) => !laast && p.data?.id !== 'sum', valueFormatter: (p) => kr(p.value as string), valueParser: belopParser },
      {
        field: 'belop',
        headerName: 'Beløp',
        width: 120,
        type: 'rightAligned',
        editable: (p) => !laast && p.data?.id !== 'sum',
        valueFormatter: (p) => kr(p.value as string),
        valueParser: belopParser,
        cellClass: (p) => (p.data?.id === 'sum' ? '' : 'forutsetning'),
      },
      { field: 'grunnlag', headerName: 'Grunnlag / begrunnelse', width: 240, editable: (p) => !laast && p.data?.id !== 'sum', tooltipField: 'grunnlag' },
      ...data.tilbud
        .filter((t) => t.med_i_evaluering)
        .map<ColDef<ForutsetningRad>>((t) => ({
          field: `t_${t.evaluering_tilbud_id}`,
          headerName: t.tilbyder,
          headerTooltip: 'Faktor: tom = ikke med, 1 = hele beløpet legges til, 0,5 = halvparten. Annen faktor enn 1 krever begrunnelse.',
          width: 130,
          type: 'rightAligned',
          editable: (p) => !laast && p.data?.id !== 'sum',
          valueFormatter: (p) => (p.data?.id === 'sum' ? kr(p.value as string) : (p.value as string) ? `× ${p.value}` : ''),
          tooltipValueGetter: (p) => {
            if (!p.data || p.data.id === 'sum') return '';
            const j = finn(t.evaluering_tilbud_id, p.data.id);
            return j ? `${kr(j.belop)} kr${j.begrunnelse ? ` · ${j.begrunnelse}` : ''}` : '';
          },
        })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, laast],
  );

  const endret = (e: CellValueChangedEvent<ForutsetningRad>) => {
    const felt = e.colDef.field;
    const f = e.data;
    if (!felt || !f || f.id === 'sum') return;
    if (felt.startsWith('t_')) {
      const etId = felt.slice(2);
      const finnes = finn(etId, f.id);
      void utfor(
        async () => {
          const faktor = faktorFraTekst(String(e.newValue ?? ''));
          if (faktor === null) {
            if (finnes) await api.send('DELETE', `/justeringer/${finnes.id}`);
            return;
          }
          let begrunnelse = finnes?.begrunnelse ?? null;
          if (Number(faktor) !== 1 && !begrunnelse) {
            begrunnelse = prompt(`Begrunnelse for faktor ${faktor.replace('.', ',')} på F${f.nr} (påkrevd):`)?.trim() || null;
            if (!begrunnelse) throw new Error('Annen faktor enn 1 krever begrunnelse. Endringen er ikke lagret.');
          }
          if (finnes) await api.send('PATCH', `/justeringer/${finnes.id}`, { faktor, begrunnelse });
          else await api.send('POST', `/evaluering-tilbud/${etId}/justeringer`, { type: 'mangler', forutsetningId: f.id, faktor, begrunnelse });
        },
        etter,
        visFeil,
      );
      return;
    }
    const kart: Record<string, string> = { tekst: 'tekst', mengde: 'mengde', enhet: 'enhet', enhetspris: 'enhetspris', belop: 'belop', grunnlag: 'grunnlag' };
    if (!kart[felt]) return;
    let verdi = e.newValue as string | null;
    if (felt === 'mengde' && verdi) verdi = String(verdi).replace(/\s/g, '').replace(',', '.');
    void utfor(() => api.send('PATCH', `/forutsetninger/${f.id}`, { [kart[felt]!]: verdi === '' ? null : verdi }), etter, visFeil);
  };

  const nyForutsetning = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const skjema = e.currentTarget;
    const f = new FormData(skjema);
    void utfor(
      async () => {
        await api.send('POST', `/evalueringer/${ev.id}/forutsetninger`, {
          tekst: String(f.get('tekst') ?? ''),
          belop: tilApiBelop(String(f.get('belop') ?? '')) ?? '0',
          grunnlag: String(f.get('grunnlag') ?? ''),
        });
        skjema.reset();
      },
      etter,
      visFeil,
    );
  };

  const slett = (fId: string) => utfor(() => api.send('DELETE', `/forutsetninger/${fId}`), etter, visFeil);

  return (
    <Seksjon tittel="Kalkulatoriske forutsetninger (felles anslag)">
      <p className="dempet" style={{ fontSize: 12, marginTop: 0 }}>
        Ett anslag per forhold, brukt likt på alle tilbydere. Skriv faktor i tilbyderens kolonne for å legge det til (1 = hele beløpet). Tom celle fjerner
        justeringen. Det finnes ikke frie beløp: alt peker på en forutsetning eller en post i tilbudet.
      </p>
      {rader.length > 0 && <Grid rader={rader} kolonner={kolonner} radId={(r) => r.id} endret={endret} bunnrader={sumRad} />}
      {!laast && (
        <form className="skjema" onSubmit={nyForutsetning} style={{ marginTop: 8 }}>
          <label style={{ flex: 2, minWidth: 220 }}>
            Ny forutsetning
            <input name="tekst" required placeholder="f.eks. Snøfangere og takstiger" />
          </label>
          <label>
            Beløp (kr)
            <input name="belop" className="tall forutsetning" required inputMode="decimal" />
          </label>
          <label style={{ flex: 2, minWidth: 220 }}>
            Grunnlag / begrunnelse
            <input name="grunnlag" required placeholder="f.eks. snitt av to tilbud som har det med" />
          </label>
          <button>Legg til</button>
        </form>
      )}
      {!laast && data.forutsetninger.length > 0 && (
        <p style={{ fontSize: 12 }}>
          Slett:{' '}
          {data.forutsetninger.map((f) => (
            <button key={f.id} className="lenke fare" onClick={() => void slett(f.id)} title={f.tekst}>
              F{f.nr}
            </button>
          ))}
        </p>
      )}
    </Seksjon>
  );
}

// --- Alle justeringer (sporbarhet) -----------------------------------------------------

type JusteringRad = Justering & { tilbyder: string };

function AlleJusteringer({ data, laast, etter, visFeil }: DelProps) {
  const rader = useMemo<JusteringRad[]>(() => data.tilbud.flatMap((t) => t.justeringer.map((j) => ({ ...j, tilbyder: t.tilbyder }))), [data]);
  const fNr = (id: string | null) => data.forutsetninger.find((f) => f.id === id)?.nr;

  const kolonner = useMemo<ColDef<JusteringRad>[]>(
    () => [
      { field: 'tilbyder', headerName: 'Tilbyder', width: 180 },
      { field: 'type', headerName: 'Type', width: 140, editable: !laast, ...valgEditor(TYPE_JUSTERING, false) },
      {
        headerName: 'Grunnlag',
        flex: 1,
        minWidth: 240,
        valueGetter: (p) => (p.data ? (p.data.forutsetning_id ? `F${fNr(p.data.forutsetning_id)} ${p.data.grunntekst}` : `Post i tilbudet: ${p.data.grunntekst}`) : ''),
        cellClass: (p) => (p.data?.forutsetning_id ? 'forutsetning' : 'fra-tilbud'),
      },
      { field: 'grunnbelop', headerName: 'Grunnbeløp', width: 120, type: 'rightAligned', valueFormatter: (p) => kr(p.value) },
      { headerName: 'Faktor', width: 80, type: 'rightAligned', valueGetter: (p) => faktorTekst(p.data?.faktor) },
      { headerName: '±', width: 60, valueGetter: (p) => (p.data?.fortegn === -1 ? '−' : '+') },
      { field: 'belop', headerName: 'Beløp', width: 120, type: 'rightAligned', valueFormatter: (p) => kr(p.value), cellStyle: { fontWeight: 600 } },
      { field: 'overlapp_fag', headerName: 'Overlapp med', width: 150 },
      { field: 'begrunnelse', headerName: 'Begrunnelse', width: 240, editable: !laast },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, laast],
  );

  const endret = (e: CellValueChangedEvent<JusteringRad>) => {
    const felt = e.colDef.field;
    if ((felt !== 'type' && felt !== 'begrunnelse') || !e.data) return;
    void utfor(() => api.send('PATCH', `/justeringer/${e.data!.id}`, { [felt]: e.newValue === '' ? null : e.newValue }), etter, visFeil);
  };

  if (rader.length === 0) return null;
  return (
    <Seksjon tittel={`Alle justeringer (${rader.length})`}>
      <Grid rader={rader} kolonner={kolonner} radId={(r) => r.id} endret={endret} />
      <p className="dempet" style={{ fontSize: 12, marginBottom: 0 }}>
        Beløp = grunnbeløp × faktor × fortegn. Justeringer fra poster i tilbudet (f.eks. overlapp) vises her med blå farge.
      </p>
    </Seksjon>
  );
}

// --- Omfangssjekkliste ---------------------------------------------------------------------

type OmfangRad = Omfangspunkt & Record<string, unknown>;

function Omfang({ data, laast, etter, visFeil }: DelProps) {
  const ev = data.evaluering;
  const med = data.tilbud.filter((t) => t.med_i_evaluering);

  const rader = useMemo<OmfangRad[]>(
    () =>
      data.omfangspunkter.map((p) => {
        const r: OmfangRad = { ...p };
        for (const t of data.tilbud) {
          const v = data.vurderinger.find((x) => x.omfangspunkt_id === p.id && x.evaluering_tilbud_id === t.evaluering_tilbud_id);
          r[`t_${t.evaluering_tilbud_id}`] = v?.status ?? '';
          r[`k_${t.evaluering_tilbud_id}`] = v?.kommentar ?? '';
        }
        return r;
      }),
    [data],
  );

  const kolonner = useMemo<ColDef<OmfangRad>[]>(
    () => [
      { field: 'gruppe', headerName: 'Gruppe', width: 130, pinned: 'left', editable: !laast, ...valgEditor(GRUPPE_OMFANG, false) },
      { field: 'tekst', headerName: 'Punkt', width: 360, pinned: 'left', editable: !laast, tooltipField: 'tekst', wrapText: false },
      ...med.map<ColDef<OmfangRad>>((t) => ({
        field: `t_${t.evaluering_tilbud_id}`,
        headerName: t.tilbyder,
        width: 130,
        editable: !laast,
        ...valgEditor(STATUS_OMFANG),
        tooltipValueGetter: (p) => (p.data?.[`k_${t.evaluering_tilbud_id}`] as string) || '',
        cellClassRules: {
          'ok-tekst': (p) => p.value === 'inkl',
          kontrollavvik: (p) => ['ikke_inkl', 'avvik', 'forbehold', 'uavklart'].includes(p.value as string),
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, laast],
  );

  const endret = (e: CellValueChangedEvent<OmfangRad>) => {
    const felt = e.colDef.field;
    if (!felt || !e.data) return;
    if (felt.startsWith('t_')) {
      const etId = felt.slice(2);
      void utfor(
        () =>
          api.send('PUT', '/omfangsvurderinger', {
            evalueringTilbudId: etId,
            omfangspunktId: e.data!.id,
            status: e.newValue || null,
            kommentar: (e.data![`k_${etId}`] as string) || null,
          }),
        etter,
        visFeil,
      );
    } else if (felt === 'gruppe' || felt === 'tekst') {
      void utfor(() => api.send('PATCH', `/omfangspunkter/${e.data!.id}`, { [felt]: e.newValue }), etter, visFeil);
    }
  };

  const nyttPunkt = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const skjema = e.currentTarget;
    const f = new FormData(skjema);
    void utfor(
      async () => {
        await api.send('POST', `/evalueringer/${ev.id}/omfangspunkter`, { gruppe: f.get('gruppe'), tekst: String(f.get('tekst') ?? '') });
        skjema.reset();
      },
      etter,
      visFeil,
    );
  };

  return (
    <Seksjon tittel="Omfang og kompletthet">
      <p className="dempet" style={{ fontSize: 12, marginTop: 0 }}>
        Velg status per tilbyder. Et punkt som ikke er «Inkl.» eller «Ikke relevant» telles som åpent. Mangler som skal prises, legges inn som
        forutsetning over.
      </p>
      <Grid rader={rader} kolonner={kolonner} radId={(r) => r.id} endret={endret} hoyde={Math.min(80 + rader.length * 30, 560)} />
      {!laast && (
        <form className="skjema" onSubmit={nyttPunkt} style={{ marginTop: 8 }}>
          <label>
            Gruppe
            <select name="gruppe" defaultValue="hovedleveranse">
              {Object.entries(GRUPPE_OMFANG).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 260 }}>
            Nytt punkt
            <input name="tekst" required placeholder="f.eks. Taksluk og nedløp inkl. varmekabel" />
          </label>
          <button>Legg til</button>
        </form>
      )}
    </Seksjon>
  );
}

// --- Forbehold og avklaringer ---------------------------------------------------------------

function ForbeholdRegister({ data, etter, visFeil }: Omit<DelProps, 'laast'>) {
  const ev = data.evaluering;
  const tilbydere = Object.fromEntries(data.tilbud.map((t) => [t.tilbud_id, t.tilbyder]));

  const kolonner = useMemo<ColDef<Forbehold>[]>(
    () => [
      { field: 'nr', headerName: 'Nr.', width: 60 },
      { field: 'tilbud_id', headerName: 'Tilbyder', width: 170, editable: true, ...valgEditor(tilbydere) },
      { field: 'type', headerName: 'Type', width: 120, editable: true, ...valgEditor(TYPE_FORBEHOLD, false) },
      { field: 'tekst', headerName: 'Forbehold / spørsmål', flex: 1, minWidth: 260, editable: true, tooltipField: 'tekst' },
      { field: 'kategori', headerName: 'Kategori', width: 150, editable: true, ...valgEditor(KATEGORI_FORBEHOLD) },
      { field: 'konsekvens', headerName: 'Konsekvens', width: 200, editable: true },
      {
        field: 'status',
        headerName: 'Status',
        width: 140,
        editable: true,
        valueGetter: (p) => (p.data ? String(p.data.status) : ''),
        valueSetter: (p) => {
          if (!p.data || p.newValue === '' || p.newValue === null) return false;
          p.data.status = Number(p.newValue);
          return true;
        },
        ...valgEditor(STATUS_FORBEHOLD, false),
      },
      { field: 'vesentlig', headerName: 'Vesentlig', width: 90, editable: true, cellDataType: 'boolean' },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const endret = (e: CellValueChangedEvent<Forbehold>) => {
    const felt = e.colDef.field;
    const kart: Record<string, string> = { tilbud_id: 'tilbudId', type: 'type', tekst: 'tekst', kategori: 'kategori', konsekvens: 'konsekvens', status: 'status', vesentlig: 'vesentlig' };
    if (!felt || !kart[felt] || !e.data) return;
    const verdi = felt === 'status' ? e.data.status : e.newValue === '' ? null : e.newValue;
    void utfor(() => api.send('PATCH', `/forbehold/${e.data!.id}`, { [kart[felt]!]: verdi }), etter, visFeil);
  };

  const nytt = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const skjema = e.currentTarget;
    const f = new FormData(skjema);
    void utfor(
      async () => {
        await api.send('POST', `/prosjekt-fag/${ev.prosjekt_fag_id}/forbehold`, {
          tilbudId: String(f.get('tilbud') ?? '') || null,
          tekst: String(f.get('tekst') ?? ''),
          kategori: String(f.get('kategori') ?? '') || null,
          vesentlig: f.get('vesentlig') === 'on',
          status: 2,
        });
        skjema.reset();
      },
      etter,
      visFeil,
    );
  };

  return (
    <Seksjon tittel={`Forbehold og avklaringer (${data.forbehold.length})`}>
      <p className="dempet" style={{ fontSize: 12, marginTop: 0 }}>
        Status: 0 ikke aktuell · 1 OK/avklart · 2 ikke avklart · 3 ikke ivaretatt. Registeret gjelder faget og følger med til neste revisjon.
      </p>
      {data.forbehold.length > 0 && <Grid rader={data.forbehold} kolonner={kolonner} radId={(r) => r.id} endret={endret} />}
      <form className="skjema" onSubmit={nytt} style={{ marginTop: 8 }}>
        <label>
          Tilbyder
          <select name="tilbud" defaultValue="">
            <option value="">(alle / generelt)</option>
            {data.tilbud.map((t) => (
              <option key={t.tilbud_id} value={t.tilbud_id}>
                {t.tilbyder}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 260 }}>
          Forbehold / spørsmål
          <input name="tekst" required />
        </label>
        <label>
          Kategori
          <select name="kategori" defaultValue="">
            <option value="" />
            {Object.entries(KATEGORI_FORBEHOLD).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <input name="vesentlig" type="checkbox" /> Vesentlig
        </label>
        <button>Legg til</button>
      </form>
    </Seksjon>
  );
}

// --- Anbefaling ---------------------------------------------------------------------------

function Anbefaling({ data, laast, etter, visFeil }: DelProps) {
  const ev = data.evaluering;
  const lagre = (felt: 'anbefaling' | 'storsteRisikoer', verdi: string, gammel: string | null) => {
    if (verdi.trim() === (gammel ?? '')) return;
    void utfor(() => api.send('PATCH', `/evalueringer/${ev.id}`, { [felt]: verdi.trim() || null }), etter, visFeil);
  };
  return (
    <Seksjon tittel="Anbefaling">
      <div className="skjema" style={{ alignItems: 'stretch' }}>
        <label style={{ flex: 1, minWidth: 280 }}>
          Anbefaling (lagres når du går ut av feltet)
          <textarea defaultValue={ev.anbefaling ?? ''} disabled={laast} onBlur={(e) => lagre('anbefaling', e.target.value, ev.anbefaling)} rows={4} />
        </label>
        <label style={{ flex: 1, minWidth: 280 }}>
          Største risikoer
          <textarea defaultValue={ev.storste_risikoer ?? ''} disabled={laast} onBlur={(e) => lagre('storsteRisikoer', e.target.value, ev.storste_risikoer)} rows={4} />
        </label>
      </div>
    </Seksjon>
  );
}

// --- Historikk -------------------------------------------------------------------------------

interface Logg {
  id: number;
  tabell: string;
  rad_id: string;
  handling: string;
  felt: string | null;
  gammel: unknown;
  ny: unknown;
  tidspunkt: string;
  bruker: string | null;
}

function Historikk({ evalueringId }: { evalueringId: string }) {
  const { data, feil } = useLast<Logg[]>(
    async () => {
      const [ev, just, fu] = await Promise.all([
        api.get<Logg[]>(`/endringslogg?tabell=evaluering&radId=${evalueringId}`),
        api.get<Logg[]>('/endringslogg?tabell=justering&grense=200'),
        api.get<Logg[]>('/endringslogg?tabell=forutsetning&grense=200'),
      ]);
      return [...ev, ...just, ...fu].sort((a, b) => b.id - a.id).slice(0, 200);
    },
    [evalueringId],
  );
  const vis = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <Seksjon tittel="Historikk (endringslogg)">
      <Feil melding={feil} />
      <p className="dempet" style={{ fontSize: 12, marginTop: 0 }}>
        Alle endringer logges i databasen og kan ikke redigeres. Viser evalueringen og de siste endringene i justeringer og forutsetninger.
      </p>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <table className="enkel">
          <thead>
            <tr>
              <th>Tid</th>
              <th>Bruker</th>
              <th>Tabell</th>
              <th>Handling</th>
              <th>Felt</th>
              <th>Fra</th>
              <th>Til</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((l) => (
              <tr key={l.id}>
                <td>{tidTekst(l.tidspunkt)}</td>
                <td>{l.bruker}</td>
                <td>{l.tabell}</td>
                <td>{l.handling}</td>
                <td>{l.felt}</td>
                <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{vis(l.gammel)}</td>
                <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{vis(l.ny)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Seksjon>
  );
}
