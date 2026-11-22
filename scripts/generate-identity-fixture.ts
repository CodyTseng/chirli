import { localIdentity, localNip17Identity } from '../src/protocol.js';
import { writeFile } from 'node:fs/promises';
import { getPublicKey } from '../src/index.js';
import { upstreamEnvelope } from './upstream-envelope.js';
const path = process.argv[2];
if (!path) throw new Error('Pass the path to the PsstPsst src/services/crypto/nip17-gift-wrap.ts source file.');
const upstream=await upstreamEnvelope(path),sender=localIdentity(),recipient=localNip17Identity();
const wrapped=await upstream.functions.createGiftWrappedMessage({
  rumorTemplate:{kind:14,created_at:1700000001,tags:[['p',recipient.pubkey],['ms','321']],content:'PsstPsst to an identity-key recipient'},
  senderIdentityPubkey:sender.pubkey,senderEncPrivkey:sender.encryptionKey,senderEncPubkey:getPublicKey(sender.encryptionKey),
  recipientIdentityPubkey:recipient.pubkey,recipientEncPubkey:recipient.pubkey,signSeal:sender.sign,
});
await writeFile(new URL('../test/fixtures/identity-interop.json',import.meta.url),JSON.stringify({
  provenance:{path:'src/services/crypto/nip17-gift-wrap.ts',sha256:upstream.sha256,note:'Unchanged extracted PsstPsst envelope functions with equivalent software-key primitives; disposable test keys only.'},
  sender:{pubkey:sender.pubkey,encryptionSecret:Buffer.from(sender.encryptionKey).toString('hex')},
  recipient:{pubkey:recipient.pubkey,identitySecret:Buffer.from(recipient.encryptionKey).toString('hex')},...wrapped,
},null,2)+'\n',{flag:'wx'});
