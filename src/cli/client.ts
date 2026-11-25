import { DAEMON_URL } from "../config.ts";

/* O lado do CLI que fala com o motor. */

export class DaemonUnavailable extends Error {
  constructor() {
    super("o motor não está rodando. Rode neoterm daemon num terminal, ou neoterm service on para ligar junto com o Mac");
    this.name = "DaemonUnavailable";
  }
}

export async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${DAEMON_URL}${path}`, init);
  } catch {
    throw new DaemonUnavailable();
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `o motor respondeu ${response.status}`);
  }
  return response;
}

export async function getJson<T>(path: string): Promise<T> {
  return (await (await request(path)).json()) as T;
}

/** Lê um stream de Server-Sent Events, um evento por vez. */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
      boundary = buffer.indexOf("\n\n");
    }
  }
}
