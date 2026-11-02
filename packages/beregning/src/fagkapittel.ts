/**
 * Fagkapittelnummer er tekst («05.1», «82.10»). Sorteringsnøkkelen fyller hvert ledd ut med nuller,
 * slik at «82.9» kommer før «82.10». Samme regel ligger i databasefunksjonen fag_sorteringsnokkel().
 */
export function sorteringsnokkel(nummer: string): string {
  return nummer
    .trim()
    .split('.')
    .map((ledd) => (/^\d+$/.test(ledd) ? ledd.padStart(4, '0') : ledd))
    .join('.');
}

/** Sammenligner to fagkapittelnummer. Lik nøkkel («05.1» og «5.1») avgjøres av teksten. */
export function sammenlignFagnummer(a: string, b: string): number {
  const na = sorteringsnokkel(a);
  const nb = sorteringsnokkel(b);
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** «05.1» → «05». Returnerer null for et hovedkapittel. */
export function overordnetNummer(nummer: string): string | null {
  const i = nummer.lastIndexOf('.');
  return i > 0 ? nummer.slice(0, i) : null;
}

/** Fagkapittel nevnt i en mappe under «4 Mottatte tilbud», f.eks. «31 Andenæs VVS» → «31». */
export function kapittelFraMappenavn(mappenavn: string): string | null {
  const m = /^\s*(\d+(?:\.\d+)*)\s+/.exec(mappenavn);
  return m?.[1] ?? null;
}
