import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type EventTemplate } from 'nostr-tools';
import { WebSocketTransport } from '../src/index.js';
import { testRelay } from './relay.js';
/** Real encrypted NIP-46 RPC over a local relay; every key here is disposable. */
export async function mockBunker() {
  const relay = await testRelay(), transportSecret = generateSecretKey(), accountSecret = generateSecretKey();
  const transportPubkey = getPublicKey(transportSecret), accountPubkey = getPublicKey(accountSecret), wire = new WebSocketTransport();
  const methods: string[] = [], authorized = new Set<string>(), seen = new Set<string>();
  let paused: string | undefined, tamper = false, auth = false;
  const encrypt = (value: string, secret: Uint8Array, peer: string) => nip44.v2.encrypt(value, nip44.v2.utils.getConversationKey(secret,peer));
  const decrypt = (value: string, secret: Uint8Array, peer: string) => nip44.v2.decrypt(value, nip44.v2.utils.getConversationKey(secret,peer));
  const sub = wire.subscribe([relay.url], {kinds:[24133],'#p':[transportPubkey],limit:0}, event => {
    if(!verifyEvent(JSON.parse(JSON.stringify(event))) || seen.has(event.id))return;seen.add(event.id);
    void (async()=>{
      const request=JSON.parse(decrypt(event.content,transportSecret,event.pubkey));
      methods.push(request.method);
      const respond = (result:string,error?:string) => wire.publish([relay.url],finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',event.pubkey]],content:encrypt(JSON.stringify({id:request.id,result,...(error?{error}:{})}),transportSecret,event.pubkey)},transportSecret));
      if(request.method===paused)return;
      if(request.method==='connect'){
        if(request.params[0]!==transportPubkey || (!authorized.has(event.pubkey) && request.params[1]!=='disposable-token')) {await respond('','denied');return;}
        authorized.add(event.pubkey);await respond('ack');return;
      }
      if(!authorized.has(event.pubkey)){await respond('','not connected');return;}
      if(request.method==='switch_relays'){await respond('null');return;}
      if(request.method==='get_public_key'){await respond(accountPubkey);return;}
      if(request.method==='sign_event'){
        if(auth){await respond('auth_url','http://127.0.0.1/authorize-disposable-session');await new Promise(resolve=>setTimeout(resolve,0));}
        const template:EventTemplate=JSON.parse(request.params[0]);
        await respond(JSON.stringify(finalizeEvent(tamper?{...template,content:'altered by mock'}:template,accountSecret)));return;
      }
      if(request.method==='nip44_encrypt'){await respond(encrypt(request.params[1],accountSecret,request.params[0]));return;}
      if(request.method==='nip44_decrypt'){await respond(decrypt(request.params[1],accountSecret,request.params[0]));return;}
      await respond('','unsupported method');
    })().catch(()=>{}); // Invalid mock requests are ignored; the caller has a bounded timeout.
  });
  await sub.ready;
  return{
    relay:relay.url,accountPubkey,transportPubkey,methods,
    uri:`bunker://${transportPubkey}?relay=${encodeURIComponent(relay.url)}&secret=disposable-token`,
    pause(method?:string){paused=method;},tamper(value:boolean){tamper=value;},auth(value:boolean){auth=value;},
    async close(){sub.close();wire.close();await relay.close();},
  };
}
