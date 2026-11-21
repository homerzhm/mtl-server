import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderBatchReview} from './render-batch-review.mjs';

const field={field:'Pickup year',value:'2026',confidence:null,source:'Inferred by rule',evidence:'Year absent; weekday agrees'};
const manifest=entries=>({batchId:'test-batch',revision:2,environment:'dev',actorEmail:'homerzhm@gmail.com',summary:['Create selected ready entries only; approval pending'],entries});
test('pairs all ten images with their own fields and puts confirmation after the last image',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mtl-batch-review-'));
  try{
    const entries=[];
    for(let i=1;i<=10;i++){
      const imagePath=join(dir,`image-${i}.png`);
      await writeFile(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iQAAAABJRU5ErkJggg==','base64'));
      entries.push({id:String(i).padStart(2,'0'),filename:`image-${i}.HEIC`,imagePath,status:'ready',fields:[{...field,value:`year-for-${i}`}]});
    }
    entries[1].cutExtraRoastBlocks = ['70 LB lechon & cut extra moves from 3:30 p.m. to 1:00 p.m.'];
    const html=await renderBatchReview(manifest(entries));
    const cards=html.match(/<article>.*?<\/article>/gs);
    assert.equal(cards.length,10);
    cards.forEach((card,i)=>{assert.ok(card.includes(`image-${i+1}.HEIC`));assert.ok(card.includes(`year-for-${i+1}`));assert.ok(card.includes('data:image/png;base64,'));});
    assert.equal(cards.filter(card => card.includes('<h3>Cut extra roast block</h3>')).length, 1);
    const callout = cards[1].indexOf('<section class="roast-block-callout">');
    assert.ok(callout >= 0 && callout < cards[1].indexOf('<table>'));
    assert.ok(cards[1].includes('70 LB lechon &amp; cut extra moves from 3:30 p.m. to 1:00 p.m.'));
    assert.ok(html.indexOf('Final batch confirmation')>html.lastIndexOf('</article>'));
    assert.ok(!html.includes('<script'));
    assert.match(html,/grid-template-columns:minmax/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('keeps missing images visible, escapes untrusted extraction text, and rejects invalid ready entries',async()=>{
  const entry={id:'01',filename:'<img src=x onerror=alert(1)>',status:'needs-clarification',fields:[{...field,value:'<script>bad()</script>',confidence:'Low'}],questions:['Unreadable phone']};
  const html=await renderBatchReview(manifest([entry]));
  assert.ok(html.includes('Image unavailable'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('class="low"'));
  await assert.rejects(renderBatchReview(manifest([{...entry,status:'ready'}])),/source preview image/);
  await assert.rejects(renderBatchReview(manifest([entry,entry])),/unique review ID/);
  await assert.rejects(renderBatchReview({...manifest([entry]),environment:undefined}),/environment required/);
});
