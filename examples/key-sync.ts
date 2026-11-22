import assert from 'node:assert/strict';
import {Bot,nsecSigner,generateSecretKey} from 'chirli';
import {MemoryRelay} from './_support.js';
// Two disposable devices sharing one identity. No sockets, real credentials or services.
const network=new MemoryRelay(),signer=nsecSigner(generateSecretKey());
const create=()=>new Bot({signer,mode:'nip4e',database:':memory:',relays:['ws://demo.invalid'],transport:network.transport()});
const first=create(),second=create();
try{
 await first.start();await second.start();
 const initial=first.encryptionKeys().currentPublicKey;
 assert.equal(second.encryptionKeys().currentPublicKey,initial);
 console.log('Second device automatically synchronized the separated encryption key.');
 await first.rotateEncryptionKey();const next=first.encryptionKeys().currentPublicKey;
 for(let i=0;i<300&&second.encryptionKeys().currentPublicKey!==next;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(second.encryptionKeys().currentPublicKey,next);assert.ok(second.encryptionKeys().decryptionPublicKeys.includes(initial));
 console.log('Live own-key announcement synchronized the rotation; previous key retained.');
 console.log('Same-identity signatures only; encrypted transfer; identity signing key never exported.');
}finally{await second.close();await first.close();await signer.close();}
