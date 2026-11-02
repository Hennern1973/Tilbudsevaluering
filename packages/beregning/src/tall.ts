import Decimal from 'decimal.js';

// Egen Decimal-klasse slik at innstillingene ikke påvirker andre brukere av biblioteket.
// ROUND_HALF_UP runder 0,5 bort fra null, likt Excels AVRUND/ROUND.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type D = InstanceType<typeof D>;

/** Tall slik de kommer fra databasen (NUMERIC som tekst) eller fra beregninger. Aldri JS-number for beløp. */
export type Tall = string | D;

export function tilDesimal(verdi: Tall): D {
  return verdi instanceof D ? verdi : new D(verdi);
}

export function tilDesimalEllerNull(verdi: Tall | null | undefined): D | null {
  if (verdi === null || verdi === undefined || verdi === '') return null;
  return tilDesimal(verdi);
}

export function sum(verdier: Tall[]): D {
  return verdier.reduce<D>((acc, v) => acc.plus(tilDesimal(v)), new D(0));
}

/** Runder til øre. Brukes på hvert beløp som lagres eller summeres videre. */
export function tilOre(verdi: D): D {
  return verdi.toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** Runder til hele kroner, som AVRUND(...;0) i malene. */
export function tilKroner(verdi: D): D {
  return verdi.toDecimalPlaces(0, D.ROUND_HALF_UP);
}

const NBSP = ' ';
const NNBSP = ' ';

/**
 * Tolker et tall slik det limes inn fra norsk Excel eller skrives av en kalkulatør:
 * «1 234 567,50», «1234567,5», «-12,3», «1234.5» (punktum som desimal når det ikke finnes komma).
 * Returnerer null for tom tekst og kaster ved ugyldig tekst, slik at feil aldri blir 0 i det stille.
 */
export function parseNorskTall(tekst: string): D | null {
  let s = tekst.trim().replaceAll(NBSP, ' ').replaceAll(NNBSP, ' ');
  if (s === '' || s === '-') return null;
  s = s.replace(/\s+/g, '').replace(/^(kr|nok)\.?/i, '').replace(/(kr|nok)\.?$/i, '').replace(/,[-–]$/, '');
  s = s.replace(/^−/, '-');
  if (s.includes(',')) {
    // Punktum som tusenskille («1.234,50») fjernes, komma blir desimaltegn.
    s = s.replaceAll('.', '').replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Ugyldig tall: «${tekst}»`);
  }
  return new D(s);
}

const FORMAT_CACHE = new Map<number, Intl.NumberFormat>();
function format(desimaler: number): Intl.NumberFormat {
  let f = FORMAT_CACHE.get(desimaler);
  if (!f) {
    f = new Intl.NumberFormat('nb-NO', {
      minimumFractionDigits: desimaler,
      maximumFractionDigits: desimaler,
      useGrouping: true,
    });
    FORMAT_CACHE.set(desimaler, f);
  }
  return f;
}

/**
 * Norsk visning: mellomrom som tusenskille, komma som desimaltegn, vanlig minus.
 * Rundingen gjøres med Decimal før formatering, så visningen aldri går via flyttall-avrunding.
 */
export function formaterTall(verdi: Tall | null | undefined, desimaler = 0): string {
  const d = tilDesimalEllerNull(verdi);
  if (d === null) return '';
  const avrundet = d.toDecimalPlaces(desimaler, D.ROUND_HALF_UP);
  const [heltall, brok] = avrundet.abs().toFixed(desimaler).split('.');
  const gruppert = format(0).format(BigInt(heltall ?? '0')).replaceAll(NBSP, ' ').replaceAll(NNBSP, ' ');
  const fortegn = avrundet.isNegative() && !avrundet.isZero() ? '-' : '';
  return fortegn + gruppert + (brok ? ',' + brok : '');
}

export function formaterProsent(andel: Tall | null | undefined, desimaler = 1): string {
  const d = tilDesimalEllerNull(andel);
  if (d === null) return '';
  return formaterTall(d.times(100), desimaler) + ' %';
}
