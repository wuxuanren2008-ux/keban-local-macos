const test=require('node:test');const assert=require('node:assert/strict');
const {captureSupport,installSystemCapture}=require('../desktop/system-capture.cjs');
test('native system-audio platform floors and picker',()=>{
  assert.deepEqual(captureSupport('darwin','14.1'),{supported:false,nativePicker:false});
  assert.deepEqual(captureSupport('darwin','14.2'),{supported:true,nativePicker:false});
  assert.deepEqual(captureSupport('darwin','15.7.9'),{supported:true,nativePicker:true});
  assert.equal(captureSupport('win32').supported,true);assert.equal(captureSupport('linux').supported,false);
});
function fixture(){let handler,opts,calls=0;const contents={},owner={webContents:contents,isDestroyed:()=>false};const capture=installSystemCapture({session:{setDisplayMediaRequestHandler(h,o){handler=h;opts=o}},desktopCapturer:{async getSources(){calls++;return[{id:'screen:0',name:'Screen'}]}},owner:()=>owner,origin:'http://127.0.0.1:8766',platform:'win32',version:''});const frame={url:'http://127.0.0.1:8766/',webContents:contents};contents.mainFrame=frame;return {capture,frame,get opts(){return opts},get calls(){return calls},grant:async request=>{let result;await handler(request,x=>result=x);return result}}}
test('capture requires owner, exact origin, audio request and explicit arming',async()=>{
  const f=fixture();assert.equal(await f.grant({frame:f.frame,audioRequested:true}),null);
  assert.throws(()=>f.capture.arm({sender:{},senderFrame:f.frame}));
  assert.throws(()=>f.capture.arm({sender:f.frame.webContents,senderFrame:{url:'http://127.0.0.1:87660/'}}));
  f.capture.arm({sender:f.frame.webContents,senderFrame:f.frame});
  assert.equal(await f.grant({frame:f.frame,audioRequested:false}),null);assert.equal(f.calls,0);
  const grant=await f.grant({frame:f.frame,audioRequested:true});assert.equal(grant.audio,'loopback');assert.equal(grant.video.id,'screen:0');assert.equal(f.capture.armed(),false);
  assert.equal(await f.grant({frame:f.frame,audioRequested:true}),null);
});
test('cancelled requests cannot be reused',async()=>{const f=fixture();f.capture.arm({sender:f.frame.webContents,senderFrame:f.frame});f.capture.clear();assert.equal(await f.grant({frame:f.frame,audioRequested:true}),null)});
