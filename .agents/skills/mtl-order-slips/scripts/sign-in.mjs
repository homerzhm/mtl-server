// Local interactive sign-in; creates no clients/orders or Auth accounts.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {target, checkActor} from './firebase.mjs';

const [environment, outputFile] = process.argv.slice(2);
const t = target(environment);
if (!outputFile) throw new Error('Usage: node sign-in.mjs <dev|production> <private-session-file>');
const cli = process.env.MTL_FIREBASE_CLI;
if (!cli) throw new Error('Set MTL_FIREBASE_CLI to the installed firebase-tools/lib/bin/firebase.js');
const require = createRequire(resolve(cli));
const cliAuth = require('../auth.js');
const account = cliAuth.getAllAccounts().find(a => a.user.email === 'homerzhm@gmail.com');
if (!account) throw new Error('Sign in to Firebase CLI as homerzhm@gmail.com to read project configuration');
cliAuth.setActiveAccount({project: t.project, projectId: t.project, nonInteractive: true}, account);
const {Client} = require('../apiv2.js');
const admin = new Client({urlPrefix: 'https://identitytoolkit.googleapis.com', apiVersion: 'admin/v2', auth: true});
const config = await admin.get(`projects/${t.project}/config`);
if (!config.body.authorizedDomains?.includes('localhost')) throw new Error('Dev/project Auth does not authorize localhost; no configuration has been changed');
const apps = require('../management/apps.js');
const installed = await apps.listFirebaseApps(t.project, apps.AppPlatform.IOS);
if (!installed.length) throw new Error('No iOS app found');
const ios = await apps.getAppConfig(installed[0].appId, apps.AppPlatform.IOS);
const plist = Buffer.from(ios.configFileContents, 'base64').toString();
const apiKey = plist.match(/<key>API_KEY<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
if (!apiKey) throw new Error('No app API key found');
const appConfig = {apiKey, projectId: t.project, authDomain: `${t.project}.firebaseapp.com`};
const nonce = randomBytes(24).toString('hex');
const pagePath = `/${nonce}`;
const port = 8793;
const origin = `http://localhost:${port}`;
const html = `<!doctype html><html><meta charset="utf-8"><title>MTL ${environment} sign-in</title>
<style>body{font:18px system-ui;max-width:640px;margin:80px auto;padding:24px;color:#222}button{font:inherit;padding:14px 20px}p{line-height:1.5}#status{white-space:pre-wrap}</style>
<h1>MTL ${environment} sign-in</h1><p>Sign in as <strong>homerzhm@gmail.com</strong> to ${t.project}.</p>
<p>This connects the order-slip skill. It does not create clients or orders.</p><button id="login">Sign in with Google</button><p id="status">Ready to sign in.</p>
<script type="module">
import {initializeApp} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,setPersistence,inMemoryPersistence,signOut} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
// Preserve the SDK flow while disabling new-user creation in the provider exchange.
const originalFetch=window.fetch.bind(window);
window.fetch=(input,options)=>{
 const url=typeof input==='string'?input:input.url;
 if(url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp')&&options?.body){
  const body=JSON.parse(options.body);body.autoCreate=false;options={...options,body:JSON.stringify(body)};
 }
 return originalFetch(input,options);
};
const auth=getAuth(initializeApp(${JSON.stringify(appConfig)}));await setPersistence(auth,inMemoryPersistence);
const status=document.getElementById('status'),button=document.getElementById('login');
button.onclick=async()=>{button.disabled=true;status.textContent='Complete Google sign-in in the popup.';
 try{
  const provider=new GoogleAuthProvider();provider.setCustomParameters({login_hint:'homerzhm@gmail.com',prompt:'select_account'});
  const {user}=await signInWithPopup(auth,provider);
  if(user.email!=='homerzhm@gmail.com')throw new Error('Please select homerzhm@gmail.com.');
  const response=await originalFetch('${pagePath}/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:await user.getIdToken(true)})});
  const result=await response.json();if(!response.ok)throw new Error(result.error);
  status.textContent='Connected to ${environment} as homerzhm@gmail.com. You can return to Codex.';
  button.textContent='Connected';await signOut(auth);
 }catch(e){status.textContent=e.message;button.disabled=false;}
};
</script></html>`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== `localhost:${port}`) {res.writeHead(403).end(); return;}
  if (req.method === 'GET' && req.url === pagePath) {res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  if (req.method !== 'POST' || req.url !== pagePath+'/session' || req.headers.origin !== origin) {res.writeHead(404).end();return;}
  res.setHeader('Content-Type','application/json');
  try {
    let body='';for await(const chunk of req){body+=chunk;if(body.length>32768)throw new Error('Request too large');}
    const {idToken}=JSON.parse(body);
    // Firebase verifies the token before it is saved; decoded claims alone are not authentication.
    const verified=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken}),signal:AbortSignal.timeout(30000)});
    const data=await verified.json();
    if(!verified.ok||data.users?.[0]?.email!=='homerzhm@gmail.com')throw new Error('Firebase session verification failed');
    const claims=JSON.parse(Buffer.from(idToken.split('.')[1],'base64url').toString());checkActor(claims,t.project);
    const path=resolve(outputFile);await mkdir(dirname(path),{recursive:true,mode:0o700});
    // Replace only a regular owned file, never follow a pre-existing symlink.
    const {lstat,chmod}=await import('node:fs/promises');
    try{const stat=await lstat(path);if(!stat.isFile()||stat.uid!==process.getuid())throw new Error('Unsafe session output file');await chmod(path,0o600);}catch(e){if(e.code!=='ENOENT')throw e;}
    await writeFile(path,JSON.stringify({...appConfig,idToken}),{mode:0o600});
    res.end(JSON.stringify({ok:true}));console.log(JSON.stringify({connected:true,project:t.project,email:claims.email,uid:claims.sub,sessionFile:path}));
    setTimeout(()=>server.close(),1000);
  } catch(e) {res.writeHead(400).end(JSON.stringify({error:e.message}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Open ${origin}${pagePath}`));
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
setTimeout(()=>{console.log('Sign-in window expired');server.close();},10*60*1000).unref();
