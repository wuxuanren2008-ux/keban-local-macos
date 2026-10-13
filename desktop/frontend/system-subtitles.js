/* System audio uses the same offline classroom pipeline as the microphone. */
(() => {
  'use strict';
  const toolbar=document.createElement('div');toolbar.className='course-toolbar capture-toolbar';
  toolbar.innerHTML='<label for="captureSource">声音来源</label><select id="captureSource"><option value="microphone">麦克风 · 线下课堂</option><option value="system">系统声音 · 视频 / 直播</option></select><button class="btn" id="showSubtitles" type="button">双语字幕浮窗</button><span class="sub" id="captureStatus" role="status">系统声音不采集麦克风，录音仍按课程保存。</span>';
  document.querySelector('.course-toolbar').after(toolbar);
  let ownedCapture=null,meter=null,meterTimer=null,quietSince=0,lastPayload='',startGeneration=0;
  window.localCaptureBusy=false;
  const notify=message=>{$('captureStatus').textContent=message;reliabilityNotice(message)};
  function releaseCapture(){
    clearInterval(meterTimer);meterTimer=null;
    try{meter?.close()}catch{}meter=null;
    const capture=ownedCapture;ownedCapture=null;
    capture?.getTracks().forEach(track=>track.stop());
  }
  async function watchSilence(audio){
    try{
      const context=meter=new AudioContext();if(context.setSinkId)await context.setSinkId({type:'none'});
      if(!ownedCapture){await context.close();return}
      const source=context.createMediaStreamSource(audio),analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);await context.resume();
      const samples=new Float32Array(analyser.fftSize);quietSince=Date.now();let warned=false;
      meterTimer=setInterval(()=>{
        if(paused){quietSince=Date.now();return}
        analyser.getFloatTimeDomainData(samples);const audible=samples.some(x=>Math.abs(x)>0.0002);
        if(audible){quietSince=Date.now();if(warned){warned=false;notify('已收到系统声音 · Whisper 与翻译在本机运行')}}
        else if(!warned&&Date.now()-quietSince>12000){warned=true;notify('未检测到系统声音：请播放视频，并检查屏幕与系统音频录制授权、音量和输出设备。')}
      },2000);
    }catch{notify('系统声音已连接；请播放视频，等待本机字幕。')}
  }
  const localStart=start;
  start=async function(){
    if(active||studioStarting||window.localCaptureBusy||recognition?.closing)return;
    const mode=$('captureSource').value,course=window.localCourseId,generation=++startGeneration;
    window.localCaptureBusy=true;$('captureSource').disabled=true;$('start').disabled=true;
    let capture=null;
    try{
      if(mode==='system'){
        if(!window.desktopSetup?.prepareSystemCapture)throw Error('请通过课伴桌面软件采集系统声音。');
        await window.desktopSetup.prepareSystemCapture();
        // Chromium needs a display grant. Only the audio tracks are ever passed
        // to MediaRecorder/Whisper; no screenshot or video frames are saved.
        try{capture=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:1,width:320,height:180},audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},systemAudio:'include',selfBrowserSurface:'exclude'})}
        finally{await window.desktopSetup.finishSystemCaptureRequest()}
        if(!capture.getAudioTracks().some(track=>track.readyState==='live'))throw Error('未获得系统音轨。请在共享选择器中启用系统音频，并允许课伴录制系统声音。');
        if(course!==window.localCourseId||generation!==startGeneration)throw Error('课程已切换，请重新开始声音采集。');
        ownedCapture=capture;capture.getVideoTracks().forEach(track=>track.enabled=false);
        const audio=new MediaStream(capture.getAudioTracks());
        // The requested feature is English/Chinese bilingual captions.
        if($('source').value.startsWith('zh')){$('target').value='en';savePreferences()}
        else if(!$('target').value.startsWith('zh')){$('target').value='zh-CN';savePreferences()}
        await localStart(audio);
        if(!active){releaseCapture();return}
        const ended=()=>{if(ownedCapture!==capture)return;if(active)stop();else releaseCapture();notify('系统声音共享已结束；本堂录音与字幕保留在课程资料库。')};
        capture.getTracks().forEach(track=>track.addEventListener('ended',ended,{once:true}));
        const sessionRecorder=recorder;sessionRecorder.addEventListener('stop',releaseCapture,{once:true});
        notify('正在采集系统声音 · 浮窗可拖动、缩放；使用结束课堂停止采集');
        await window.desktopSetup.showSubtitles();watchSilence(audio);
      }else await localStart();
    }catch(error){
      capture?.getTracks().forEach(track=>track.stop());releaseCapture();
      notify(error.name==='NotAllowedError'?'未开始系统声音采集。请允许屏幕与系统音频录制；如取消选择，可再次点击开始。':error.message);toast($('captureStatus').textContent);
    }finally{window.localCaptureBusy=false;$('start').disabled=false;$('captureSource').disabled=active||!!recognition?.closing;publish()}
  };
  $('start').onclick=()=>start();
  $('showSubtitles').onclick=async()=>{try{publish(true);await window.desktopSetup.showSubtitles()}catch(error){toast(error.message)}};
  $('captureSource').onchange=()=>notify($('captureSource').value==='system'?'播放视频或进入直播后开始课堂；声音在本机转写与翻译。':'麦克风模式适合线下课堂；也可打开字幕浮窗。');
  function publish(force=false){
    if(!window.desktopSetup?.updateSubtitles)return;
    const payload=window.localSubtitlePayload(items,window.interimText,{active,paused,closing:!!recognition?.closing});
    const encoded=JSON.stringify(payload);if(force||encoded!==lastPayload){lastPayload=encoded;window.desktopSetup.updateSubtitles(payload)}
    $('captureSource').disabled=active||window.localCaptureBusy||studioStarting||!!recognition?.closing;
    // Disable course mutation while the OS picker is open, before the recording
    // session itself takes the existing studioStarting lock.
    if(window.localCaptureBusy){$('courseSelect').disabled=true;$('addCourse').disabled=true}
    else if(!active&&!studioStarting&&!recognition?.closing){$('courseSelect').disabled=false;$('addCourse').disabled=false}
  }
  setInterval(publish,250);
  window.addEventListener('lecture-course-changed',()=>publish(true));
  const beforeClose=window.localBeforeClose;
  window.localBeforeClose=async()=>{await beforeClose();++startGeneration;releaseCapture()};
  window.addEventListener('pagehide',releaseCapture);
})();
