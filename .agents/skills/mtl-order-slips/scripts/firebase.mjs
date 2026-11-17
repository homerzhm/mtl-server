// Node 22. Uses a securely supplied, genuine Firebase app session.
import {readFile, writeFile, mkdir, open, lstat} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const targets = {
  dev: {project: 'mtl-service-e3e0c', region: 'northamerica-northeast1'},
  production: {project: 'mtl-service-production', region: 'northamerica-northeast2'},
};
export function target(environment) {
  if (!Object.hasOwn(targets, environment)) throw new Error('Explicit environment must be dev or production');
  return targets[environment];
}
export function checkActor(claims, project) {
  if (claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}` ||
      !claims.sub || claims.email !== 'homerzhm@gmail.com' || claims.firebase?.sign_in_provider !== 'google.com' ||
      (claims.staff !== true && claims.admin !== true) || claims.exp * 1000 <= Date.now()) {
    throw new Error('Expected a current Google Firebase Staff/Admin session for homerzhm@gmail.com in the selected project');
  }
  // This is a local preflight, not signature verification. Firebase verifies the token on every API call.
}
export async function session(environment) {
  const t = target(environment);
  const sessionFile = process.env.MTL_FIREBASE_SESSION_FILE;
  if (!sessionFile) throw new Error('Set MTL_FIREBASE_SESSION_FILE to a private Firebase app-session JSON file; CLI OAuth tokens are not accepted');
  const stat = await lstat(sessionFile);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('App-session file must be a regular file owned by this user with mode 0600');
  const signedIn = JSON.parse(await readFile(sessionFile, 'utf8'));
  if (signedIn.projectId !== t.project || typeof signedIn.apiKey !== 'string' || !signedIn.apiKey || typeof signedIn.idToken !== 'string') throw new Error('App-session projectId/apiKey/idToken missing or selected environment mismatched');
  const apiKey = signedIn.apiKey;
  const claims = JSON.parse(Buffer.from(signedIn.idToken.split('.')[1], 'base64url').toString());
  checkActor(claims, t.project);
  return {...t, uid: claims.sub, token: signedIn.idToken, apiKey};
}
export async function request(s, kind, operation, variables = {}, fetcher = fetch) {
  let url, body, headers = {'Content-Type': 'application/json'};
  if (kind === 'query' || kind === 'mutation') {
    if (kind === 'mutation' && operation !== 'CreateClient') throw new Error('Only CreateClient mutation is allowed');
    url = `https://firebasedataconnect.googleapis.com/v1/projects/${s.project}/locations/${s.region}/services/restaurant/connectors/staff-admin:execute${kind === 'query' ? 'Query' : 'Mutation'}?key=${encodeURIComponent(s.apiKey)}`;
    headers['x-firebase-auth-token'] = s.token;
    body = {operationName: operation, variables};
  } else if (kind === 'callable' && ['getBookingAvailability', 'createStaffOrder'].includes(operation)) {
    url = `https://${s.region}-${s.project}.cloudfunctions.net/${operation}`;
    headers.Authorization = `Bearer ${s.token}`;
    body = {data: variables};
  } else throw new Error('Unsupported API operation');
  const response = await fetcher(url, {method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(70000)});
  const result = await response.json();
  if (!response.ok || result.error || result.errors?.length) {
    const error = result.error ?? result.errors?.[0];
    throw new Error(`${response.status}: ${error?.status ?? ''} ${error?.message ?? 'API failed'}`);
  }
  if (kind === 'callable') {
    if (!Object.hasOwn(result, 'result') && !Object.hasOwn(result, 'data')) throw new Error('Malformed callable response; result uncertain');
    return result.result ?? result.data;
  }
  if (!Object.hasOwn(result, 'data')) throw new Error('Malformed connector response; result uncertain');
  return result.data;
}
export async function main(file) {
  const input = JSON.parse(await readFile(file, 'utf8'));
  target(input.environment); // Fail before authentication or network access if omitted.
  const s = await session(input.environment);
  if (input.kind === 'auth-check') return {project: s.project, uid: s.uid, email: 'homerzhm@gmail.com'};
  const mutating = input.kind === 'mutation' || input.operation === 'createStaffOrder';
  if (!mutating) return request(s, input.kind, input.operation, input.variables);
  if (input.approved !== true || !input.journalPath) throw new Error('A user-approved preview and private journalPath are required');
  if (!input.variables?.id) throw new Error('Stable UUID required');
  const journalPath = resolve(input.journalPath);
  await mkdir(dirname(journalPath), {recursive: true, mode: 0o700});
  // A crash leaves the lock for deliberate inspection rather than permitting concurrent writes.
  const lock = await open(journalPath + '.lock', 'wx', 0o600);
  try {
    const snapshot = {project: s.project, actorUid: s.uid, kind: input.kind, operation: input.operation, variables: input.variables};
    let prior;
    try { prior = JSON.parse(await readFile(journalPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (prior) {
      if (JSON.stringify(prior.snapshot) !== JSON.stringify(snapshot)) throw new Error('Journal actor/project/payload mismatch; preserve original request');
      if (prior.state === 'succeeded') return prior.result;
      if (input.retryAuthorized !== true) throw new Error('Previous outcome may be uncertain; reconcile reads and get explicit retry approval');
    }
    await writeFile(journalPath, JSON.stringify({snapshot, state: 'uncertain', attemptedAt: new Date().toISOString()}, null, 2), {mode: 0o600});
    const result = await request(s, input.kind, input.operation, input.variables);
    await writeFile(journalPath, JSON.stringify({snapshot, state: 'succeeded', result}, null, 2), {mode: 0o600});
    return result;
  } finally {
    await lock.close();
    const {unlink} = await import('node:fs/promises');
    await unlink(journalPath + '.lock');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {console.error(e.message); process.exitCode = 1;});
}
