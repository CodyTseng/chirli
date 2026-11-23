import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Bot, WebSocketTransport, allowlist, bunkerSigner, nsecSigner, type Signer } from 'chirli';
import { generatedIdentity } from './identity.js';
import { configuration, ConfigurationError } from './config.js';
import { reportDiagnostic } from './diagnostics.js';
import { timedSigner } from './timing.js';
import { readyBanner } from './ready.js';

/** Application-owned configuration, readiness, background work and signal handling. */
export async function runLive<S = Record<string, unknown>>(
  name: string, hint: string, configure: (bot: Bot<S>) => void,
) {
  if (process.argv.includes('--help')) {
    console.log(`${name} live DM bot. ${hint}
No environment variables required: a persistent identity and plaintext local storage are created automatically; PsstPsst DM and read/write relay defaults are used; registered public commands are announced.
Start with npm run bot:${name}. It stays running until Ctrl+C / SIGTERM.
See examples/live/README.md for persistent keys, bunker, allowlist and relay setup.`);
    return;
  }

  let wire: WebSocketTransport | undefined;
  let signer: Signer | undefined;
  let bot: Bot<S> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let retryTask: Promise<void> | undefined;
  let savedIdentity: string | undefined;
  let phase = 'configuration';
  let stopRequested = false;
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  const report = (error: unknown) => reportDiagnostic(error, phase);
  const stop = () => {
    stopRequested = true;
    resolveStop();
    void bot?.stop().catch(report);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const config = configuration(process.env);
    phase = 'signer';

    if (config.bunker !== undefined) {
      signer = bunkerSigner(config.bunker, { clientSecret: config.bunkerClientKey });
    } else {
      const saved = config.nsec ? undefined : generatedIdentity(config.database, config.storageKey);
      if (saved) savedIdentity = `${saved.created ? 'Generated' : 'Reusing'} local bot identity: ${saved.file}`;
      try {
        signer = nsecSigner(config.nsec ?? saved!.nsec);
      } catch {
        throw new ConfigurationError('CHIRLI_NSEC must be a valid nsec. Use bot:init for a new bot account.');
      }
    }

    if (config.timing) signer = timedSigner(signer, line => console.error(line));
    if (stopRequested) return;

    const handlerStarts = new Map<string, number>();
    const finishHandler = (id: string, outcome: string) => {
      const started = handlerStarts.get(id);
      if (started === undefined) return;
      handlerStarts.delete(id);
      console.error(`[timing] handler durationMs=${Math.round(performance.now() - started)} outcome=${outcome}`);
    };

    wire = new WebSocketTransport(
      config.relayTimeoutMs ?? {},
      template => signer!.signEvent(template),
      config.timing ? metric => {
        console.error(`[timing] ${metric.operation} relay=${metric.relay} kinds=${metric.kinds.join(',')} durationMs=${metric.durationMs} outcome=${metric.outcome}${metric.code ? ` code=${metric.code}` : ''}`);
      } : undefined,
    );

    phase = 'storage';
    mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
    const keyMode = config.rotation
      ? { mode: 'nip4e' as const, keyRotation: config.rotation }
      : { mode: config.mode, keyRotation: false as const };
    bot = new Bot<S>({
      signer,
      transport: wire,
      ...keyMode,
      storageKey: config.storageKey,
      database: config.database,
      dmRelays: config.relays,
      readRelays: config.readRelays,
      writeRelays: config.writeRelays,
      discoveryRelays: config.discoveryRelays,
      inboundPolicy: config.allowlist === undefined ? undefined : allowlist(config.allowlist),
      keySync: config.keySync,
    });

    bot.onError((error, message) => {
      if (config.timing && message) finishHandler(message.id, 'error');
      reportDiagnostic(error, message ? 'handler' : 'background', message ? 'error' : 'warning');
    });
    if (config.timing) bot.use(async (ctx, next) => {
      handlerStarts.set(ctx.message.id, performance.now());
      await next();
      finishHandler(ctx.message.id, 'ok');
    });
    configure(bot);

    phase = 'startup';
    await bot.start();
    if (stopRequested) return;
    phase = 'running';

    const running = bot;
    timer = setInterval(() => {
      if (stopRequested || retryTask) return;
      const task = running.flushAnnouncements()
        .then(() => { if (!stopRequested) return running.flushOutbox(); })
        .catch(error => {
          if (!stopRequested) reportDiagnostic(error, 'outbox-retry', 'warning');
        })
        .finally(() => { if (retryTask === task) retryTask = undefined; });
      retryTask = task;
    }, config.outboxRetryMs);

    console.log(readyBanner({
      name,
      hint,
      pubkey: bot.pubkey,
      mode: config.mode,
      relays: config.relays.length,
      allowlist: config.allowlist,
      storageEncrypted: !!config.storageKey,
      savedIdentity,
    }));
    await stopped;
  } catch (error) {
    if (!stopRequested) {
      report(error);
      process.exitCode = 1;
    }
  } finally {
    phase = 'shutdown';
    stopRequested = true;
    clearInterval(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);

    // Finish application-owned background work before closing its dependencies.
    await retryTask;
    try { await bot?.close(); } catch (error) { report(error); process.exitCode = 1; }
    try { wire?.close(); } catch { process.exitCode = 1; }
    try { await signer?.close?.(); } catch { process.exitCode = 1; }
  }
}
