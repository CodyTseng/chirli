import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { generateSecretKey, getPublicKey } from 'chirli';
import { npubEncode, nsecEncode } from 'nostr-tools/nip19';
import { ConfigurationError, configuration, identityList } from './config.js';
const usage=`Create a NEW bot identity and encrypted-storage key, without connecting to any relay.
Usage: npm run bot:init [-- --relays wss://YOUR_RELAY,wss://ANOTHER_RELAY]
Omitting relay flags uses separate PsstPsst DM/read/write defaults; initialization itself makes no network calls.
Options: --dm-relays URL,URL  --read-relays URL,URL  --write-relays URL,URL
         --file .env.chirli  --database .chirli/bot.sqlite  --allow HEX_IDENTITY,HEX_IDENTITY
         --mode nip4e  --rotation-days 30
Omit --allow for all authenticated senders; --allow "" denies all incoming senders.
An existing config file is never overwritten. Secrets are written with mode 0600, not printed.`;
try{
  const args=process.argv.slice(2);if(args.includes('--help'))console.log(usage);
  else{
    const flags=new Map<string,string>();
    for(let i=0;i<args.length;i+=2){if(!['--relays','--dm-relays','--read-relays','--write-relays','--file','--database','--allow','--mode','--rotation-days'].includes(args[i])||args[i+1]===undefined||args[i+1].startsWith('--')||flags.has(args[i]))throw new ConfigurationError(usage);flags.set(args[i],args[i+1]);}
    const mode=flags.get('--mode')??'nip17';
    if(mode!=='nip17'&&mode!=='nip4e')throw new ConfigurationError('--mode must be nip17 or nip4e.');
    const days=flags.get('--rotation-days');if(days!==undefined&&(mode!=='nip4e'||!/^\d+$/.test(days)||!Number.isSafeInteger(Number(days)*86_400_000)||Number(days)<1))throw new ConfigurationError('--rotation-days requires nip4e and a positive whole-day interval.');
    const file=resolve(flags.get('--file')??'.env.chirli');if(!basename(file).startsWith('.env'))throw new ConfigurationError('Use a config filename starting with .env so it is excluded from source/package checks.');
    const database=flags.get('--database')??'.chirli/bot.sqlite';if(!database.trim()||database===':memory:'||/[\r\n\0]/.test(database))throw new ConfigurationError('--database must be a persistent file path.');
    const allow=flags.has('--allow')?identityList(flags.get('--allow')!):undefined;
    const secret=generateSecretKey(),pubkey=getPublicKey(secret),storageKey=Buffer.from(generateSecretKey()).toString('hex');
    const fields:Record<string,string>={CHIRLI_NSEC:nsecEncode(secret),CHIRLI_STORAGE_KEY:storageKey,CHIRLI_DATABASE:database,CHIRLI_MODE:mode};
    if(allow!==undefined)fields.CHIRLI_ALLOWLIST=allow.join(',');if(days!==undefined)fields.CHIRLI_ROTATION_DAYS=days;
    for(const [flag,key] of [['--relays','CHIRLI_RELAYS'],['--dm-relays','CHIRLI_DM_RELAYS'],['--read-relays','CHIRLI_READ_RELAYS'],['--write-relays','CHIRLI_WRITE_RELAYS']])if(flags.has(flag))fields[key]=flags.get(flag)!;
    const config=configuration(fields);
    delete fields.CHIRLI_RELAYS;fields.CHIRLI_DM_RELAYS=config.relays.join(',');fields.CHIRLI_READ_RELAYS=config.readRelays.join(',');fields.CHIRLI_WRITE_RELAYS=config.writeRelays.join(','); // Keep setup and runtime validation consistent before writing credentials.
    writeFileSync(file,'# Private bot credentials. Keep this file and the database across restarts.\n'+Object.entries(fields).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{flag:'wx',mode:0o600});
    console.log(`Created ${file} with a NEW identity; no relay contacted.`);
    console.log(`Bot npub: ${npubEncode(pubkey)}\nBot identity: ${pubkey}`);
    console.log(`Incoming policy: ${allow===undefined?'all authenticated senders':allow.length===0?'deny all':`${allow.length} allowed identities`}.`);
    console.log('Next: npm run bot:commands (uses .env.chirli). For another config path, use node --env-file=PATH dist/examples/live/commands.js. Back up config and database together.');
  }
}catch(error){console.error(error instanceof ConfigurationError?error.message:(error as NodeJS.ErrnoException).code==='EEXIST'?'Config already exists; refusing to replace your identity or storage key.':'Setup failed. Check the target path and file permissions.');process.exitCode=1;}
