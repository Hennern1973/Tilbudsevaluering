import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LagretFil {
  lagringstype: 'lokal' | 'sharepoint';
  lagringsnokkel: string;
  mappesti: string;
  sha256: string;
  storrelse: number;
  sharepointDriveId?: string;
  sharepointItemId?: string;
}

/**
 * Lagring av tilbudsdokumenter. Mappestrukturen er den samme som på SharePoint:
 *   <prosjektnr>/4 Mottatte tilbud/<kap.nr> <UE-navn>/<fil>
 * En SharePoint-kobling (Microsoft Graph) skal implementere samme grensesnitt, og kan i tillegg
 * lese eksisterende mapper og knytte dem til fag via kapittelnummeret i mappenavnet.
 */
export interface DokumentLagring {
  lagre(opts: { prosjektnr: string; kapittel: string; tilbyder: string; filnavn: string; innhold: Buffer }): Promise<LagretFil>;
  hent(lagringsnokkel: string): Promise<Buffer>;
}

/** Fjerner tegn som ikke er lov i fil- og mappenavn på Windows/SharePoint. */
export function trygtNavn(navn: string): string {
  return navn.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/, '').trim() || 'uten navn';
}

export class LokalLagring implements DokumentLagring {
  constructor(private rot: string) {}

  async lagre(opts: { prosjektnr: string; kapittel: string; tilbyder: string; filnavn: string; innhold: Buffer }): Promise<LagretFil> {
    const mappesti = path.posix.join(
      trygtNavn(opts.prosjektnr),
      '4 Mottatte tilbud',
      trygtNavn(`${opts.kapittel} ${opts.tilbyder}`),
    );
    const sha256 = createHash('sha256').update(opts.innhold).digest('hex');
    // Hash-prefiks hindrer at to filer med samme navn overskriver hverandre.
    const lagringsnokkel = path.posix.join(mappesti, `${sha256.slice(0, 8)}_${trygtNavn(opts.filnavn)}`);
    const fullSti = this.fullSti(lagringsnokkel);
    await mkdir(path.dirname(fullSti), { recursive: true });
    await writeFile(fullSti, opts.innhold);
    return { lagringstype: 'lokal', lagringsnokkel, mappesti, sha256, storrelse: opts.innhold.length };
  }

  async hent(lagringsnokkel: string): Promise<Buffer> {
    return readFile(this.fullSti(lagringsnokkel));
  }

  private fullSti(nokkel: string): string {
    const full = path.resolve(this.rot, nokkel);
    if (!full.startsWith(path.resolve(this.rot) + path.sep)) throw new Error('Ugyldig lagringsnøkkel');
    return full;
  }
}
