import { DEFAULT_DISCOVERY_RELAYS, DEFAULT_DM_RELAYS, DEFAULT_READ_RELAYS, DEFAULT_WRITE_RELAYS } from 'chirli';
export class ConfigurationError extends Error {}
export type LiveConfiguration = {
  nsec?:string;
  storageKey?:Uint8Array;relays:string[];readRelays:string[];writeRelays:string[];discoveryRelays:string[];database:string;mode:'nip17'|'nip4e';
  allowlist?:string[];rotation?:{intervalMs:number;retainLegacyKeys:number;legacyMaxAgeMs?:number};
  outboxRetryMs:number;timing:boolean;relayTimeoutMs:number|undefined;keySync:false|{timeoutMs:number};
} & ({bunker:string;bunkerClientKey:Uint8Array}|{bunker?:undefined;bunkerClientKey?:Uint8Array});
export function relayURLs(value:string):string[]{
  const relays=[...new Set(value.split(',').map(x=>x.trim()).filter(Boolean))];
  if(!relays.length||!relays.every(value=>{
    try{const url=new URL(value);return ['ws:','wss:'].includes(url.protocol)&&!!url.hostname&&!url.username&&!url.password&&!url.hash&&!/[\r\n"'\\]/.test(value);}catch{return false;}
  }))throw new ConfigurationError('CHIRLI_RELAYS must contain comma-separated ws:// or wss:// URLs.');
  return relays;
}
export function identityList(value:string):string[]{
  const keys=value.trim()===''?[]:value.split(',').map(x=>x.trim());
  if(!keys.every(x=>/^[0-9a-f]{64}$/.test(x)))throw new ConfigurationError('CHIRLI_ALLOWLIST requires lowercase hex identity public keys, not npub or encryption keys.');
  return [...new Set(keys)];
}
function bytes(value:string|undefined,name:string):Uint8Array{
  if(!value||! /^[0-9a-fA-F]{64}$/.test(value))throw new ConfigurationError(`${name} must contain exactly 32 bytes in hex.`);
  return new Uint8Array(Buffer.from(value,'hex'));
}
function positive(value:string|undefined,name:string,fallback?:number):number{
  if(value===undefined&&fallback!==undefined)return fallback;
  if(!value||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw new ConfigurationError(`${name} must be a positive integer.`);
  return Number(value);
}
export function configuration(env:NodeJS.ProcessEnv):LiveConfiguration{
  const nsec=env.CHIRLI_NSEC?.trim()||undefined,bunker=env.CHIRLI_BUNKER?.trim()||undefined;
  if(nsec&&bunker)throw new ConfigurationError('Set only one of CHIRLI_NSEC or CHIRLI_BUNKER; omit both to reuse or generate a local identity.');
  if(bunker&&env.CHIRLI_BUNKER_CLIENT_KEY===undefined)throw new ConfigurationError('CHIRLI_BUNKER_CLIENT_KEY is required with CHIRLI_BUNKER.');
  const bunkerConfig=bunker===undefined
    ? {bunker,bunkerClientKey:env.CHIRLI_BUNKER_CLIENT_KEY===undefined?undefined:bytes(env.CHIRLI_BUNKER_CLIENT_KEY,'CHIRLI_BUNKER_CLIENT_KEY')}
    : {bunker,bunkerClientKey:bytes(env.CHIRLI_BUNKER_CLIENT_KEY,'CHIRLI_BUNKER_CLIENT_KEY')};
  const mode=env.CHIRLI_MODE??'nip17';if(mode!=='nip17'&&mode!=='nip4e')throw new ConfigurationError('CHIRLI_MODE must be nip17 or nip4e.');
  const database=env.CHIRLI_DATABASE??'.chirli/bot.sqlite';if(!database.trim()||database===':memory:'||/[\r\n\0]/.test(database))throw new ConfigurationError('CHIRLI_DATABASE must be a persistent file path for these live bots.');
  let rotation:LiveConfiguration['rotation'];
  if(env.CHIRLI_ROTATION_DAYS!==undefined){
    if(mode!=='nip4e')throw new ConfigurationError('CHIRLI_ROTATION_DAYS requires CHIRLI_MODE=nip4e.');
    const intervalMs=positive(env.CHIRLI_ROTATION_DAYS,'CHIRLI_ROTATION_DAYS')*86_400_000;
    const retainLegacyKeys=positive(env.CHIRLI_LEGACY_KEYS,'CHIRLI_LEGACY_KEYS',5);
    const legacyMaxAgeMs=env.CHIRLI_LEGACY_MAX_DAYS===undefined?undefined:positive(env.CHIRLI_LEGACY_MAX_DAYS,'CHIRLI_LEGACY_MAX_DAYS')*86_400_000;
    if(!Number.isSafeInteger(intervalMs)||intervalMs>Number.MAX_SAFE_INTEGER/2||retainLegacyKeys>100||(legacyMaxAgeMs!==undefined&&!Number.isSafeInteger(legacyMaxAgeMs)))throw new ConfigurationError('Rotation settings exceed supported bounds.');
    rotation={intervalMs,retainLegacyKeys,legacyMaxAgeMs};
  }else if(env.CHIRLI_LEGACY_KEYS!==undefined||env.CHIRLI_LEGACY_MAX_DAYS!==undefined)throw new ConfigurationError('Set CHIRLI_ROTATION_DAYS when configuring automatic legacy retention.');
  const outboxRetryMs=positive(env.CHIRLI_OUTBOX_RETRY_MS,'CHIRLI_OUTBOX_RETRY_MS',30_000);
  if(outboxRetryMs<1000||outboxRetryMs>2_147_483_647)throw new ConfigurationError('CHIRLI_OUTBOX_RETRY_MS must be in 1000..2147483647.');
  const relayTimeoutMs=env.CHIRLI_RELAY_TIMEOUT_MS===undefined?undefined:positive(env.CHIRLI_RELAY_TIMEOUT_MS,'CHIRLI_RELAY_TIMEOUT_MS',5000);
  if(relayTimeoutMs!==undefined&&(relayTimeoutMs<100||relayTimeoutMs>120_000))throw new ConfigurationError('CHIRLI_RELAY_TIMEOUT_MS must be in 100..120000.');
  if(env.CHIRLI_KEY_SYNC!==undefined&&!['0','1'].includes(env.CHIRLI_KEY_SYNC))throw new ConfigurationError('CHIRLI_KEY_SYNC must be 0 or 1.');
  const syncTimeout=positive(env.CHIRLI_KEY_SYNC_TIMEOUT_MS,'CHIRLI_KEY_SYNC_TIMEOUT_MS',30000);if(syncTimeout<100||syncTimeout>120000)throw new ConfigurationError('CHIRLI_KEY_SYNC_TIMEOUT_MS must be in 100..120000.');
  const common=env.CHIRLI_RELAYS?.trim()?relayURLs(env.CHIRLI_RELAYS):undefined;
  return{nsec,...bunkerConfig,storageKey:env.CHIRLI_STORAGE_KEY?.trim()?bytes(env.CHIRLI_STORAGE_KEY.trim(),'CHIRLI_STORAGE_KEY'):undefined,
    relays:env.CHIRLI_DM_RELAYS===undefined?(common??[...DEFAULT_DM_RELAYS]):relayURLs(env.CHIRLI_DM_RELAYS),
    readRelays:env.CHIRLI_READ_RELAYS===undefined?(common??[...DEFAULT_READ_RELAYS]):env.CHIRLI_READ_RELAYS.trim()===''?[]:relayURLs(env.CHIRLI_READ_RELAYS),
    discoveryRelays:env.CHIRLI_DISCOVERY_RELAYS===undefined?(common??[...DEFAULT_DISCOVERY_RELAYS]):env.CHIRLI_DISCOVERY_RELAYS.trim()===''?[]:relayURLs(env.CHIRLI_DISCOVERY_RELAYS),
    writeRelays:env.CHIRLI_WRITE_RELAYS===undefined?(common??[...DEFAULT_WRITE_RELAYS]):relayURLs(env.CHIRLI_WRITE_RELAYS),database,mode,rotation,outboxRetryMs,relayTimeoutMs,keySync:env.CHIRLI_KEY_SYNC==='0'?false:{timeoutMs:syncTimeout},timing:env.CHIRLI_TIMING==='1',
    allowlist:env.CHIRLI_ALLOWLIST===undefined?undefined:identityList(env.CHIRLI_ALLOWLIST)};
}
