import { RelayError, Nip4eCompatibilityError, SignerError, StorageEncryptionError } from 'chirli';
import { ConfigurationError } from './config.js';
export type DiagnosticLevel='warning'|'error';
const systemCodes=new Set(['ENOENT','EACCES','EPERM','ENOSPC','EROFS','EISDIR','ENOTDIR','EMFILE','ENFILE','EIO','EBUSY','ENAMETOOLONG','ERR_SQLITE_ERROR','ERR_SQLITE_NOT_OPEN','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CORRUPT','SQLITE_NOTADB','SQLITE_READONLY','SQLITE_FULL','SQLITE_CANTOPEN','SQLITE_IOERR','ERR_CRYPTO_INVALID_AUTH_TAG','ERR_OSSL_BAD_DECRYPT']);
/** Only known diagnostics are shown. Raw application errors/stacks/server text may contain secrets. */
export function diagnosticLines(error:unknown,phase:string,level:DiagnosticLevel='error'):string[]{
 let remaining=16;const seen=new Set<unknown>();
 const render=(error:unknown,depth=0):string[]=>{
 if(remaining--<=0)return[];
 const prefix=`[${level}][${phase}]`;
 if(error instanceof AggregateError){
  if(depth>=3||seen.has(error))return[`${prefix} AGGREGATE_ERROR_DETAILS_LIMITED.`];
  seen.add(error);const children=error.errors.slice(0,8);
  return[`${prefix} MULTIPLE_OPERATIONS_FAILED (${children.length} reported attempt(s)).`,...children.flatMap(child=>render(child,depth+1))];
 }
 if(error instanceof ConfigurationError)return[`${prefix} CONFIGURATION: ${error.message}`];
 if(error instanceof RelayError){
  const detail=[error.code,`relay=${error.relay}`,`operation=${error.operation}`,error.networkCode, error.statusCode===undefined?undefined:`http=${error.statusCode}`,error.closeCode===undefined?undefined:`close=${error.closeCode}`,error.eventKind===undefined?undefined:`kind=${error.eventKind}`,error.reason?`reason=${error.reason}`:undefined,error.historyReason].filter(Boolean).join(' ');
  return[`${prefix} ${detail}${level==='warning'?' — background replica/recovery warning; other relays may remain usable.':''}`];
 }
 if(error instanceof StorageEncryptionError)return[`${prefix} ${error.code}: restore the original storage key/mode or migrate explicitly; data is not reset.`];
 if(error instanceof Nip4eCompatibilityError)return[`${prefix} ${error.code}: existing encryption declaration conflicts. See docs/KEYS.md; no forced migration.`];
 if(error instanceof SignerError)return[`${prefix} ${error.code} operation=${error.operation}: check signer connectivity/permissions.`];
 if(error instanceof Error&&error.message.startsWith('nip17 requires a valid recipient kind 10050'))return[`${prefix} DM_RELAY_METADATA_MISSING: sender and bot must advertise usable kind 10050 inbox lists.`];
 const candidate=(error as {code?:unknown}|null)?.code,code=typeof candidate==='string'&&systemCodes.has(candidate)?candidate:'OPERATION_FAILED';
 const kind=error instanceof TypeError?'TypeError':error instanceof RangeError?'RangeError':error instanceof SyntaxError?'SyntaxError':'Error';
 return[`${prefix} ${code} type=${kind}. ${phase==='handler'?'Application handler failed; its raw message is withheld to avoid logging DM text.':'Check this operation; raw error text/stack is withheld to avoid exposing credentials or message text.'}`];
 };
 return render(error);
}
export function reportDiagnostic(error:unknown,phase:string,level:DiagnosticLevel='error'){for(const line of diagnosticLines(error,phase,level))console.error(line);}
