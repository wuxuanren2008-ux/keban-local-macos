/* Native Electron test. Fixture mode is explicitly labelled, never production. */
const {_electron}=require('playwright-core');
const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
const {spawn}=require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..'),fixture=process.env.LECTURE_SYSTEM_FIXTURE==='1';
  const data=path.join(root,'test-results',fixture?'subtitle-fixture-profile':'system-loopback-profile');fs.mkdirSync(data,{recursive:true});
  const app=await _electron.launch({executablePath:process.env.LECTURE_APP_EXE||require('electron'),args:process.env.LECTURE_APP_EXE?[]:[root],env:{...process.env,HF_HUB_OFFLINE:'1',LECTURE_TEST_DATA:data}});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));let player;
  try{
    await page.waitForFunction(()=>window.localPlatform&&$('courseSelect')?.options.length>0,null,{timeout:60000});
    await page.evaluate(async model=>{if(model){const r=await fetch('/api/settings',{method:'POST',headers:{'X-Lecture-Token':window.localToken,'Content-Type':'application/json'},body:JSON.stringify({llm_model:model})});if(!r.ok)throw Error('Settings failed')}},process.env.LECTURE_TEST_MODEL);
    const wavPath=path.join(root,'test-results',fixture?'fake-microphone.wav':'system-audio-fixture.wav');
    if(fixture){
      const wav=fs.readFileSync(wavPath).toString('base64');
      await page.evaluate(async encoded=>{
        const context=new AudioContext();if(context.setSinkId)await context.setSinkId({type:'none'});
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const buffer=await context.decodeAudioData(bytes.buffer);
        const source=context.createBufferSource(),destination=context.createMediaStreamDestination();source.buffer=buffer;source.loop=true;source.connect(destination);await context.resume();source.start();
        window.__subtitleFixture=context;window.__subtitleFixtureStream=destination.stream;
        navigator.mediaDevices.getDisplayMedia=async()=>destination.stream;
      },wav);
    }else{
      assert.equal(process.platform,'win32','Real loopback test uses a controlled Windows playback process');
      player=spawn(process.env.LECTURE_POWERSHELL_EXE||'pwsh.exe',['-NoProfile','-File',path.join(root,'scripts/test-system-playback.ps1'),wavPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      player.stderr.on('data',data=>console.error('Controlled playback:',data.toString()));
      player.on('error',error=>console.error('Controlled playback failed:',error.message));
      player.on('exit',code=>{if(code)console.error('Controlled playback exited:',code)});
    }
    // Any accidental microphone fallback fails the test.
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw Error('Microphone must never be requested in system mode')}});
    await page.locator('#title').fill(fixture?'Synthetic system-stream QA':'Native Windows loopback QA');
    await page.locator('#captureSource').selectOption('system');await page.locator('#start').click();
    await page.waitForFunction(()=>active&&recorder?.state==='recording',null,{timeout:45000});
    const overlay=await app.waitForEvent('window',{predicate:p=>p!==page,timeout:15000}).catch(()=>app.windows().find(p=>p!==page));
    assert.ok(overlay,'Subtitle window was created');await overlay.waitForLoadState();
    await page.waitForFunction(()=>items.some(x=>/opportunity cost/i.test(x.text)&&x.translation&&!x._translating),null,{timeout:300000});
    await overlay.waitForFunction(()=>/opportunity cost/i.test(document.querySelector('#original').textContent)&&/机会成本/.test(document.querySelector('#translation').textContent),null,{timeout:300000});
    assert.equal(await page.evaluate(()=>recorder.stream.getVideoTracks().length),0,'No screen frames are saved');
    const metadata=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({top:w.isAlwaysOnTop(),url:w.webContents.getURL()})));
    assert.ok(metadata.some(w=>w.top&&w.url.endsWith('subtitle.html')),JSON.stringify(metadata));
    await overlay.screenshot({path:path.join(root,'test-results',fixture?'subtitle-fixture.png':'subtitle-native-loopback.png')});
    await overlay.locator('#hide').click();
    assert.equal(await page.evaluate(()=>active),true,'Hiding captions preserves the classroom');
    await page.locator('#showSubtitles').click();await overlay.locator('#original').waitFor();
    await page.locator('#pauseClass').click();await overlay.waitForFunction(()=>document.querySelector('#status').textContent.includes('已暂停'));
    await page.locator('#pauseClass').click();
    await page.locator('#stop').click();
    await page.waitForFunction(()=>!recognition?.closing&&items.every(x=>!x._translating),null,{timeout:300000});
    const saved=await page.evaluate(async()=>{await window.localBeforeClose();const r=await fetch('/api/lectures/'+studioId+'/audio',{headers:{'X-Lecture-Token':window.localToken}});return{status:r.status,bytes:(await r.arrayBuffer()).byteLength,tracks:recorder.stream.getTracks().map(t=>t.readyState)}});
    assert.equal(saved.status,200);assert.ok(saved.bytes>1000);assert.ok(saved.tracks.every(s=>s==='ended'),JSON.stringify(saved));
    assert.deepEqual(errors,[]);
    console.log('PASS system subtitles: '+(fixture?'synthetic getDisplayMedia fixture (not physical system audio)':'actual Windows WASAPI loopback from controlled external WAV playback')+'; live Whisper/LLM, bilingual always-on-top window, hide/reopen/pause, audio-only course archive, track release');
    if(fixture)await page.evaluate(()=>window.__subtitleFixture.close());
    // Explicit denied/missing-audio paths must not leave an active session.
    await page.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException('Denied','NotAllowedError')}});
    await page.locator('#start').click();await page.waitForFunction(()=>!window.localCaptureBusy);
    assert.equal(await page.evaluate(()=>active),false);assert.match(await page.locator('#captureStatus').textContent(),/未开始/);
    await page.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=async()=>new MediaStream()});
    await page.locator('#start').click();await page.waitForFunction(()=>!window.localCaptureBusy);
    assert.equal(await page.evaluate(()=>active),false);assert.match(await page.locator('#captureStatus').textContent(),/系统音轨/);
    console.log('PASS system error paths: denied permission and missing audio; no microphone fallback or active capture');
  }catch(error){console.error('Subtitle verification failed:',error,'page errors:',errors);await page.screenshot({path:path.join(root,'test-results','subtitle-error.png')}).catch(()=>{});throw error}
  finally{player?.kill();await app.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
