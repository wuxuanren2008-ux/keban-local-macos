async function lectureGemini(body){
  if(!supabaseClient||!cloudAuthed)throw Error('请先登录课伴，才能使用 Gemini。');
  const {data,error}=await supabaseClient.functions.invoke('summarize',{body:{...body,consent:true},signal:AbortSignal.timeout(110000)});
  if(error){let message=error.message;try{message=(await error.context?.json())?.error||message}catch{}throw Error(message)}
  if(!data||data.error)throw Error(data?.error||'Gemini 未返回结果。');return data;
}
function pcmWavBase64(packets){
  const samples=packets.reduce((n,p)=>n+p.length,0),buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer);
  const word=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))};
  word(0,'RIFF');view.setUint32(4,36+samples*2,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,samples*2,true);
  let offset=44;for(const packet of packets)for(const sample of packet){const clamped=Math.max(-1,Math.min(1,sample));view.setInt16(offset,clamped<0?clamped*32768:clamped*32767,true);offset+=2}
  const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
}
class GeminiRecognition {
  constructor(stream){this.stream=stream;this.generation=0;this.running=false;this.closing=false}
  start(){if(this.running)return;if(this.closing){this.resumeRequested=true;return}this.running=true;this._captionClosing=false;const generation=++this.generation;this.connect(generation).catch(error=>{if(this.generation===generation){this.onerror?.({error:'service-not-allowed'});reliabilityNotice(error.message||'Gemini 无法连接，录音仍在本机。');this.finish()}})}
  async connect(generation){
    this.session=studioOwner+':'+studioId;this.owner=accountUserId;this.sourceLanguage=this.lang?.startsWith('ms')?'ms':'en';this.targetLanguage=$('target').value;this.glossary=personalGlossary.slice(0,50);this.packets=[];this.samples=0;this.silent=0;this.hasSpeech=false;this.offset=Math.max(0,(Date.now()-startedAt)/1000);this.segmentStart=this.offset;this.results=[];this.queue=[];this.inflight=0;this.sent=0;this.next=0;this.completed=new Map();this.failed=false;
    // Include tail transcription in optional quality uploads before the recorder stops.
    this.drained=new Promise(resolve=>this.resolveDrain=resolve);const drain=this.drained,run=qualityRun;run?.pending.add(drain);drain.finally(()=>run?.pending.delete(drain));
    const Context=window.AudioContext||window.webkitAudioContext;const context=this.context=new Context();await context.audioWorklet.addModule(new URL('gemini-worklet.js',document.baseURI));
    if(generation!==this.generation||!this.running){await context.close();return}
    this.source=context.createMediaStreamSource(this.stream);this.node=new AudioWorkletNode(context,'gemini-pcm');const silent=context.createGain();silent.gain.value=0;this.source.connect(this.node);this.node.connect(silent);silent.connect(context.destination);
    this.node.port.onmessage=event=>{if(generation!==this.generation)return;if(event.data?.type==='flushed'){clearTimeout(this.flushTimer);this.enqueue();this.cleanupAudio();this.pump();this.maybeFinish();return}if(!this.running&&!this.closing)return;const packet=new Float32Array(event.data);let energy=0;for(const value of packet)energy+=value*value;const speech=Math.sqrt(energy/packet.length)>.008;this.hasSpeech||=speech;this.silent=speech?0:this.silent+packet.length;this.packets.push(packet);this.samples+=packet.length;
      if(this.samples>=128000||(this.samples>=48000&&this.silent>=11200)){this.enqueue();this.pump()}
    };
    await context.resume();this.onstart?.();reliabilityNotice('Gemini 已连接：按停顿分段生成原文和译文（每段 3–8 秒）；结束后等待尾句确认。');
  }
  current(){return this.owner===accountUserId&&this.session===studioOwner+':'+studioId&&recognition===this}
  enqueue(){
    if(!this.samples)return;const start=this.segmentStart;this.segmentStart+=this.samples/16000;
    if(this.hasSpeech){if(this.queue.length>=3){this.failed=true;this.onerror?.({error:'service-not-allowed'});reliabilityNotice('Gemini 处理速度跟不上录音，已停止新字幕请求。请保存录音；已有片段继续确认。');this.closing=true;this.running=false;this.cleanupAudio()}else this.queue.push({id:this.sent++,start,audio:pcmWavBase64(this.packets)})}
    this.packets=[];this.samples=0;this.silent=0;this.hasSpeech=false;
  }
  pump(){
    while(this.inflight<2&&this.queue.length){const task=this.queue.shift(),generation=this.generation;this.inflight++;
      const promise=lectureGemini({operation:'transcribe_lecture',audio:task.audio,source:this.sourceLanguage,target:this.targetLanguage,glossary:this.glossary});
      promise.then(data=>{if(generation===this.generation)this.completed.set(task.id,{...task,...data})},error=>{if(generation===this.generation)this.completed.set(task.id,{...task,error:error.message})}).finally(()=>{if(generation!==this.generation)return;this.inflight--;this.commit();this.pump();this.maybeFinish()});
    }
  }
  commit(){while(this.completed.has(this.next)){const part=this.completed.get(this.next);this.completed.delete(this.next++);if(!this.current())continue;
    if(part.error){qualityRun&&(qualityRun.metrics.recognition_errors++);reliabilityNotice('Gemini 在 '+fmt(Math.floor(part.start))+' 的片段未成功转录：'+part.error+' 请用本机录音核对；该片段没有被当作完成。');toast('有音频片段转录失败，请保留录音。');continue}
    if(part.text){const index=this.results.length,row=[{transcript:part.text}];row.isFinal=true;row.start=part.start;row.geminiTranslation=part.translation;row.geminiTranslationError=part.translationError;row.translationMs=part.translationMs;this.results.push(row);this.onresult?.({resultIndex:index,results:this.results.slice()})}
  }}
  stop(){if(!this.running)return;this.running=false;this.closing=true;this._captionClosing=true;reliabilityNotice('录制已暂停或结束，正在确认最后的字幕；请暂时保持页面打开。');if(this.node){this.node.port.postMessage('flush');this.flushTimer=setTimeout(()=>{this.enqueue();this.cleanupAudio();this.pump();this.maybeFinish()},2000)}else this.maybeFinish()}
  cleanupAudio(){try{this.source?.disconnect();this.node?.disconnect();this.context?.close()}catch{}this.source=this.node=this.context=null}
  maybeFinish(){if(this.closing&&!this.node&&!this.queue.length&&!this.inflight)this.finish()}
  finish(){this.cleanupAudio();this.resolveDrain?.();this.resolveDrain=null;this.running=false;this.closing=false;this.onend?.();if(this.resumeRequested&&active&&!paused&&this.current()){this.resumeRequested=false;this.start()}}
  abort(){++this.generation;clearTimeout(this.flushTimer);this.queue=[];this.completed?.clear();this.inflight=0;this.resumeRequested=false;this.finish()}
}
translate=async function(item){
  if(!item||item._translating)return;const classId=studioId,owner=accountUserId,target=$('target').value,text=item.text,run=qualityRun,begin=performance.now();
  const valid=()=>classId===studioId&&owner===accountUserId&&items.includes(item)&&target===$('target').value&&text===item.text&&!item.user_corrected;
  item._translating=true;
  try{await translationSlot();try{if(!valid())return;const data=await lectureGemini({operation:'translate_lecture',text,source:item.code?.startsWith('ms')?'ms':'en',target,glossary:personalGlossary});if(valid()){item.translation=data.translation;if(run){run.metrics.translation_count++;run.metrics.translation_total_ms+=Math.round(performance.now()-begin)}}}finally{releaseTranslationSlot()}}
  catch(error){if(valid()){item.translation='（翻译暂不可用：'+error.message+'）';if(run)run.metrics.translation_failures++}}
  finally{item._translating=false;if(classId===studioId&&owner===accountUserId&&items.includes(item)){if((target!==$('target').value||text!==item.text)&&!item.user_corrected)translate(item);render()}}
};
const geminiStart=start;
start=async function(){if(!cloudAuthed){openModal('accountDialog',$('openAccount'));toast('请先登录，再使用 Gemini 转录与翻译。');return}if(!$('lectureAiConsent').checked){toast('请先勾选课堂卡片中的 Gemini 音频处理同意选项。');$('lectureAiConsent').focus();return}if(recognition?.closing){toast('正在确认上一段字幕，请稍后再开始。');return}await geminiStart()};$('start').onclick=start;
recordingCheck=function(){if(!window.isSecureContext)return '请使用 HTTPS 打开课伴。';if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode||!(window.AudioContext||window.webkitAudioContext))return '请更新浏览器，以使用 Gemini 音频采集。';if(typeof MediaRecorder==='undefined')return '浏览器不支持录音，请更新浏览器。';if(!navigator.onLine)return '实时转录和翻译需要网络。';return ''};
$('lectureAiConsent').onchange=()=>{if(!$('lectureAiConsent').checked&&active){stop();reliabilityNotice('已撤回音频处理同意，课堂已结束；已发送片段会完成处理，未再采集新片段。')}};
let geminiConsentOwner=accountUserId;
supabaseClient?.auth.onAuthStateChange((_event,session)=>{const owner=session?.user?.id||null;if(owner!==geminiConsentOwner){$('lectureAiConsent').checked=false;geminiConsentOwner=owner}});
reliabilityNotice('转录、翻译、总结均由 Gemini 提供。登录并同意处理音频后开始；免费额度不足时会提示。');
