import { D, type Tall, sum, tilDesimal, tilDesimalEllerNull, tilKroner, tilOre } from './tall.js';

/**
 * En justering har aldri eget beløp. Grunnbeløpet hentes fra en forutsetning (felles anslag)
 * eller fra tilbudets egen post, og ganges med faktor (standard 1,0) og fortegn.
 */
export interface JusteringInput {
  grunnbelop: Tall;
  faktor?: Tall | null;
  fortegn: 1 | -1;
}

export function justeringsbelop(j: JusteringInput): D {
  const faktor = tilDesimalEllerNull(j.faktor ?? null) ?? new D(1);
  return tilOre(tilDesimal(j.grunnbelop).times(faktor).times(j.fortegn));
}

export interface TilbudMalBInput {
  id: string;
  navn: string;
  medIEvaluering: boolean;
  /** Tilbudssum iht. tilbudsbrev. Null når den ikke er registrert ennå. */
  tilbudssum: Tall | null;
  justeringer: JusteringInput[];
  /** Prisfordeling fra tilbudet. Kontrollen gjelder bare når den er oppgitt. */
  prisfordeling?: Tall[] | null;
}

export interface TilbudResultat {
  id: string;
  navn: string;
  medIEvaluering: boolean;
  tilbudssum: D | null;
  sumJusteringer: D;
  sumTillegg: D;
  evaluertSum: D | null;
  /** Sum prisfordeling − tilbudssum, rundet til hele kroner. Null når det ikke finnes noe å kontrollere. */
  kontrolldifferanse: D | null;
  kontrollOk: boolean;
  /** Sum positive justeringer / evaluert sum. */
  andelKalkTillegg: D | null;
  rangering: number | null;
  diffMotLaveste: D | null;
  diffProsent: D | null;
  nokPerM2: D | null;
}

export interface Rangerbar {
  id: string;
  verdi: D | null;
}

/**
 * Rangering etter verdi, lavest først. Lik verdi gir lik plass (1, 1, 3), som RANG(...;1) i Excel.
 * Elementer uten verdi får ikke plass.
 */
export function ranger(elementer: Rangerbar[]): Map<string, number> {
  const medVerdi = elementer.filter((e): e is { id: string; verdi: D } => e.verdi !== null);
  const plass = new Map<string, number>();
  for (const e of medVerdi) {
    plass.set(e.id, 1 + medVerdi.filter((a) => a.verdi.lessThan(e.verdi)).length);
  }
  return plass;
}

/** Evaluering etter mal B: evaluert sum = tilbudssum i brev + sum justeringer. */
export function evaluerMalB(tilbud: TilbudMalBInput[], opts: { bta?: Tall | null } = {}): TilbudResultat[] {
  const bta = tilDesimalEllerNull(opts.bta ?? null);

  const grunn = tilbud.map((t) => {
    const tilbudssum = tilDesimalEllerNull(t.tilbudssum);
    const belop = t.justeringer.map(justeringsbelop);
    const sumJusteringer = sum(belop);
    const sumTillegg = sum(belop.filter((b) => b.greaterThan(0)));
    const evaluertSum = tilbudssum === null ? null : tilbudssum.plus(sumJusteringer);

    let kontrolldifferanse: D | null = null;
    if (t.prisfordeling && t.prisfordeling.length > 0 && tilbudssum !== null) {
      kontrolldifferanse = tilKroner(sum(t.prisfordeling).minus(tilbudssum));
    }
    const andelKalkTillegg =
      evaluertSum === null || evaluertSum.isZero() ? null : sumTillegg.dividedBy(evaluertSum);

    return {
      id: t.id,
      navn: t.navn,
      medIEvaluering: t.medIEvaluering,
      tilbudssum,
      sumJusteringer,
      sumTillegg,
      evaluertSum,
      kontrolldifferanse,
      kontrollOk: kontrolldifferanse === null || kontrolldifferanse.isZero(),
      andelKalkTillegg,
    };
  });

  return medRangering(grunn, bta);
}

type UtenRangering = Omit<TilbudResultat, 'rangering' | 'diffMotLaveste' | 'diffProsent' | 'nokPerM2'>;

/** Legger på rangering, differanse mot laveste og NOK/m² BTA. Felles for alle maler. */
export function medRangering(resultater: UtenRangering[], bta: D | null): TilbudResultat[] {
  const rangerbare = resultater.filter((r) => r.medIEvaluering && r.evaluertSum !== null);
  const plass = ranger(rangerbare.map((r) => ({ id: r.id, verdi: r.evaluertSum })));
  const laveste = rangerbare.reduce<D | null>(
    (min, r) => (min === null || r.evaluertSum!.lessThan(min) ? r.evaluertSum : min),
    null,
  );

  return resultater.map((r) => {
    const rangert = plass.has(r.id);
    return {
      ...r,
      rangering: plass.get(r.id) ?? null,
      diffMotLaveste: rangert && laveste !== null ? r.evaluertSum!.minus(laveste) : null,
      diffProsent:
        rangert && laveste !== null && !laveste.isZero() ? r.evaluertSum!.dividedBy(laveste).minus(1) : null,
      nokPerM2: r.evaluertSum !== null && bta !== null && !bta.isZero() ? r.evaluertSum.dividedBy(bta) : null,
    };
  });
}

export interface SammendragInput {
  resultater: TilbudResultat[];
  /** Valgt tilbud. Tom betyr at laveste evaluerte brukes. */
  valgtTilbudId?: string | null;
  risikotillegg?: Tall | null;
  heAnslag?: Tall | null;
  bta?: Tall | null;
}

export interface Sammendrag {
  laveste: { id: string; navn: string; evaluertSum: D } | null;
  antallEvaluert: number;
  valgt: { id: string; navn: string; tilbudssum: D | null; evaluertSum: D; erLaveste: boolean; valgtManuelt: boolean } | null;
  risikotillegg: D;
  tilKalkyle: D | null;
  tilKalkylePerM2: D | null;
  heAnslag: D | null;
  avvikHeAnslag: D | null;
  avvikHeAnslagProsent: D | null;
}

/** Sammendraget i fagets evaluering: laveste, valgt UE og beløp til kalkyle. */
export function lagSammendrag(inp: SammendragInput): Sammendrag {
  const rangerte = inp.resultater
    .filter((r) => r.rangering !== null && r.evaluertSum !== null)
    .sort((a, b) => a.evaluertSum!.comparedTo(b.evaluertSum!));
  const lav = rangerte[0];
  const laveste = lav ? { id: lav.id, navn: lav.navn, evaluertSum: lav.evaluertSum! } : null;

  const manuelt = inp.valgtTilbudId ? rangerte.find((r) => r.id === inp.valgtTilbudId) : undefined;
  const v = manuelt ?? lav;
  const valgt = v
    ? {
        id: v.id,
        navn: v.navn,
        tilbudssum: v.tilbudssum,
        evaluertSum: v.evaluertSum!,
        erLaveste: v.rangering === 1,
        valgtManuelt: manuelt !== undefined,
      }
    : null;

  const risikotillegg = tilDesimalEllerNull(inp.risikotillegg ?? null) ?? new D(0);
  const tilKalkyle = valgt ? valgt.evaluertSum.plus(risikotillegg) : null;
  const heAnslag = tilDesimalEllerNull(inp.heAnslag ?? null);
  const bta = tilDesimalEllerNull(inp.bta ?? null);

  return {
    laveste,
    antallEvaluert: rangerte.length,
    valgt,
    risikotillegg,
    tilKalkyle,
    tilKalkylePerM2: tilKalkyle !== null && bta !== null && !bta.isZero() ? tilKalkyle.dividedBy(bta) : null,
    heAnslag,
    avvikHeAnslag: tilKalkyle !== null && heAnslag !== null ? tilKalkyle.minus(heAnslag) : null,
    avvikHeAnslagProsent:
      tilKalkyle !== null && heAnslag !== null && !heAnslag.isZero() ? tilKalkyle.dividedBy(heAnslag).minus(1) : null,
  };
}

export interface FerdigKontroll {
  ok: boolean;
  avvik: { id: string; navn: string; grunn: string }[];
}

/** «Ferdig evaluert» blokkeres når et tilbud i evalueringen mangler tilbudssum eller har kontrollavvik. */
export function kanSettesFerdig(resultater: TilbudResultat[]): FerdigKontroll {
  const avvik: FerdigKontroll['avvik'] = [];
  for (const r of resultater.filter((x) => x.medIEvaluering)) {
    if (r.tilbudssum === null) avvik.push({ id: r.id, navn: r.navn, grunn: 'Tilbudssum fra tilbudsbrevet mangler' });
    if (!r.kontrollOk) {
      avvik.push({
        id: r.id,
        navn: r.navn,
        grunn: `Kontrolldifferanse ${r.kontrolldifferanse!.toFixed(0)} kr mot tilbudssummen`,
      });
    }
  }
  if (!resultater.some((r) => r.medIEvaluering && r.evaluertSum !== null)) {
    avvik.push({ id: '', navn: '', grunn: 'Ingen tilbud er med i evalueringen' });
  }
  return { ok: avvik.length === 0, avvik };
}

/** Tilbud mottatt etter fristen. Uten frist kan ingenting være for sent. */
export function etterFrist(mottatt: Date, frist: Date | null): boolean {
  return frist !== null && mottatt.getTime() > frist.getTime();
}
