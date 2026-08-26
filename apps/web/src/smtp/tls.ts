import { readFile } from "node:fs/promises";
import os from "node:os";
import { generate } from "selfsigned";

export interface TlsPem {
  key: string;
  cert: string;
}

let cached: Promise<TlsPem> | undefined;

/**
 * STARTTLS material for the relay. With `SMTP_TLS_CERT`/`SMTP_TLS_KEY` set,
 * those PEM files are used; otherwise a self-signed certificate is generated
 * once per process (dev/self-host default). Self-signed means SMTP clients
 * must disable certificate verification (`tls.rejectUnauthorized: false`),
 * so production installs should mount real certificates.
 */
export function loadOrGenerateCert(files?: {
  cert?: string;
  key?: string;
}): Promise<TlsPem> {
  return (cached ??=
    files?.cert && files.key
      ? Promise.all([
          readFile(files.key, "utf8"),
          readFile(files.cert, "utf8"),
        ]).then(([key, cert]) => ({ key, cert }))
      : generate([{ name: "commonName", value: os.hostname() }], {
          // selfsigned 5 takes dates, not `days`: ten years.
          notAfterDate: new Date(Date.now() + 3650 * 86_400_000),
          keySize: 2048,
        }).then((p) => ({ key: p.private, cert: p.cert })));
}
