/* End-to-end check using the real Electron window, local LLM and persistence. */
const {_electron}=require('playwright-core');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
(async()=>{
  const root=path.resolve(__dirname,'..'),data=path.join(root,'test-results',process.env.LECTURE_APP_EXE?'packaged-profile':'desktop-profile');fs.mkdirSync(data,{recursive:true});
  const args=process.env.LECTURE_APP_EXE?[]:[root];
  if(process.env.LECTURE_CAPTURE_VERIFY==='1')args.push('--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+path.join(root,'test-results/fake-microphone.wav'));
  const app=await _electron.launch({executablePath:process.env.LECTURE_APP_EXE||require('electron'),args,env:{...process.env,HF_HUB_OFFLINE:'1',LECTURE_TEST_DATA:data}});
  const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.waitForFunction(()=>document.querySelector('#courseSelect')?.options.length>0&&$('reliabilityStatus').textContent.includes('首次'),null,{timeout:60000});
    console.log('desktop booted');
    if(process.env.LECTURE_TEST_MODEL){await page.evaluate(async model=>{const response=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-Lecture-Token':window.localToken},body:JSON.stringify({llm_model:model})});if(!response.ok)throw Error('Unable to select test model')},process.env.LECTURE_TEST_MODEL)}
    if(process.env.LECTURE_ASR_VERIFY==='1'){
      const pcm=fs.readFileSync(path.join(root,'test-results','synthetic-economics.raw')).toString('base64');
      const transcript=await page.evaluate(async encoded=>new Promise((resolve,reject)=>{
        const url=new URL('/v1/stream',location.origin);url.protocol='ws:';url.searchParams.set('token',window.localToken);const socket=new WebSocket(url),rows=[];
        const timer=setTimeout(()=>{socket.close();reject(Error('Packaged ASR timeout'))},120000);
        socket.onopen=()=>socket.send(JSON.stringify({type:'start',sample_rate:16000,language:'en',course_id:window.localCourseId}));
        socket.onmessage=event=>{const data=JSON.parse(event.data);if(data.type==='ready'){const bytes=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));for(let offset=0;offset<bytes.length;offset+=64000)socket.send(bytes.slice(offset,offset+64000));socket.send(JSON.stringify({type:'stop'}))}else if(data.type==='captions')rows.push(...data.stable.map(x=>x.text));else if(data.type==='error'){clearTimeout(timer);socket.close();reject(Error(data.error))}};
        socket.onclose=()=>{clearTimeout(timer);resolve(rows.join(' '))};socket.onerror=()=>reject(Error('Packaged ASR connection failed'));
      }),pcm);
      assert.ok(transcript.toLowerCase().includes('opportunity cost'),transcript);console.log('offline packaged Whisper ASR passed');
    }
    await page.locator('#addCourse').click();await page.locator('#courseName').fill('Desktop QA · Economics');await page.locator('#createCourse').click();await page.waitForFunction(()=>!document.querySelector('#courseDialog').open);
    const course=await page.evaluate(()=>window.localCourseId);
    console.log('course created');
    if(process.env.LECTURE_CAPTURE_VERIFY==='1'){
      const input=fs.readFileSync(path.join(root,'test-results/fake-microphone.wav')).toString('base64');
      await page.evaluate(async encoded=>{
        const context=new AudioContext({sampleRate:48000});if(typeof context.setSinkId==='function')await context.setSinkId({type:'none'});
        const bytes=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));const buffer=await context.decodeAudioData(bytes.buffer);
        const destination=context.createMediaStreamDestination(),source=context.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(destination);
        await context.resume();source.start();window.__syntheticCaptureContext=context;
        // Test-only substitute for the VM's silent microphone; never used by the shipped app.
        navigator.mediaDevices.getUserMedia=async()=>destination.stream;
      },input);
      await page.locator('#title').fill('Synthetic recorded classroom');await page.locator('#start').click();
      await page.waitForFunction(()=>active&&recorder?.state==='recording',null,{timeout:30000});
      await page.waitForFunction(()=>recognition?.node,null,{timeout:30000});
      await page.evaluate(()=>{const rec=recognition;rec.captureStats={packets:0,bytes:0,peak:0};const handle=rec.node.port.onmessage;rec.node.port.onmessage=event=>{if(event.data instanceof ArrayBuffer){rec.captureStats.packets++;rec.captureStats.bytes+=event.data.byteLength;for(const sample of new Float32Array(event.data))rec.captureStats.peak=Math.max(rec.captureStats.peak,Math.abs(sample))}handle(event)}});
      await page.waitForTimeout(12000);
      console.log('Capture diagnostics',await page.evaluate(()=>({context:recognition.context?.state,sampleRate:recognition.context?.sampleRate,ready:recognition.ready,sequence:recognition.sequence,stats:recognition.captureStats,track:recognition.stream.getAudioTracks()[0]?.getSettings(),recording:recorder.state,items:items.length})));
      await page.locator('#stop').click();
      await page.waitForFunction(()=>!recognition?.closing&&items.length>0&&items.every(x=>!x._translating),null,{timeout:300000});
      const recording=await page.evaluate(async()=>{await window.localFlush();const response=await fetch('/api/lectures/'+studioId,{headers:{'X-Lecture-Token':window.localToken}});const row=await response.json();const audio=await fetch('/api/lectures/'+studioId+'/audio',{headers:{'X-Lecture-Token':window.localToken}});return{saved:row.hasAudio,bytes:(await audio.arrayBuffer()).byteLength,text:items.map(x=>x.text).join(' ')}});
      assert.ok(recording.saved&&recording.bytes>1000,JSON.stringify(recording));assert.ok(recording.text.toLowerCase().includes('opportunity cost'),recording.text);
      console.log('PASS capture: synthetic MediaStream, AudioWorklet, live Whisper/LLM, MediaRecorder and disk recording');
      await page.evaluate(()=>window.__syntheticCaptureContext.close());
      await page.locator('#newClass').click();await page.waitForFunction(()=>items.length===0);
    }
    await page.evaluate(()=>{$('title').value='Week 1 · Opportunity cost';items=[{text:'Opportunity cost is the value of the next best alternative forgone.',translation:'机会成本是放弃的次佳选择的价值。',time:'00:00',code:'en-US',lang:'英语'}];render();});
    await page.evaluate(()=>window.localFlush());
    console.log('lecture saved');
    await page.locator('#summarize').click();await page.waitForFunction(()=>!$('summarize').dataset.busy,null,{timeout:1200000});
    const result=await page.evaluate(()=>({summary:summaryData,message:$('toast').textContent}));assert.ok(result.summary?.overview,JSON.stringify(result));
    console.log('summary rendered');
    await page.locator('#summaryPane > details > summary').click();await page.locator('#summaryFeedback').fill('Compare opportunity cost and sunk cost; retain definitions.');await page.locator('#saveSummaryFeedback').click();await page.waitForFunction(()=>$('learningStatus').textContent.includes('1 条总结建议'));
    await page.locator('[data-study="mindmap"]').click();const mapSize=await page.locator('.map-node').count();assert.ok(mapSize>=1);
    await page.evaluate(()=>window.localFlush());await page.locator('[data-view="library"]').click();await page.locator('[data-open-local]').first().click();await page.locator('[data-study="mindmap"]').click();assert.equal(await page.locator('.map-node').count(),mapSize);
    await page.locator('[data-view="glossary"]').click();await page.locator('#termSource').fill('opportunity cost');await page.locator('#termTranslation').fill('机会成本');await page.locator('#addTerm').click();await page.waitForFunction(()=>$('glossaryList').textContent.includes('机会成本'));
    await page.locator('[data-view="documents"]').click();assert.equal(await page.locator('#documentStart').isVisible(),true);
    await page.locator('[data-view="classroom"]').click();await page.screenshot({path:path.join(root,'test-results','desktop-classroom.png'),fullPage:true});
    assert.deepEqual(errors,[]);console.log('PASS: courses, save, real summary/mindmap persistence, feedback memory, glossary, document tab; no page errors');
  }catch(error){console.error('UI test failed:',error);console.error('Page errors:',errors);await page.screenshot({path:path.join(root,'test-results','desktop-error.png')}).catch(()=>{});throw error}finally{await app.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
