import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'chirli-package-'));
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  // Build first with npm run build. Packing is offline and suppresses lifecycle hooks here.
  const output = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root, {
    ...process.env, npm_config_cache: join(scratch, 'npm-cache'), npm_config_offline: 'true',
  });
  const [manifest] = JSON.parse(output);
  assert.equal(manifest.name, 'chirli');
  const files = manifest.files.map(file => file.path);
  for (const required of ['dist/index.js', 'dist/announcements.js', 'dist/commands.js', 'dist/command-discovery.js', 'dist/relay-roles.js', 'dist/index.d.ts', 'dist/modes.js', 'dist/inbox.js', 'dist/signers.js', 'dist/signer.js', 'dist/signers/nsec.js', 'dist/signers/bunker.js', 'dist/nipcd.js', 'dist/public-inbox.js', 'dist/public-thread.js', 'docs/PUBLIC.md', 'dist/keys.js', 'dist/defaults.js', 'dist/storage.js', 'dist/storage-sqlite.js', 'dist/message-storage.js', 'dist/message-storage-sqlite.js', 'dist/examples/local.js', 'dist/examples/protocol-modes.js', 'examples/README.md', 'dist/examples/live/commands.js', 'dist/examples/live/ready.js', 'dist/examples/live/notes-handler.js', 'examples/live/README.md', 'docs/API.md', 'docs/TUTORIAL.md', 'docs/SESSIONS.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md']) {
    assert.ok(files.includes(required), `Missing package file: ${required}`);
  }
  for (const file of files) {
    assert.ok(/^(dist\/|examples\/|docs\/(API|TUTORIAL|SIGNERS|RECOVERY|NIP-CD|INTEROPERABILITY|KEYS|STORAGE|SESSIONS|RELAYS|ACCESS|PUBLIC)\.md$|package\.json$|README\.md$|ARCHITECTURE\.md$|THIRD_PARTY_NOTICES\.md$|LICENSE$|SECURITY\.md$|CONTRIBUTING\.md$)/.test(file), `Unexpected package file: ${file}`);
    assert.ok(!/(^|\/)(test|fixtures|node_modules|\.git)(\/|$)|\.sqlite|\.db$|\.env|\.identity\.json$|\.tgz$/.test(file), `Forbidden package file: ${file}`);
  }
  run('tar', ['-xzf', join(scratch, manifest.filename), '-C', scratch]);
  const consumer = join(scratch, 'consumer'), modules = join(consumer, 'node_modules');
  await mkdir(modules, { recursive: true });
  const packed = join(modules, 'chirli');
  await rename(join(scratch, 'package'), packed);
  assert.deepEqual(await readFile(join(packed, 'LICENSE')), await readFile(join(root, 'LICENSE')));
  // Use the already installed, locked dependencies. No registry access or pretend clean install.
  for (const dependency of ['nostr-tools', 'ws', 'qrcode-generator', '@types']) {
    await symlink(join(root, 'node_modules', dependency), join(modules, dependency), 'dir');
  }
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { allowlist as inboundAllowlist, requestTiming, Bot, nsecSigner, bunkerSigner, generateSecretKey } from 'chirli';
import * as chirli from 'chirli';
assert.equal('Client' in chirli, false);
const wire = {
  query: async () => [], publish: async () => {},
  subscribe: () => ({ready: Promise.resolve(),close(){}}),close(){},
};
for (const mode of ['nip4e', 'nip17']) {
  const signer = nsecSigner(generateSecretKey());
  const bot = new Bot({mode, signer, inboundPolicy:inboundAllowlist([]), database:':memory:', transport:wire, relays:['ws://unused.invalid']});
  bot.use(requestTiming({onTiming:()=>{}}));
  bot.command({command:'ping',scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async ctx => { await ctx.reply('pong'); });
  await bot.start();
  assert.equal(bot.mode,mode);
  assert.equal(bot.pubkey.length,64);
  assert.equal(bot.history(bot.pubkey).coverage,'local-only');
  await bot.close();
  await signer.close();
}
assert.throws(()=>bunkerSigner('invalid'),/Invalid bunker/);
await assert.rejects(import('chirli/src/client.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
`);
  run(process.execPath, ['consumer.mjs'], consumer);
  await writeFile(join(consumer, 'consumer.ts'), `
import { allowlist as inboundAllowlist, requestTiming, Bot, nsecSigner, generateSecretKey, type Context, type ProtocolMode, type Transport, type HistoryPage, type HistorySyncResult, type Signer, type BotCommandDefinition, type KeyRotationOptions, type EncryptionKeyStatus, sqliteMessageStorage, type MessageStorage, type SenderAllowlist, DEFAULT_DM_RELAYS, RelayError, type RelayErrorCode, type MetadataCacheOptions, type KeySyncOptions } from 'chirli';
const metadataCache:MetadataCacheOptions={ttlMs:600000,negativeTtlMs:30000,maxStaleMs:86400000,maxEntries:512};
const keySync:KeySyncOptions={timeoutMs:30000};
const relayCode:RelayErrorCode='RELAY_CONNECT_TIMEOUT';
const safeError=new RelayError('Relay connection timeout',{relay:'wss://relay.invalid/private?token=hidden',operation:'connect',code:relayCode});
const defaults:readonly string[]=DEFAULT_DM_RELAYS;
const noKey=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:'});
const mode: ProtocolMode = 'nip17';
const allowlist:SenderAllowlist=[];
const bot = new Bot<{count:number}>({mode, allowlist, signer:nsecSigner(generateSecretKey()), database:':memory:', storageKey:generateSecretKey(), relays:['ws://unused.invalid']});
bot.use(requestTiming({onTiming:metric=>{const outcome:'success'|'failure'=metric.outcome;void outcome;}}));
const policy=inboundAllowlist([]);
bot.command({command:'ping',scopes:['kind:14'],args:[{name:'text',type:'text',required:false,label:'Text'}]}, async (ctx, { text }) => {const count = await ctx.session.getItem('count') ?? 0; ctx.session.setItem('count', count + (text?.length ?? 1));const page:HistoryPage=ctx.history({limit:2});await ctx.reply(String(page.messages.length));});
const page: HistoryPage = bot.history(bot.pubkey);
const rotation:KeyRotationOptions={intervalMs:86400000,retainLegacyKeys:5};
const keyStatus:EncryptionKeyStatus=bot.encryptionKeys();
const messageStorage:MessageStorage={insert(){return true;},query(){return [];},updateState(){}};
const custom=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',messageStorage});await custom.close();
const sqliteMessages=sqliteMessageStorage(':memory:');
const sqliteClient=new Bot({signer:nsecSigner(generateSecretKey()),database:':memory:',messageStorage:sqliteMessages});await sqliteClient.close();sqliteMessages.close();
const definition={command:'typed',scopes:['kind:14'],title:'Typed',description:'Type consumer only',args:[{name:'n',type:'number',required:true,label:'N'}]} as const satisfies BotCommandDefinition;
bot.command(definition, async (ctx, { n }) => { await ctx.reply(String(n + 1n)); });
const recover: () => Promise<HistorySyncResult[]> = () => bot.syncHistory();
`);
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', 'consumer.ts'], consumer);
  for (const name of ['commands', 'history', 'session', 'ai-handler', 'protocol-modes', 'signers', 'nipcd', 'interop', 'rotation', 'storage', 'allowlist', 'key-sync', 'local', 'public', 'async-reply']) {
    run(process.execPath, [join(packed, 'dist/examples', `${name}.js`)], consumer);
  }
  for (const name of ['setup','commands','echo','session','notes']) run(process.execPath,[join(packed,'dist/examples/live',`${name}.js`),'--help'],consumer,{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1'});
  console.log(`Package check passed: chirli@${manifest.version}; ${files.length} files; ESM exports, TypeScript consumer and 15 compiled offline/loopback demos + 5 live CLI help checks; no registry access.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
