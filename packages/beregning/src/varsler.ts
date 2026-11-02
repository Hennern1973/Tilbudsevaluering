import type { TilbudResultat } from './evaluering.js';

/** Risikoflagg. De vises som advarsler og stopper aldri brukeren. */
export type VarselType =
  | 'etter_frist'
  | 'kort_vedstaelse'
  | 'laveste_med_apne_punkter'
  | 'forbehold_detaljprosjektering'
  | 'avvik_seriositet'
  | 'kontrollavvik';

export interface Varsel {
  tilbudId: string;
  type: VarselType;
  tekst: string;
}

export interface VarselTilbud {
  id: string;
  etterFrist: boolean;
  vedstaelsesfrist: Date | null;
  /** Antall omfangspunkter som ikke er «inkl.» eller «ikke relevant». */
  apneOmfangspunkter: number;
  kompletthet: 'komplett' | 'mindre_mangler' | 'vesentlige_mangler' | null;
  forbeholdKategorier: string[];
}

export function finnVarsler(
  resultater: TilbudResultat[],
  tilbud: VarselTilbud[],
  opts: { forventetKontraktsdato: Date | null },
): Varsel[] {
  const varsler: Varsel[] = [];
  const laveste = resultater.find((r) => r.rangering === 1);

  for (const t of tilbud) {
    const r = resultater.find((x) => x.id === t.id);
    if (t.etterFrist) varsler.push({ tilbudId: t.id, type: 'etter_frist', tekst: 'Tilbudet er mottatt etter fristen.' });
    if (t.vedstaelsesfrist && opts.forventetKontraktsdato && t.vedstaelsesfrist < opts.forventetKontraktsdato) {
      varsler.push({
        tilbudId: t.id,
        type: 'kort_vedstaelse',
        tekst: 'Vedståelsesfristen går ut før forventet kontraktsdato.',
      });
    }
    if (laveste?.id === t.id && (t.apneOmfangspunkter > 0 || (t.kompletthet !== null && t.kompletthet !== 'komplett'))) {
      varsler.push({
        tilbudId: t.id,
        type: 'laveste_med_apne_punkter',
        tekst: `Laveste tilbud har ${t.apneOmfangspunkter} åpne punkter i sjekklisten. Lavest er ofte tynnest dokumentert.`,
      });
    }
    if (t.forbeholdKategorier.includes('detaljprosjektering')) {
      varsler.push({
        tilbudId: t.id,
        type: 'forbehold_detaljprosjektering',
        tekst: 'Forbehold om endringer fra detaljprosjektering, som ikke passer med totalentreprise.',
      });
    }
    if (t.forbeholdKategorier.includes('seriositet')) {
      varsler.push({ tilbudId: t.id, type: 'avvik_seriositet', tekst: 'Avvik fra byggherrens seriøsitetskrav.' });
    }
    if (r && !r.kontrollOk) {
      varsler.push({ tilbudId: t.id, type: 'kontrollavvik', tekst: 'Tilbudssummen stemmer ikke med summen av postene.' });
    }
  }
  return varsler;
}
