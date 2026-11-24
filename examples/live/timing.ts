import type { Signer } from "chirli";
/** Diagnostic wrapper: reports operation duration/outcome only, never arguments or error text. */
export function timedSigner(
  signer: Signer,
  report: (line: string) => void,
): Signer & { close(): Promise<void> } {
  const measure = async <T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const start = performance.now();
    let outcome = "error";
    try {
      const value = await run();
      outcome = "ok";
      return value;
    } finally {
      try {
        report(
          `[timing] signer operation=${operation} durationMs=${Math.round(performance.now() - start)} outcome=${outcome}`,
        );
      } catch {
        /* Diagnostics cannot change signer behavior. */
      }
    }
  };
  const encrypt = signer.nip04Encrypt;
  const decrypt = signer.nip04Decrypt;
  return {
    getPublicKey: () => measure("getPublicKey", () => signer.getPublicKey()),
    signEvent: (template) =>
      measure("signEvent", () => signer.signEvent(template)),
    nip44Encrypt: (peer, text) =>
      measure("nip44Encrypt", () => signer.nip44Encrypt(peer, text)),
    nip44Decrypt: (peer, ciphertext) =>
      measure("nip44Decrypt", () => signer.nip44Decrypt(peer, ciphertext)),
    ...(encrypt
      ? {
          nip04Encrypt: (peer: string, text: string) =>
            measure("nip04Encrypt", () => encrypt.call(signer, peer, text)),
        }
      : {}),
    ...(decrypt
      ? {
          nip04Decrypt: (peer: string, text: string) =>
            measure("nip04Decrypt", () => decrypt.call(signer, peer, text)),
        }
      : {}),
    close: () =>
      measure("close", async () => {
        await signer.close?.();
      }),
  };
}
