const {test}=require('node:test');const assert=require('node:assert/strict');
const {localSubtitlePayload}=require('../desktop/frontend/subtitle-payload.js');
test('latest translated pair progresses even when newer speech awaits slow local LLM',()=>{
 const p=localSubtitlePayload([{text:'A',translation:'甲'},{text:'B',translation:'',_translating:true}],'draft',{active:true});
 assert.equal(p.original,'A');assert.equal(p.translation,'甲');assert.match(p.status,/1 句/);
 const q=localSubtitlePayload([{text:'A',translation:'甲'},{text:'B',translation:'乙'}],'',{active:true});assert.equal(q.original,'B');assert.equal(q.translation,'乙');
});
test('initial pending utterance, pause, ending and bounds',()=>{
 assert.equal(localSubtitlePayload([{text:'First',translation:''}],'',{active:true}).original,'First');
 assert.equal(localSubtitlePayload([],'draft',{active:true,paused:true}).status,'已暂停');
 assert.match(localSubtitlePayload([],'',{closing:true}).status,/尾句/);
 assert.equal(localSubtitlePayload([{text:'x'.repeat(2000),translation:'中'.repeat(2000)}],'',{}).original.length,1200);
});
