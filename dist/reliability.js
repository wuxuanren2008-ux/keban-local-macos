/* Keep diagnostics local; no credentials or classroom content are collected. */
function splitTranslationText(text, maxBytes=480) {
  const encoder=new TextEncoder(), result=[]; let part='', bytes=0;
  for(const char of text){const size=encoder.encode(char).length;if(bytes+size>maxBytes){const breakAt=part.lastIndexOf(' ');if(breakAt>part.length/2){result.push(part.slice(0,breakAt+1));part=part.slice(breakAt+1);bytes=encoder.encode(part).length}else{result.push(part);part='';bytes=0}}part+=char;bytes+=size}
  if(part)result.push(part);return result;
}
let translationBusy=0;
const translationWaiters=[];
async function translationSlot(){if(translationBusy>=2)await new Promise(resolve=>translationWaiters.push(resolve));else translationBusy++}
function releaseTranslationSlot(){const next=translationWaiters.shift();if(next)next();else translationBusy--}

function recordingCheck(){
  if(!window.isSecureContext)return '麦克风需要安全连接，请使用 HTTPS 打开课伴。';
  if(!SpeechRecognition&&!(typeof hasWhisperService==='function'&&hasWhisperService()))return '此浏览器不支持实时识别，请换用支持语音识别的浏览器后重试。';
  if(!navigator.mediaDevices?.getUserMedia)return '浏览器无法访问麦克风，请检查浏览器与设备设置。';
  if(typeof MediaRecorder==='undefined')return '此浏览器不支持录音，请更新浏览器后重试。';
  if(navigator.onLine===false)return '网络已断开；实时识别与翻译需要联网，请连接网络后开始。';
  return '';
}
function reliabilityNotice(message){$('reliabilityStatus').textContent=message}
const reliabilityStatus=document.createElement('p');
reliabilityStatus.id='reliabilityStatus';reliabilityStatus.className='sub';reliabilityStatus.setAttribute('role','status');reliabilityStatus.setAttribute('aria-live','polite');
$('draftStatus').insertAdjacentElement('afterend',reliabilityStatus);
reliabilityNotice(recordingCheck()||'开始前会检查麦克风。英国课堂请选择英语（英国）；长课堂请保持页面前台，结束后下载录音备份。');
window.addEventListener('offline',()=>reliabilityNotice('网络已断开，字幕与翻译可能中断；请确认录音状态，恢复网络后重试未翻译的句子。'));
window.addEventListener('online',()=>reliabilityNotice('网络已恢复；请确认实时字幕是否继续，未翻译的句子可点击重试翻译。'));
document.addEventListener('visibilitychange',()=>{archiveCurrent();if(active)reliabilityNotice(document.hidden?'页面已进入后台，浏览器可能暂停识别或录音。请回到课伴并检查录制状态。':'已回到课伴，请确认录音状态与实时字幕；锁屏期间的声音可能没有被记录。')});
window.addEventListener('pagehide',archiveCurrent);

function monitorRecording(stream,record,sessionRecognition){
  sessionRecognition._captionSession=studioOwner+':'+studioId;
  let retries=0,restartTimer=null,blocked=false;
  const current=()=>recognition===sessionRecognition&&recorder===record;
  const clearRestart=()=>{clearTimeout(restartTimer);restartTimer=null};
  sessionRecognition.onstart=()=>{if(current()){sessionRecognition._captionEpoch=(sessionRecognition._captionEpoch||0)+1;reliabilityNotice('麦克风已连接，正在识别。请保持页面前台；录音结束后会保存到本机。')}};
  const previousResult=sessionRecognition.onresult;
  sessionRecognition.onresult=e=>{if(current())retries=0;previousResult(e)};
  sessionRecognition.onerror=e=>{
    if(!current()||!active)return;
    if(e.error==='no-speech'||e.error==='aborted')return;
    qualityRun.metrics.recognition_errors++;
    if(['not-allowed','service-not-allowed','audio-capture','language-not-supported'].includes(e.error)){blocked=true;clearRestart();reliabilityNotice('实时识别已停止：'+e.error+'。录音可继续；请结束课堂后检查权限、设备或语言，再重新开始。')}
    else reliabilityNotice('实时识别暂时中断：'+e.error+'。正在等待恢复，请检查网络；录音状态请以下方显示为准。');
  };
  sessionRecognition.onend=()=>{
    clearRestart();if(!active)sessionRecognition._captionClosing=false;if(!current()||!active||paused||blocked)return;
    if(retries>=5){blocked=true;reliabilityNotice('实时识别连续中断，已停止自动重试。请结束课堂后检查网络与设备，再重新开始；已有文字仍保留。');return}
    restartTimer=setTimeout(()=>{restartTimer=null;if(!current()||!active||paused||blocked)return;retries++;try{sessionRecognition.start()}catch{sessionRecognition.onend()}},Math.min(1000*2**retries,15000));
  };
  const interrupt=message=>{if(!current()||!active)return;clearRestart();blocked=true;stop();reliabilityNotice(message)};
  stream.getAudioTracks().forEach(track=>track.addEventListener('ended',()=>interrupt('麦克风已断开，课堂录制已结束。已收到的文字与录音将保留，请检查设备后重新开始。')));
  record.addEventListener('error',()=>interrupt('录音发生异常，课堂录制已结束。请下载已保留的录音与文字，再检查设备。'));
  record.addEventListener('stop',()=>{clearRestart();if(current()&&active)interrupt('录音意外结束，课堂已停止。请检查设备，保存已有文字与录音。')});
}
