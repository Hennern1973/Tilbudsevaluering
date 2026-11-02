import type { CellValueChangedEvent, ColDef, GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  belopParser,
  datoTekst,
  Feil,
  kr,
  norskGrid,
  Seksjon,
  STATUS_EVALUERING,
  STATUS_FAG,
  tema,
  useExcelUtklipp,
  useLast,
  utfor,
  valgEditor,
} from '../felles';

interface FagRad {
  id: string;
  nummer: string;
  navn: string;
  status: string;
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
  tilKalkyle: string | null;
  valgtUe: string | null;
  laveste: string | null;
}

interface Oversikt {
  prosjekt: { id: string; nummer: string; navn: string; byggherre: string | null; bta_m2: string | null; kontraktsform: string | null };
  fag: FagRad[];
  total: { ueKost: string; nokPerM2: string | null; antallFagIKalkyle: number };
  advarsler: string[];
}

interface Fagkapittel {
  id: string;
  nummer: string;
  navn: string;
}

/** Felt i grid → felt i API-et. */
const API_FELT: Record<string, string> = {
  status: 'status',
  mal: 'mal',
  he_anslag: 'heAnslag',
  inkludert_i_kalkyle: 'inkludertIKalkyle',
  neste_steg: 'nesteSteg',
  ansvarlig: 'ansvarlig',
  merknad: 'merknad',
};

export function ProsjektSide() {
  const { id } = useParams();
  const { data, feil, last, setFeil } = useLast<Oversikt>(() => api.get(`/prosjekter/${id}/oversikt`), [id]);
  const kapitler = useLast<Fagkapittel[]>(() => api.get('/fagkapitler'), []);
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const utklipp = useExcelUtklipp(gridApi);
  const [velgFag, setVelgFag] = useState(false);
  const [valgte, setValgte] = useState<Set<string>>(new Set());
  const [importSvar, setImportSvar] = useState<string | null>(null);

  const kolonner = useMemo<ColDef<FagRad>[]>(
    () => [
      {
        field: 'nummer',
        headerName: 'Kap.',
        width: 80,
        pinned: 'left',
        cellRenderer: (p: { data?: FagRad; value: string }) =>
          p.data?.id ? <Link to={`/fag/${p.data.id}`}>{p.value}</Link> : p.value,
      },
      { field: 'navn', headerName: 'Fag', width: 200, pinned: 'left' },
      { field: 'status', headerName: 'Status', width: 140, editable: (p) => !!p.data?.id, ...valgEditor(STATUS_FAG, false) },
      { field: 'mal', headerName: 'Mal', width: 70, editable: (p) => !!p.data?.id, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['', 'A', 'B', 'C', 'D'] } },
      {
        headerName: 'Mottatt',
        width: 90,
        valueGetter: (p) => (p.data?.id ? `${p.data.antall_mottatt} av ${p.data.antall_forespurt}` : ''),
      },
      {
        field: 'he_anslag',
        headerName: 'HE-anslag',
        width: 120,
        type: 'rightAligned',
        editable: (p) => !!p.data?.id,
        valueFormatter: (p) => kr(p.value),
        valueParser: belopParser,
        cellClass: (p) => (p.value ? 'forutsetning' : ''),
      },
      { field: 'valgtUe', headerName: 'Valgt UE', width: 170 },
      {
        field: 'tilKalkyle',
        headerName: 'Til kalkyle',
        width: 130,
        type: 'rightAligned',
        valueFormatter: (p) => kr(p.value),
      },
      {
        field: 'inkludert_i_kalkyle',
        headerName: 'I kalkyle',
        width: 90,
        editable: (p) => !!p.data?.id,
        cellDataType: 'boolean',
      },
      {
        headerName: 'Evaluering',
        width: 160,
        valueGetter: (p) => (p.data?.evaluering_status ? `Rev. ${p.data.revisjon}: ${STATUS_EVALUERING[p.data.evaluering_status] ?? p.data.evaluering_status}` : ''),
        cellRenderer: (p: { data?: FagRad; value: string }) =>
          p.data?.evaluering_id ? <Link to={`/evalueringer/${p.data.evaluering_id}`}>{p.value}</Link> : p.value,
      },
      {
        headerName: 'KS',
        width: 150,
        valueGetter: (p) => (p.data?.ks_tid ? `${p.data.ks_av ?? ''} ${datoTekst(p.data.ks_tid)}` : ''),
      },
      { field: 'neste_steg', headerName: 'Neste steg', width: 200, editable: (p) => !!p.data?.id },
      { field: 'ansvarlig', headerName: 'Ansvarlig', width: 120, editable: (p) => !!p.data?.id },
      { field: 'merknad', headerName: 'Merknad', flex: 1, minWidth: 160, editable: (p) => !!p.data?.id },
    ],
    [],
  );

  const totalRad = useMemo(
    () =>
      data
        ? [
            {
              nummer: '',
              navn: `Sum UE-kost (${data.total.antallFagIKalkyle} fag)`,
              tilKalkyle: data.total.ueKost,
              valgtUe: data.total.nokPerM2 ? `${kr(data.total.nokPerM2)} kr/m² BTA` : '',
            } as unknown as FagRad,
          ]
        : [],
    [data],
  );

  const endret = (e: CellValueChangedEvent<FagRad>) => {
    const felt = e.colDef.field;
    if (!felt || !e.data?.id || !API_FELT[felt]) return;
    let verdi: unknown = e.newValue;
    if (verdi === '') verdi = null;
    void utfor(() => api.send('PATCH', `/prosjekt-fag/${e.data!.id}`, { [API_FELT[felt]!]: verdi }), last, setFeil);
  };

  const iProsjekt = new Set(data?.fag.map((f) => f.nummer));
  const tilgjengelige = kapitler.data?.filter((k) => !iProsjekt.has(k.nummer)) ?? [];

  const leggTil = () =>
    utfor(
      () => api.send('POST', `/prosjekter/${id}/fag`, { fagkapittelIder: [...valgte] }),
      () => {
        setValgte(new Set());
        setVelgFag(false);
        return last();
      },
      setFeil,
    );

  const importer = async (filer: FileList | null) => {
    if (!filer?.length) return;
    try {
      const r = await api.lastOpp<{ lest: number; nye: number; endret: number; advarsler: string[] }>(
        '/fagkapitler/import',
        filer,
      );
      setImportSvar(
        `Leste ${r.lest} kapitler: ${r.nye} nye, ${r.endret} med endret navn.` +
          (r.advarsler.length ? ` Advarsler: ${r.advarsler.join(' ')}` : ''),
      );
      await kapitler.last();
    } catch (e) {
      setImportSvar((e as Error).message);
    }
  };

  if (!data) return <Feil melding={feil} />;
  const p = data.prosjekt;

  return (
    <>
      <div className="brodsmuler">
        <Link to="/">Prosjekter</Link> / {p.nummer}
      </div>
      <div className="sidehode">
        <div>
          <h1>
            {p.nummer} {p.navn}
          </h1>
          <div className="dempet">
            {[p.byggherre, p.kontraktsform, p.bta_m2 ? `BTA ${kr(p.bta_m2)} m²` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="nokkeltall" style={{ minWidth: 380 }}>
          <div>
            <span>Sum UE-kost i kalkyle</span>
            <b>{kr(data.total.ueKost)}</b>
          </div>
          <div>
            <span>kr/m² BTA</span>
            <b>{kr(data.total.nokPerM2)}</b>
          </div>
        </div>
      </div>
      <Feil melding={feil} lukk={() => setFeil(null)} />
      {data.advarsler.length > 0 && (
        <ul className="varsler">
          {data.advarsler.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}

      <Seksjon
        tittel="Oversikt fag"
        hoyre={
          <div className="knapper">
            <button onClick={() => setVelgFag((v) => !v)}>Legg til fag</button>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <span className="lenke" style={{ cursor: 'pointer', color: 'var(--aksent)' }}>
                Importer fagkapitler fra Excel …
              </span>
              <input type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }} onChange={(e) => void importer(e.target.files)} />
            </label>
          </div>
        }
      >
        {importSvar && <p className="dempet">{importSvar}</p>}
        {velgFag && (
          <div className="kort">
            <p className="dempet" style={{ marginTop: 0 }}>
              Velg fagkapitler som skal med i prosjektet. Standardmal hentes fra kapittelregisteret.
            </p>
            <div style={{ columns: '3 260px', maxHeight: 300, overflow: 'auto' }}>
              {tilgjengelige.map((k) => (
                <label key={k.id} style={{ flexDirection: 'row', gap: 6, color: 'var(--tekst)', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={valgte.has(k.id)}
                    onChange={(e) => {
                      const ny = new Set(valgte);
                      if (e.target.checked) ny.add(k.id);
                      else ny.delete(k.id);
                      setValgte(ny);
                    }}
                  />
                  {k.nummer} {k.navn}
                </label>
              ))}
            </div>
            <div className="knapper" style={{ marginTop: 8 }}>
              <button className="primar" disabled={valgte.size === 0} onClick={() => void leggTil()}>
                Legg til {valgte.size || ''}
              </button>
              <button onClick={() => setVelgFag(false)}>Avbryt</button>
            </div>
          </div>
        )}
        <div ref={utklipp} className="grid" style={{ height: Math.min(140 + data.fag.length * 30, 720) }}>
          <AgGridReact<FagRad>
            theme={tema}
            localeText={norskGrid}
            rowData={data.fag}
            columnDefs={kolonner}
            pinnedBottomRowData={totalRad}
            getRowId={(r) => r.data.id ?? 'total'}
            onGridReady={(e) => setGridApi(e.api)}
            onCellValueChanged={endret}
            singleClickEdit
            stopEditingWhenCellsLoseFocus
          />
        </div>
        <p className="dempet" style={{ fontSize: 12 }}>
          Dobbeltklikk eller skriv for å endre. Lim inn fra Excel med Ctrl+V. Sum UE-kost teller bare fag merket «I kalkyle», og
          bare underkapitlene når både hovedkapittel og underkapittel har beløp.
        </p>
      </Seksjon>
    </>
  );
}
