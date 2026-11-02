/** Tynn klient mot serverens /api. Feil fra serveren kommer som { feil } og kastes som Error med norsk tekst. */

function brukerHeader(): Record<string, string> {
  try {
    const epost = localStorage.getItem('bruker-epost');
    return epost ? { 'x-bruker-epost': epost } : {};
  } catch {
    return {};
  }
}

async function svar<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let melding = `Feil ${r.status}`;
    try {
      const j = await r.json();
      if (j?.feil) melding = j.feil;
    } catch {
      // Ikke JSON
    }
    throw new Error(melding);
  }
  const type = r.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? r.json() : r.text()) as Promise<T>;
}

export const api = {
  get: <T = any>(url: string) => fetch(`/api${url}`, { headers: brukerHeader() }).then((r) => svar<T>(r)),
  send: <T = any>(metode: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    fetch(`/api${url}`, {
      method: metode,
      headers: { ...brukerHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => svar<T>(r)),
  lastOpp: <T = any>(url: string, filer: FileList | File[]) => {
    const fd = new FormData();
    for (const f of Array.from(filer)) fd.append('fil', f, f.name);
    return fetch(`/api${url}`, { method: 'POST', headers: brukerHeader(), body: fd }).then((r) => svar<T>(r));
  },
};
