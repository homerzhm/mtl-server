// Local presentation only. Never invokes Firebase or writes business data.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statuses = new Set(['ready','already-exists','duplicate-upload','needs-clarification','missing-product']);
const list = values => `<ul>${values.map(v=>`<li>${escape(v)}</li>`).join('')}</ul>`;
function imageType(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'image/gif';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  throw new Error('Preview must be PNG, JPEG, GIF or WebP; convert HEIC before rendering');
}
export async function renderBatchReview(manifest) {
  if(!['dev','production'].includes(manifest.environment))throw new Error('Explicit dev or production environment required');
  if(!manifest.batchId||!Number.isInteger(manifest.revision)||manifest.revision<1||!manifest.actorEmail)throw new Error('Batch identity, positive review revision and actor email required');
  if(!Array.isArray(manifest.entries)||!manifest.entries.length||!Array.isArray(manifest.summary))throw new Error('Entries and final action summary required');
  const ids=new Set(),cards=[];
  for(const entry of manifest.entries){
    if(!entry.id||ids.has(String(entry.id))||!entry.filename||!statuses.has(entry.status))throw new Error('Each entry needs a unique review ID, filename and valid status');
    ids.add(String(entry.id));
    if(!Array.isArray(entry.fields)||!entry.fields.length)throw new Error(`Missing fields for entry ${entry.id}`);
    let photo='<p class="warning">Image unavailable — resolve before approval.</p>';
    if(entry.imagePath){
      if(!isAbsolute(entry.imagePath))throw new Error('Image paths must be absolute');
      const bytes=await readFile(entry.imagePath),mime=imageType(bytes);
      photo=`<img src="data:${mime};base64,${bytes.toString('base64')}" alt="${escape(entry.id)} — ${escape(entry.filename)}">`;
    }else if(entry.status==='ready')throw new Error('A ready entry must have a source preview image');
    const rows=entry.fields.map(field=>{
      if(!field.field||!Object.hasOwn(field,'value')||![null,'High','Medium','Low'].includes(field.confidence))throw new Error('Fields need a value and High/Medium/Low or null confidence');
      const cls=field.confidence==='Low'?'low':field.confidence==='Medium'?'medium':'';
      return `<tr class="${cls}"><th scope="row">${escape(field.field)}</th><td>${escape(field.value)}</td><td>${escape(field.confidence??'—')}</td><td>${escape(field.source)}${field.evidence?`<br><small>${escape(field.evidence)}</small>`:''}</td></tr>`;
    }).join('');
    const section=(title,values)=>values?.length?`<h3>${title}</h3>${list(values)}`:'';
    const roastBlockCallout = section('Cut extra roast block', entry.cutExtraRoastBlocks);
    cards.push(`<article><h2>${escape(entry.id)} · ${escape(entry.filename)} <span class="status">${escape(entry.status)}</span></h2><div class="pair"><figure>${photo}<figcaption>Source image · ${escape(entry.filename)}</figcaption></figure><div class="data">${roastBlockCallout ? `<section class="roast-block-callout">${roastBlockCallout}</section>` : ''}<table><thead><tr><th>Field</th><th>Proposed value</th><th>Confidence</th><th>Source / evidence</th></tr></thead><tbody>${rows}</tbody></table>${section('Checks',entry.checks)}${section('Proposed actions',entry.actions)}${section('Needs clarification',entry.questions)}</div></div></article>`);
  }
  const project=manifest.environment==='dev'?'mtl-service-e3e0c':'mtl-service-production';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>MTL batch review · ${escape(manifest.batchId)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:#18212b;font:16px/1.5 system-ui,sans-serif}header,main,footer{max-width:1500px;margin:auto;padding:24px}header p{margin:6px 0}h1{margin:0;font-size:30px}article{background:white;border:1px solid #ccd3dc;border-radius:12px;margin-bottom:24px;padding:20px}h2{margin:0 0 18px;font-size:20px;overflow-wrap:anywhere}.status{display:inline-block;font-size:13px;background:#e8edf3;border-radius:5px;padding:3px 8px}.pair{display:grid;grid-template-columns:minmax(260px,1fr) minmax(480px,1.4fr);gap:24px;align-items:start}figure{margin:0;background:#f6f7f9;padding:12px;border-radius:8px}img{display:block;width:100%;max-height:850px;object-fit:contain}figcaption{font-size:13px;color:#526070;margin-top:8px}.data{min-width:0;overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dce1e8;overflow-wrap:anywhere}thead{background:#edf1f5}small{color:#526070}.medium{background:#fff5d9}.low,.warning{background:#ffe6e2}h3{font-size:16px;margin:20px 0 6px}ul{padding-left:22px}footer{background:#fff;border-top:3px solid #344b68;padding-bottom:48px}.notice{padding:12px;background:#e7eef8;border-radius:6px}@media(max-width:850px){.pair{grid-template-columns:1fr}header,main,footer{padding:16px}article{padding:14px}}@media print{body{background:white}article{break-inside:avoid}.pair{grid-template-columns:1fr 1.4fr}footer{break-before:page}}
.roast-block-callout{margin-bottom:16px;padding:12px 16px;border-left:4px solid #315c91;border-radius:6px;background:#e7eef8}.roast-block-callout h3{margin:0 0 4px}.roast-block-callout ul{margin:0}
</style></head><body><header><h1>MTL order-slip batch review</h1><p><strong>${escape(manifest.environment.toUpperCase())}</strong> · ${project} · ${escape(manifest.actorEmail)}</p><p>Batch ${escape(manifest.batchId)} · Review revision ${manifest.revision} · ${manifest.entries.length} images</p><p class="notice">Review every image beside its extracted data. No changes have been made by this review. Medium and Low confidence fields are highlighted.</p></header><main>${cards.join('')}</main><footer><h2>Final batch confirmation</h2>${list(manifest.summary)}<p><strong>Return to Codex to confirm the exact selected entries and this review revision.</strong> This local review cannot create clients, orders or deposits. Unresolved critical fields need clarification or explicit exclusion first.</p></footer></body></html>`;
}
export async function main(inputPath,outputPath){
  if(!inputPath||!outputPath||!isAbsolute(inputPath)||!isAbsolute(outputPath))throw new Error('Usage: node render-batch-review.mjs /absolute/display.json /absolute/review.html');
  const manifest=JSON.parse(await readFile(inputPath,'utf8'));
  const html=await renderBatchReview(manifest);
  await mkdir(dirname(outputPath),{recursive:true,mode:0o700});
  await writeFile(outputPath,html,{mode:0o600});
  return {reviewPath:outputPath,images:manifest.entries.length,environment:manifest.environment,revision:manifest.revision};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main(...process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
