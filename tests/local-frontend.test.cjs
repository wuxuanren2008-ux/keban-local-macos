const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function recognitionHarness(){
  let socket,node;const sent=[];
  class Socket{static OPEN=1;constructor(){socket=this;this.readyState=1;this.bufferedAmount=0}send(value){sent.push(value)}close(){this.readyState=3;this.onclose?.()}}
  class Context{constructor(){this.audioWorklet={addModule:async()=>{}};this.destination={}}createMediaStreamSource(){return{connect(){},disconnect(){}}}createGain(){return{gain:{value:0},connect(){}}}async resume(){}async close(){}}
  class Node{constructor(context,name,options){node=this;this.options=options;this.port={postMessage:value=>{this.flush=value}}}connect(){}disconnect(){}}
  const context=vm.createContext({AudioContext:Context,AudioWorkletNode:Node,WebSocket:Socket,URL,location:{origin:'http://127.0.0.1:8766'},window:{localToken:'test-token',localCourseId:'course-a'},Date,startedAt:Date.now(),active:false,paused:false,reliabilityNotice(){}});
  vm.runInContext(fs.readFileSync('desktop/frontend/local-recognition.js','utf8')+'\nglobalThis.Recognition=LocalRecognition',context);
  const recognition=new context.Recognition({});
  const ready=async()=>{recognition.start();await new Promise(resolve=>setImmediate(resolve));socket.onopen();return{socket,node}};
  return{recognition,ready,sent};
}
test('stop sends remaining captured PCM before the stop barrier',async()=>{
  const h=recognitionHarness();const {socket,node}=await h.ready();
  const packet=new ArrayBuffer(64);node.port.onmessage({data:packet});
  h.recognition.stop();assert.equal(node.flush,'flush');node.port.onmessage({data:{type:'flushed'}});
  assert.equal(h.sent[1],packet);assert.deepEqual(JSON.parse(h.sent[2]),{type:'stop'});socket.close();await h.recognition.drained;
});

test('stereo system audio is explicitly downmixed and Chinese ASR is preserved',async()=>{
  const h=recognitionHarness();h.recognition.lang='zh-CN';const {node,socket}=await h.ready();
  assert.equal(node.options.channelCount,1);assert.equal(node.options.channelCountMode,'explicit');assert.equal(node.options.channelInterpretation,'speakers');
  assert.equal(JSON.parse(h.sent[0]).language,'zh');socket.close();
});
test('a final stable caption after stop is emitted once even when packets repeat',async()=>{
  const h=recognitionHarness();const {socket}=await h.ready();const outputs=[];h.recognition.onresult=e=>outputs.push(e);
  h.recognition.stop();
  const message=sequence=>({data:JSON.stringify({type:'captions',sequence,stable:[{id:'tail',text:'Last classroom sentence.',start:9,end:10}],draft:'',final:true})});
  socket.onmessage(message(0));socket.onmessage(message(0));socket.onmessage(message(1));
  assert.equal(h.recognition.results.length,1);assert.equal(outputs[0].results[0][0].transcript,'Last classroom sentence.');socket.close();await h.recognition.drained;
});
test('the final worklet packet before the flush acknowledgement is preserved',async()=>{
  const h=recognitionHarness();const {socket,node}=await h.ready();
  socket.onmessage({data:JSON.stringify({type:'ready'})});
  h.recognition.stop();const tail=new ArrayBuffer(32);node.port.onmessage({data:tail});
  node.port.onmessage({data:{type:'flushed'}});
  assert.equal(h.sent[1],tail);assert.equal(JSON.parse(h.sent[2]).type,'stop');socket.close();
});
test('local ASR errors stop inference without enabling a cloud fallback',async()=>{
  const h=recognitionHarness();const {socket}=await h.ready();let error;h.recognition.onerror=e=>error=e.error;
  socket.onmessage({data:JSON.stringify({type:'error',error:'model missing'})});
  assert.equal(error,'service-not-allowed');assert.equal(h.recognition.running,false);assert.equal(h.recognition.socket.readyState,3);
});
