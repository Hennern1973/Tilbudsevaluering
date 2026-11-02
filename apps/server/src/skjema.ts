import { z } from 'zod';

/** Beløp sendes som tekst med punktum som desimaltegn («2380000.00»), aldri som JS-number. */
export const belop = z.string().regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Beløp må være et tall med inntil to desimaler');
export const mengde = z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/, 'Mengde må være et tall med inntil tre desimaler');
export const faktor = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Faktor må være et tall, f.eks. 0.5');
export const uuid = z.string().uuid();
export const dato = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dato må ha formatet ÅÅÅÅ-MM-DD');
export const tidspunkt = z.string().datetime({ offset: true });
export const tekst = z.string().trim();

export const kildeType = z.enum(['tilbud', 'forutsetning', 'beregnet']);

/** Kildefeltene. Samme regel som CHECK-ene i databasen, men med norske feilmeldinger. */
export const kildefelt = z.object({
  kildeType: kildeType.nullish(),
  kildeDokumentId: uuid.nullish(),
  kildeRef: tekst.nullish(),
  kildeBegrunnelse: tekst.nullish(),
});

export function sjekkKilde(k: z.infer<typeof kildefelt>, ctx: z.RefinementCtx): void {
  if (k.kildeType === 'tilbud' && (!k.kildeDokumentId || !k.kildeRef)) {
    ctx.addIssue({ code: 'custom', message: '«Fra tilbud» krever dokument og side/ark', path: ['kildeRef'] });
  }
  if (k.kildeType === 'forutsetning' && !k.kildeBegrunnelse) {
    ctx.addIssue({ code: 'custom', message: '«Kalkulatorisk forutsetning» krever begrunnelse', path: ['kildeBegrunnelse'] });
  }
}

export function kildeKolonner(k: z.infer<typeof kildefelt>) {
  return [k.kildeType ?? null, k.kildeDokumentId ?? null, k.kildeRef || null, k.kildeBegrunnelse || null];
}
