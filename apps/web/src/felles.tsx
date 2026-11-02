import { formaterProsent, formaterTall, parseNorskTall } from '@tilbud/beregning';
import { AllCommunityModule, type GridApi, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

ModuleRegistry.registerModules([AllCommunityModule]);

export const tema = themeQuartz.withParams({
  fontSize: 13,
  headerFontWeight: 600,
  rowHeight: 30,
  headerHeight: 34,
  spacing: 6,
  wrapperBorderRadius: 4,
});

export const kr = (v: string | null | undefined) => formaterTall(v, 0);
export const kr2 = (v: string | null | undefined) => formaterTall(v, 2);
export const pst = (v: string | null | undefined) => formaterProsent(v, 1);

export function datoTekst(v: string | null | undefined): string {
  if (!v) return '';
  const d = v.length > 10 ? new Date(v) : new Date(`${v}T12:00:00`);
  return d.toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function tidTekst(v: string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** «1 234,5» → «1234.50» for API-et. Tom tekst → null. Ugyldig tekst kaster med norsk melding. */
export function tilApiBelop(tekst: string): string | null {
  const d = parseNorskTall(tekst);
  return d === null ? null : d.toFixed(2);
}

/** Verdi i AG Grid-celle: tolker norsk tall ved redigering og liming. */
export function belopParser(p: { newValue: unknown; oldValue: unknown }): string | null {
  const v = p.newValue;
  if (v === null || v === undefined) return null;
  try {
    return tilApiBelop(String(v));
  } catch (e) {
    alert((e as Error).message);
    return p.oldValue as string | null;
  }
}

export const norskGrid = {
  noRowsToShow: 'Ingen rader',
  loadingOoo: 'Laster …',
  page: 'Side',
  to: 'til',
  of: 'av',
  filterOoo: 'Filtrer …',
  equals: 'Lik',
  contains: 'Inneholder',
  ariaChecked: 'avkrysset',
  ariaUnchecked: 'ikke avkrysset',
};

/**
 * Lim inn fra Excel: tabulator-separert tekst fra utklippstavlen fylles inn fra cellen som har fokus,
 * i redigerbare celler. Hver celle går gjennom kolonnens valueParser og lagres som vanlig redigering.
 * Ctrl+C kopierer cellen med fokus som vist tekst.
 */
export function useExcelUtklipp(api: GridApi | null) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !api) return;
    const lim = (e: ClipboardEvent) => {
      if (api.getEditingCells().length > 0) return;
      const fokus = api.getFocusedCell();
      const tekst = e.clipboardData?.getData('text/plain');
      if (!fokus || !tekst) return;
      e.preventDefault();
      const rader = tekst.replace(/\r?\n$/, '').split(/\r?\n/).map((r) => r.split('\t'));
      const kolonner = api.getAllDisplayedColumns();
      const start = kolonner.indexOf(fokus.column);
      rader.forEach((celler, i) => {
        const node = api.getDisplayedRowAtIndex(fokus.rowIndex + i);
        if (!node || node.rowPinned) return;
        celler.forEach((verdi, j) => {
          const kol = kolonner[start + j];
          if (!kol || !kol.isCellEditable(node)) return;
          const def = kol.getColDef();
          const parser = typeof def.valueParser === 'function' ? def.valueParser : null;
          const ny = parser
            ? parser({ newValue: verdi, oldValue: api.getCellValue({ rowNode: node, colKey: kol }), node, data: node.data, colDef: def, column: kol, api, context: undefined })
            : verdi;
          node.setDataValue(kol, ny, 'paste');
        });
      });
    };
    const kopier = (e: ClipboardEvent) => {
      if (api.getEditingCells().length > 0) return;
      const fokus = api.getFocusedCell();
      if (!fokus) return;
      const node = api.getDisplayedRowAtIndex(fokus.rowIndex);
      if (!node) return;
      const vist = api.getCellValue({ rowNode: node, colKey: fokus.column, useFormatter: true });
      e.clipboardData?.setData('text/plain', vist === null || vist === undefined ? '' : String(vist));
      e.preventDefault();
    };
    el.addEventListener('paste', lim);
    el.addEventListener('copy', kopier);
    return () => {
      el.removeEventListener('paste', lim);
      el.removeEventListener('copy', kopier);
    };
  }, [api]);
  return ref;
}

/** Laster data og gir en funksjon for å laste på nytt etter endringer. */
export function useLast<T>(hent: () => Promise<T>, avhengigheter: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [feil, setFeil] = useState<string | null>(null);
  const last = useCallback(async () => {
    try {
      setData(await hent());
      setFeil(null);
    } catch (e) {
      setFeil((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, avhengigheter);
  useEffect(() => {
    void last();
  }, [last]);
  return { data, feil, last, setFeil };
}

/** Kjører en handling og viser feilen fra serveren i stedet for å svelge den. */
export async function utfor(handling: () => Promise<unknown>, etter?: () => unknown, visFeil: (m: string) => void = alert) {
  try {
    await handling();
    await etter?.();
  } catch (e) {
    visFeil((e as Error).message);
    await etter?.();
  }
}

export function Feil({ melding, lukk }: { melding: string | null; lukk?: () => void }) {
  if (!melding) return null;
  return (
    <div className="feil" role="alert">
      {melding}
      {lukk && (
        <button className="lenke" onClick={lukk}>
          Lukk
        </button>
      )}
    </div>
  );
}

export function Seksjon({ tittel, children, hoyre }: { tittel: string; children: ReactNode; hoyre?: ReactNode }) {
  return (
    <section className="seksjon">
      <div className="seksjon-hode">
        <h2>{tittel}</h2>
        <div>{hoyre}</div>
      </div>
      {children}
    </section>
  );
}

export function Fargeforklaring() {
  return (
    <div className="forklaring">
      <span className="fra-tilbud">Blå = fra tilbud (med fil og side)</span>
      <span className="forutsetning">Gul = kalkulatorisk forutsetning (med begrunnelse)</span>
      <span>Svart = beregnet</span>
    </div>
  );
}

export const STATUS_FAG: Record<string, string> = {
  ikke_aktuell: 'Ikke aktuell',
  forespurt: 'Forespurt',
  delvis_mottatt: 'Delvis mottatt',
  under_evaluering: 'Under evaluering',
  evaluert: 'Evaluert',
  lagt_til_grunn: 'Lagt til grunn',
  kontrahert: 'Kontrahert',
};

export const STATUS_EVALUERING: Record<string, string> = {
  under_evaluering: 'Under evaluering',
  ferdig_evaluert: 'Ferdig evaluert',
  ks_godkjent: 'KS godkjent',
};

export const STATUS_FORESPORSEL: Record<string, string> = {
  forespurt: 'Forespurt',
  tilbud_mottatt: 'Tilbud mottatt',
  regner_ikke: 'Regner ikke',
  ikke_svart: 'Ikke svart',
};

export const STATUS_OMFANG: Record<string, string> = {
  inkl: 'Inkl.',
  ikke_inkl: 'Ikke inkl.',
  uavklart: 'Uavklart',
  forbehold: 'Forbehold',
  avvik: 'Avvik',
  andre: 'Andre',
  overlapp: 'Overlapp',
  ikke_relevant: 'Ikke relevant',
};

export const KOMPLETTHET: Record<string, string> = {
  komplett: 'Komplett',
  mindre_mangler: 'Mindre mangler',
  vesentlige_mangler: 'Vesentlige mangler',
};

export const GRUPPE_OMFANG: Record<string, string> = {
  generelt: 'Generelt',
  hovedleveranse: 'Hovedleveranse',
  grensesnitt: 'Grensesnitt',
  krav: 'Krav',
  opsjoner: 'Opsjoner',
};

export const STATUS_FORBEHOLD: Record<string, string> = {
  '0': '0 Ikke aktuell',
  '1': '1 OK / avklart',
  '2': '2 Ikke avklart',
  '3': '3 Ikke ivaretatt',
};

export const KATEGORI_FORBEHOLD: Record<string, string> = {
  detaljprosjektering: 'Detaljprosjektering',
  seriositet: 'Seriøsitet',
  fremdrift: 'Fremdrift',
  pris: 'Pris',
  omfang: 'Omfang',
  kontrakt: 'Kontrakt',
  annet: 'Annet',
};

/** Nedtrekksliste i AG Grid fra et oppslag kode → tekst. */
export function valgEditor(oppslag: Record<string, string>, tomt = true) {
  return {
    cellEditor: 'agSelectCellEditor',
    cellEditorParams: { values: [...(tomt ? [''] : []), ...Object.keys(oppslag)] },
    refData: oppslag,
  };
}
