/* No browser-provider or cloud fallback: local Whisper only. */
class LocalRecognition {
  constructor(stream){this.stream=stream;this.generation=0;this.results=[];this.running=false;this.closing=false}
  start(){if(this.running)return;if(this.closing){this.resumeRequested=true;return}this.running=true;this._captionClosing=false;this.results=[];this.seen=new Set();this.sequence=-1;const generation=++this.generation;this.connect(generation).catch(e=>this.fail(e.message))}
  async connect(generation){
    const context=this.context=new AudioContext();
    // Recognition needs an advancing audio graph, not a physical speaker device.
    // This also works in native macOS VMs without a configured audio output.
    if(typeof context.setSinkId==='function')await context.setSinkId({type:'none'});
    await context.audioWorklet.addModule('asr-worklet.js');
    if(generation!==this.generation){await context.close();return}
    this.audioOffset=Math.max(0,(Date.now()-startedAt)/1000);this.pending=[];this.pendingBytes=0;
    this.source=context.createMediaStreamSource(this.stream);this.node=new AudioWorkletNode(context,'lecture-pcm');const silence=context.createGain();silence.gain.value=0;this.source.connect(this.node);this.node.connect(silence);silence.connect(context.destination);
    const url=new URL('/v1/stream',location.origin);url.protocol='ws:';url.searchParams.set('token',window.localToken);
    const socket=this.socket=new WebSocket(url);
    socket.onopen=()=>socket.send(JSON.stringify({type:'start',sample_rate:16000,language:this.lang?.startsWith('ms')?'ms':'en',course_id:window.localCourseId}));
    this.node.port.onmessage=event=>{
      if(generation!==this.generation)return;
      if(event.data?.type==='flushed'){if(socket.readyState===WebSocket.OPEN){for(const packet of this.pending)socket.send(packet);this.pending=[];socket.send(JSON.stringify({type:'stop'}))}this.cleanupAudio();return}
      if(!this.running&&!this.closing)return;
      if(!this.ready){this.pending.push(event.data);this.pendingBytes+=event.data.byteLength;if(this.pendingBytes>1920000)this.fail('Whisper 仍未就绪；请先下载模型再开始课堂。');return}
      if(socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>1920000){this.fail('本机识别跟不上录音，请保留录音并选用更小的 Whisper 模型。');return}socket.send(event.data);
    };
    socket.onmessage=event=>{
      if(generation!==this.generation)return;let data;try{data=JSON.parse(event.data)}catch{return this.fail('识别服务返回格式错误')}
      if(data.type==='ready'){this.ready=true;for(const packet of this.pending)socket.send(packet);this.pending=[];this.pendingBytes=0;this.onstart?.();return}
      if(data.type==='error')return this.fail(data.error||data.message||'Whisper 识别失败');
      if(data.type!=='captions'||!Number.isInteger(data.sequence)||data.sequence<=this.sequence)return;
      this.sequence=data.sequence;const index=this.results.length;
      for(const part of data.stable||[]){if(this.seen.has(part.id)||!part.text)continue;this.seen.add(part.id);const row=[{transcript:part.text}];row.isFinal=true;row.start=part.start+this.audioOffset;this.results.push(row)}
      const result=this.results.slice();if(data.draft){const row=[{transcript:data.draft}];row.isFinal=false;result.push(row)}this.onresult?.({resultIndex:index,results:result});
    };
    socket.onerror=()=>this.fail('无法连接本机 Whisper 服务。请检查模型设置。');
    socket.onclose=()=>{if(generation!==this.generation)return;this.cleanupAudio();this.running=false;this.closing=false;this.resolveDrain?.();this.onend?.();if(this.resumeRequested&&active&&!paused){this.resumeRequested=false;this.start()}};
    await context.resume();
  }
  fail(message){this.onerror?.({error:'service-not-allowed'});reliabilityNotice(message+' 录音仍保留在本机。');this.abort()}
  cleanupAudio(){try{this.source?.disconnect();this.node?.disconnect();this.context?.close()}catch{}this.source=this.node=this.context=null;this.ready=false;this.pending=[]}
  stop(){if(!this.running)return;this.running=false;this.closing=true;this._captionClosing=true;this.drained=new Promise(resolve=>this.resolveDrain=resolve);if(this.node&&this.socket?.readyState===WebSocket.OPEN)this.node.port.postMessage('flush');else this.abort()}
  abort(){++this.generation;this.running=false;this.closing=false;this.resumeRequested=false;try{this.socket?.close()}catch{}this.cleanupAudio();this.resolveDrain?.();this.onend?.()}
}
