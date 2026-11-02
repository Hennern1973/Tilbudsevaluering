import type { ColDef, GridApi } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { sum as summerTall } from '@tilbud/beregning';
import { api } from '../api';
import {
  belopParser,
  datoTekst,
  Feil,
  Fargeforklaring,
  kr,
  norskGrid,
  Seksjon,
  STATUS_EVALUERING,
  STATUS_FAG,
  STATUS_FORESPORSEL,
  tema,
  tidTekst,
  tilApiBelop,
  useExcelUtklipp,
  useLast,
  utfor,
} from '../felles';

interface Dokument {
  id: string;
  filnavn: string;
  filtype: string | null;
  storrelse_byte: string | null;
}

interface Tilbud {
  id: string;
  versjon: number;
  tilbudsnr: string | null;
  tilbudsdato: string | null;
  mottatt_tid: string;
  etter_frist: boolean;
  vedstaelsesfrist: string | null;
  tilbudssum: string | null;
  kilde_type: string | null;
  kilde_dokument_id: string | null;
  kilde_ref: string | null;
  kilde_begrunnelse: string | null;
  dokumenter: Dokument[];
}

interface Foresporsel {
  id: string;
  status: string;
  dato_forespurt: string | null;
  kommentar: string | null;
  tilbyder_id: string;
  firmanavn: string;
  orgnr: string | null;
  kontaktperson: string | null;
  tilbud: Tilbud[];
}

interface FagData {
  fag: {
    id: string;
    prosjekt_id: string;
    nummer: string;
    navn: string;
    status: string;
    mal: string | null;
    ue_tilbudsfrist: string | null;
    he_anslag: string | null;
    he_anslag_begrunnelse: string | null;
    prosjekt_nummer: string;
    prosjekt_navn: string;
  };
  foresporsler: Foresporsel[];
  evalueringer: { id: string; revisjon: number; mal: string; status: string; laast: boolean; endret_tid: string }[];
}

interface Tilbyder {
  id: string;
  firmanavn: string;
}

/** «2026-11-02T14:30» fra <input type="datetime-local"> → ISO med tidssone. */
function lokalTilIso(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** ISO → verdi for <input type="datetime-local"> i lokal tid. */
function isoTilLokal(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function FagSide() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, feil, last, setFeil } = useLast<FagData>(() => api.get(`/prosjekt-fag/${id}`), [id]);
  const tilbydere = useLast<Tilbyder[]>(() => api.get('/tilbydere'), []);

  if (!data) return <Feil melding={feil} />;
  const { fag, foresporsler, evalueringer } = data;
  const mottatt = foresporsler.filter((f) => f.tilbud.length > 0).length;

  const lagreFag = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const anslag = String(f.get('anslag') ?? '');
    void utfor(
      () =>
        api.send('PATCH', `/prosjekt-fag/${fag.id}`, {
          ueTilbudsfrist: lokalTilIso(String(f.get('frist') ?? '')),
          heAnslag: tilApiBelop(anslag),
          heAnslagBegrunnelse: String(f.get('begrunnelse') ?? '').trim() || null,
        }),
      last,
      setFeil,
    );
  };

  const startEvaluering = () =>
    utfor(async () => {
      const e = await api.send<{ id: string }>('POST', `/prosjekt-fag/${fag.id}/evalueringer`, { mal: 'B' });
      navigate(`/evalueringer/${e.id}`);
    }, undefined, setFeil);

  return (
    <>
      <div className="brodsmuler">
        <Link to="/">Prosjekter</Link> / <Link to={`/prosjekter/${fag.prosjekt_id}`}>{fag.prosjekt_nummer} {fag.prosjekt_navn}</Link> / {fag.nummer}
      </div>
      <div className="sidehode">
        <div>
          <h1>
            {fag.nummer} {fag.navn}
          </h1>
          <div className="dempet">
            {STATUS_FAG[fag.status] ?? fag.status} · Mal {fag.mal ?? '–'} · {mottatt} av {foresporsler.length} tilbud mottatt
          </div>
        </div>
        <div className="knapper">
          {evalueringer.map((e) => (
            <Link key={e.id} to={`/evalueringer/${e.id}`}>
              Evaluering rev. {e.revisjon} ({STATUS_EVALUERING[e.status] ?? e.status})
            </Link>
          ))}
          {evalueringer.length === 0 && (
            <button className="primar" disabled={mottatt === 0} onClick={() => void startEvaluering()} title={mottatt === 0 ? 'Registrer minst ett tilbud først' : ''}>
              Start evaluering (mal B)
            </button>
          )}
        </div>
      </div>
      <Feil melding={feil} lukk={() => setFeil(null)} />

      <Seksjon tittel="Faget">
        <form className="skjema" onSubmit={lagreFag} key={`${fag.ue_tilbudsfrist}-${fag.he_anslag}`}>
          <label>
            UE-tilbudsfrist
            <input name="frist" type="datetime-local" defaultValue={isoTilLokal(fag.ue_tilbudsfrist)} />
          </label>
          <label>
            HE-anslag (kr)
            <input name="anslag" className="tall forutsetning" defaultValue={kr(fag.he_anslag)} inputMode="decimal" />
          </label>
          <label style={{ flex: 1, minWidth: 240 }}>
            Grunnlag for anslaget
            <input name="begrunnelse" defaultValue={fag.he_anslag_begrunnelse ?? ''} placeholder="f.eks. erfaringstall 680 kr/m² tak" />
          </label>
          <button>Lagre</button>
        </form>
        <p className="dempet" style={{ fontSize: 12, marginBottom: 0 }}>
          Tilbud som registreres etter fristen merkes automatisk «etter frist». Et revidert tilbud arver merket fra første versjon.
        </p>
      </Seksjon>

      <Seksjon tittel="Forespørsler og tilbud" hoyre={<Fargeforklaring />}>
        {foresporsler.map((fo) => (
          <ForesporselKort key={fo.id} fo={fo} etter={last} visFeil={setFeil} />
        ))}
        <NyForesporsel fagId={fag.id} tilbydere={tilbydere.data ?? []} iBruk={new Set(foresporsler.map((f) => f.tilbyder_id))} etter={async () => { await tilbydere.last(); await last(); }} visFeil={setFeil} />
      </Seksjon>
    </>
  );
}

function NyForesporsel(props: { fagId: string; tilbydere: Tilbyder[]; iBruk: Set<string>; etter: () => Promise<void>; visFeil: (m: string) => void }) {
  const [valg, setValg] = useState('');
  const [nyttNavn, setNyttNavn] = useState('');
  const ledige = props.tilbydere.filter((t) => !props.iBruk.has(t.id));

  const send = (e: FormEvent) => {
    e.preventDefault();
    void utfor(
      async () => {
        let tilbyderId = valg;
        if (valg === 'ny') {
          const t = await api.send<{ id: string }>('POST', '/tilbydere', { firmanavn: nyttNavn });
          tilbyderId = t.id;
        }
        if (!tilbyderId) throw new Error('Velg en tilbyder');
        await api.send('POST', `/prosjekt-fag/${props.fagId}/foresporsler`, { tilbyderId, datoForespurt: new Date().toISOString().slice(0, 10) });
        setValg('');
        setNyttNavn('');
      },
      props.etter,
      props.visFeil,
    );
  };

  return (
    <form className="skjema kort" onSubmit={send}>
      <label>
        Forespør tilbyder
        <select value={valg} onChange={(e) => setValg(e.target.value)}>
          <option value="">Velg …</option>
          {ledige.map((t) => (
            <option key={t.id} value={t.id}>
              {t.firmanavn}
            </option>
          ))}
          <option value="ny">+ Ny tilbyder …</option>
        </select>
      </label>
      {valg === 'ny' && (
        <label>
          Firmanavn
          <input value={nyttNavn} onChange={(e) => setNyttNavn(e.target.value)} required />
        </label>
      )}
      <button disabled={!valg}>Legg til forespørsel</button>
    </form>
  );
}

function ForesporselKort({ fo, etter, visFeil }: { fo: Foresporsel; etter: () => Promise<void>; visFeil: (m: string) => void }) {
  const [registrer, setRegistrer] = useState(false);
  const [prisfordelingFor, setPrisfordelingFor] = useState<string | null>(null);
  const siste = fo.tilbud[0];

  const settStatus = (status: string) => void utfor(() => api.send('PATCH', `/foresporsler/${fo.id}`, { status }), etter, visFeil);

  return (
    <div className="kort">
      <div className="kort-hode">
        <div>
          <b>{fo.firmanavn}</b>{' '}
          <span className="dempet">
            {fo.orgnr ? `org.nr. ${fo.orgnr} · ` : ''}forespurt {datoTekst(fo.dato_forespurt)}
          </span>
          {fo.kommentar && <div className="dempet">{fo.kommentar}</div>}
        </div>
        <div className="knapper">
          <select value={fo.status} onChange={(e) => settStatus(e.target.value)} aria-label="Status for forespørselen">
            {Object.entries(STATUS_FORESPORSEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {fo.status !== 'regner_ikke' && (
            <button onClick={() => setRegistrer((v) => !v)}>{siste ? 'Registrer revidert tilbud' : 'Registrer tilbud'}</button>
          )}
        </div>
      </div>

      {fo.tilbud.length > 0 && (
        <table className="enkel" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Versjon</th>
              <th>Mottatt</th>
              <th>Tilbudsnr. / dato</th>
              <th>Vedstår til</th>
              <th className="tall">Tilbudssum</th>
              <th>Kilde</th>
              <th>Dokumenter</th>
            </tr>
          </thead>
          <tbody>
            {fo.tilbud.map((t, i) => (
              <TilbudRad
                key={t.id}
                t={t}
                gjeldende={i === 0}
                etter={etter}
                visFeil={visFeil}
                visPrisfordeling={() => setPrisfordelingFor(prisfordelingFor === t.id ? null : t.id)}
              />
            ))}
          </tbody>
        </table>
      )}
      {prisfordelingFor && (
        <PrisfordelingEditor tilbud={fo.tilbud.find((t) => t.id === prisfordelingFor)!} lukk={() => setPrisfordelingFor(null)} visFeil={visFeil} />
      )}
      {registrer && <RegistrerTilbud foresporselId={fo.id} revidert={!!siste} ferdig={() => { setRegistrer(false); return etter(); }} visFeil={visFeil} />}
    </div>
  );
}

function TilbudRad(props: { t: Tilbud; gjeldende: boolean; etter: () => Promise<void>; visFeil: (m: string) => void; visPrisfordeling: () => void }) {
  const { t } = props;
  const [redigerSum, setRedigerSum] = useState(false);
  const kildeDok = t.dokumenter.find((d) => d.id === t.kilde_dokument_id);

  const lastOpp = (filer: FileList | null) => {
    if (!filer?.length) return;
    void utfor(() => api.lastOpp(`/tilbud/${t.id}/dokumenter`, filer), props.etter, props.visFeil);
  };

  const lagreSum = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void utfor(
      async () => {
        const sum = tilApiBelop(String(f.get('sum') ?? ''));
        await api.send('PATCH', `/tilbud/${t.id}`, {
          tilbudssum: sum,
          kildeType: sum === null ? null : 'tilbud',
          kildeDokumentId: sum === null ? null : String(f.get('dok') ?? '') || null,
          kildeRef: sum === null ? null : String(f.get('side') ?? '').trim() || null,
        });
        setRedigerSum(false);
      },
      props.etter,
      props.visFeil,
    );
  };

  return (
    <>
      <tr style={props.gjeldende ? undefined : { color: 'var(--dempet)' }}>
        <td>
          v{t.versjon} {props.gjeldende ? '' : '(erstattet)'}
        </td>
        <td>
          {tidTekst(t.mottatt_tid)} {t.etter_frist && <span className="merke rod">etter frist</span>}
        </td>
        <td>
          {t.tilbudsnr ?? '–'} / {datoTekst(t.tilbudsdato) || '–'}
        </td>
        <td>{datoTekst(t.vedstaelsesfrist)}</td>
        <td className={`tall ${t.kilde_type === 'tilbud' ? 'fra-tilbud' : ''}`}>{t.tilbudssum ? kr(t.tilbudssum) : <span className="dempet">mangler</span>}</td>
        <td>
          {kildeDok ? (
            <a href={`/api/dokumenter/${kildeDok.id}`} target="_blank" rel="noreferrer">
              {kildeDok.filnavn}, {t.kilde_ref}
            </a>
          ) : (
            ''
          )}
          {props.gjeldende && (
            <>
              {' '}
              <button className="lenke" onClick={() => setRedigerSum((v) => !v)}>
                {t.tilbudssum ? 'endre' : 'registrer sum'}
              </button>
              <button className="lenke" onClick={props.visPrisfordeling}>
                prisfordeling
              </button>
            </>
          )}
        </td>
        <td>
          {t.dokumenter.map((d) => (
            <div key={d.id}>
              <a href={`/api/dokumenter/${d.id}`} target="_blank" rel="noreferrer">
                {d.filnavn}
              </a>
            </div>
          ))}
          {props.gjeldende && (
            <label style={{ display: 'inline' }}>
              <span style={{ color: 'var(--aksent)', cursor: 'pointer' }}>+ last opp</span>
              <input type="file" multiple style={{ display: 'none' }} onChange={(e) => lastOpp(e.target.files)} />
            </label>
          )}
        </td>
      </tr>
      {redigerSum && (
        <tr>
          <td colSpan={7}>
            {t.dokumenter.length === 0 ? (
              <span className="dempet">Last opp tilbudsbrevet først. Tilbudssummen skal peke på dokument og side.</span>
            ) : (
              <form className="skjema" onSubmit={lagreSum}>
                <label>
                  Tilbudssum fra tilbudsbrevet (kr)
                  <input name="sum" className="tall fra-tilbud" defaultValue={kr(t.tilbudssum)} inputMode="decimal" autoFocus />
                </label>
                <label>
                  Dokument
                  <select name="dok" defaultValue={t.kilde_dokument_id ?? t.dokumenter[0]?.id}>
                    {t.dokumenter.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.filnavn}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Side / ark
                  <input name="side" defaultValue={t.kilde_ref ?? ''} placeholder="s. 1" required />
                </label>
                <button className="primar">Lagre</button>
                <button type="button" onClick={() => setRedigerSum(false)}>
                  Avbryt
                </button>
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RegistrerTilbud(props: { foresporselId: string; revidert: boolean; ferdig: () => Promise<void>; visFeil: (m: string) => void }) {
  const [opptatt, setOpptatt] = useState(false);

  const send = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const filer = (e.currentTarget.elements.namedItem('filer') as HTMLInputElement).files;
    const tekst = (n: string) => String(f.get(n) ?? '').trim() || null;
    setOpptatt(true);
    try {
      const sum = tilApiBelop(String(f.get('sum') ?? ''));
      if (sum !== null && (!filer?.length || !tekst('side'))) {
        throw new Error('Tilbudssummen må ha kilde: last opp tilbudsbrevet og oppgi side.');
      }
      const t = await api.send<{ id: string }>('POST', `/foresporsler/${props.foresporselId}/tilbud`, {
        mottattTid: lokalTilIso(String(f.get('mottatt') ?? '')) ?? undefined,
        tilbudsnr: tekst('tilbudsnr'),
        tilbudsdato: tekst('tilbudsdato'),
        vedstaelsesfrist: tekst('vedstaelse'),
      });
      if (filer?.length) {
        const dok = await api.lastOpp<{ id: string }[]>(`/tilbud/${t.id}/dokumenter`, filer);
        if (sum !== null) {
          await api.send('PATCH', `/tilbud/${t.id}`, { tilbudssum: sum, kildeType: 'tilbud', kildeDokumentId: dok[0]!.id, kildeRef: tekst('side') });
        }
      }
      await props.ferdig();
    } catch (err) {
      props.visFeil((err as Error).message);
    } finally {
      setOpptatt(false);
    }
  };

  return (
    <form className="skjema" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--kant)' }} onSubmit={(e) => void send(e)}>
      <label>
        Mottatt
        <input name="mottatt" type="datetime-local" defaultValue={isoTilLokal(new Date().toISOString())} required />
      </label>
      <label>
        Tilbudsnr.
        <input name="tilbudsnr" />
      </label>
      <label>
        Tilbudsdato
        <input name="tilbudsdato" type="date" />
      </label>
      <label>
        Vedstår til
        <input name="vedstaelse" type="date" />
      </label>
      <label>
        Dokumenter (tilbudsbrev først)
        <input name="filer" type="file" multiple />
      </label>
      <label>
        Tilbudssum (kr)
        <input name="sum" className="tall fra-tilbud" inputMode="decimal" />
      </label>
      <label>
        Side i tilbudsbrevet
        <input name="side" placeholder="s. 1" />
      </label>
      <button className="primar" disabled={opptatt}>
        {props.revidert ? 'Lagre revidert tilbud' : 'Lagre tilbud'}
      </button>
      {props.revidert && (
        <span className="dempet" style={{ fontSize: 12 }}>
          Den nye versjonen erstatter den forrige i åpne evalueringer. Justeringer må vurderes på nytt.
        </span>
      )}
    </form>
  );
}

interface PrisRad {
  nr: number;
  kode: string;
  beskrivelse: string;
  belop: string | null;
  side: string;
}

/** Prisfordelingen fra tilbudet (kontrollgrunnlag). Kan limes inn fra Excel: kode, beskrivelse, beløp, side. */
function PrisfordelingEditor({ tilbud, lukk, visFeil }: { tilbud: Tilbud; lukk: () => void; visFeil: (m: string) => void }) {
  const lagret = useLast<{ kode: string | null; beskrivelse: string; belop: string; kilde_ref: string | null }[]>(
    () => api.get(`/tilbud/${tilbud.id}/prisfordeling`),
    [tilbud.id],
  );
  const [dok, setDok] = useState(tilbud.kilde_dokument_id ?? tilbud.dokumenter[0]?.id ?? '');
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  const utklipp = useExcelUtklipp(gridApi);

  const rader = useMemo<PrisRad[]>(() => {
    const fra = (lagret.data ?? []).map((l, i) => ({ nr: i, kode: l.kode ?? '', beskrivelse: l.beskrivelse, belop: l.belop, side: l.kilde_ref ?? '' }));
    const tomme = Array.from({ length: 12 }, (_, i) => ({ nr: fra.length + i, kode: '', beskrivelse: '', belop: null, side: '' }));
    return [...fra, ...tomme];
  }, [lagret.data]);

  const kolonner = useMemo<ColDef<PrisRad>[]>(
    () => [
      { field: 'kode', headerName: 'Kode', width: 90, editable: true },
      { field: 'beskrivelse', headerName: 'Beskrivelse', flex: 1, editable: true },
      { field: 'belop', headerName: 'Beløp', width: 140, editable: true, type: 'rightAligned', valueFormatter: (p) => kr(p.value), valueParser: belopParser, cellClass: 'fra-tilbud' },
      { field: 'side', headerName: 'Side', width: 90, editable: true },
    ],
    [],
  );

  const [sum, setSum] = useState(() => summer(rader.map((r) => r.belop)));
  const oppdaterSum = () => {
    const b: (string | null)[] = [];
    gridApi?.forEachNode((n) => b.push(n.data?.belop ?? null));
    setSum(summer(b));
  };

  const lagre = () => {
    const linjer: PrisRad[] = [];
    gridApi?.forEachNode((n) => n.data && (n.data.beskrivelse || n.data.belop) && linjer.push(n.data));
    void utfor(
      async () => {
        if (!dok) throw new Error('Last opp tilbudsdokumentet først. Prisfordelingen skal peke på dokument og side.');
        for (const l of linjer) if (!l.side) throw new Error(`Linjen «${l.beskrivelse}» mangler side i tilbudet`);
        await api.send(
          'PUT',
          `/tilbud/${tilbud.id}/prisfordeling`,
          linjer.map((l) => ({ kode: l.kode || null, beskrivelse: l.beskrivelse, belop: l.belop ?? '0', kildeType: 'tilbud', kildeDokumentId: dok, kildeRef: l.side })),
        );
        await lagret.last();
      },
      undefined,
      visFeil,
    );
  };

  return (
    <div className="kort" style={{ marginTop: 8 }}>
      <div className="kort-hode">
        <b>Prisfordeling v{tilbud.versjon}</b>
        <div className="knapper">
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            Dokument
            <select value={dok} onChange={(e) => setDok(e.target.value)}>
              {tilbud.dokumenter.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filnavn}
                </option>
              ))}
            </select>
          </label>
          <button className="primar" onClick={lagre}>
            Lagre prisfordeling
          </button>
          <button onClick={lukk}>Lukk</button>
        </div>
      </div>
      <p className="dempet" style={{ fontSize: 12 }}>
        Lim inn fra Excel (kode, beskrivelse, beløp, side) med Ctrl+V i første celle. Summen kontrolleres mot tilbudssummen i evalueringen
        (visning her er bare til hjelp; selve kontrollen regnes på serveren uten flyttall).
      </p>
      <div ref={utklipp} style={{ height: 300 }}>
        <AgGridReact<PrisRad>
          theme={tema}
          localeText={norskGrid}
          rowData={rader}
          columnDefs={kolonner}
          getRowId={(r) => String(r.data.nr)}
          onGridReady={(e) => setGridApi(e.api)}
          onCellValueChanged={oppdaterSum}
          onRowDataUpdated={oppdaterSum}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
        />
      </div>
      <p className="tall" style={{ margin: '6px 0 0' }}>
        Sum linjer: <b>{kr(sum)}</b> · Tilbudssum: <b>{kr(tilbud.tilbudssum)}</b>
      </p>
    </div>
  );
}

/** Summerer beløp som desimaltall (aldri flyttall). */
function summer(belop: (string | null)[]): string {
  return summerTall(belop.filter((b): b is string => !!b)).toFixed(2);
}
