import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {root} from './config.mjs';
const require=createRequire(`${root}/functions/package.json`);

// Operator-only authentication. Runtime Functions retain their dedicated ADC/IAM
// identities. Firebase CLI mode reuses an existing login; no credentials are saved.
export function operatorAuth(t) {
  const mode=process.env.MTL_RELEASE_AUTH??'adc';
  if(mode==='adc') {
    const {GoogleAuth}=require('google-auth-library');
    return new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
  }
  if(mode!=='firebase'||!process.env.MTL_FIREBASE_CLI) throw new Error('Choose adc or firebase operator auth; Firebase mode requires MTL_FIREBASE_CLI');
  const base=resolve(dirname(process.env.MTL_FIREBASE_CLI),'..');
  const cliRequire=createRequire(resolve(base,'auth.js'));
  const cliAuth=cliRequire(resolve(base,'auth.js'));
  const account=cliAuth.getProjectDefaultAccount(resolve(root))??cliAuth.getGlobalDefaultAccount();
  if(!account) throw new Error('No existing Firebase CLI login for release operations');
  if(t) {
    const sqlUser=process.env[`MTL_RELEASE_${t.name.toUpperCase()}_SQL_USER`];
    if(sqlUser&&sqlUser!==account.user.email) throw new Error('Firebase CLI account does not match the release SQL user');
  }
  cliAuth.setActiveAccount({project:t?.project,projectId:t?.project,nonInteractive:true},account);
  const {FBToolsAuthClient}=cliRequire(resolve(base,'gcp/cloudsql/fbToolsAuthClient.js'));
  return new FBToolsAuthClient();
}
