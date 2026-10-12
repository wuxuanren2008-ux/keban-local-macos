function hasWhisperService(){
  const config=window.LECTURE_COMPANION_CONFIG||{};
  if(!config.asrEnabled||!config.asrUrl||!cloudAuthed)return false;
  try{const url=new URL(config.asrUrl);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}
}
class WhisperRecognition {
  constructor(stream){this.stream=stream;this.generation=0;this.results=[];this.useBrowser=false;this.running=false}
  start(){
    if(this.running)return;this.running=true;this._captionClosing=false;this.results=[];this.seenStable=new Set();this.lastSequence=-1;
    const generation=++this.generation;
    if(this.useBrowser){this.startBrowser();return}
    this.connect(generation).catch(()=>{if(generation===this.generation&&this.running)this.fallback()});
  }
  async connect(generation){
    // Capture immediately while authentication connects, so the opening words
    // are buffered rather than discarded. The queue is bounded to ten seconds.
    const context=this.context=new AudioContext();await context.audioWorklet.addModule(new URL('asr-worklet.js',document.baseURI));
    if(generation!==this.generation){await context.close();return}
    this.audioOffset=Math.max(0,(Date.now()-startedAt)/1000);this.pendingPCM=[];this.pendingBytes=0;this.ready=false;
    this.source=context.createMediaStreamSource(this.stream);this.node=new AudioWorkletNode(context,'lecture-pcm');const silence=context.createGain();silence.gain.value=0;this.source.connect(this.node);this.node.connect(silence);silence.connect(context.destination);
    this.node.port.onmessage=message=>{
      if(generation!==this.generation||!this.running)return;
      if(message.data?.type==='flushed'){if(this.socket?.readyState===WebSocket.OPEN){for(const packet of this.pendingPCM)this.socket.send(packet);this.pendingPCM=[];this.socket.send(JSON.stringify({type:'stop'}))}this.cleanupAudio();return}
      if(!this.ready){this.pendingPCM.push(message.data);this.pendingBytes+=message.data.byteLength;if(this.pendingBytes>640000)this.fallback();return}
      const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN)return;
      if(socket.bufferedAmount>256000){this.onerror?.({error:'network'});this.abort();return}socket.send(message.data);
    };
    await context.resume();
    const {data:{session}}=await supabaseClient.auth.getSession();
    if(!session?.access_token)throw Error('Login required');
    if(generation!==this.generation||!this.running)return;
    const url=new URL('/v1/stream',window.LECTURE_COMPANION_CONFIG.asrUrl);url.protocol='wss:';
    const socket=this.socket=new WebSocket(url);let ready=false;
    this.connectionTimer=setTimeout(()=>{if(!ready&&generation===this.generation&&this.running)this.fallback()},12000);
    socket.onopen=()=>{if(generation!==this.generation)return;socket.send(JSON.stringify({type:'start',sample_rate:16000,language:this.lang?.startsWith('ms')?'ms':'en',access_token:session.access_token}))};
    socket.onmessage=async event=>{
      if(generation!==this.generation)return;
      let data;try{data=JSON.parse(event.data)}catch{this.fallback();return}
      if(data.type==='ready'){
        ready=true;clearTimeout(this.connectionTimer);
        this.ready=true;for(const packet of this.pendingPCM)socket.send(packet);this.pendingPCM=[];this.pendingBytes=0;
        if(!this._captionClosing){this.onstart?.();reliabilityNotice('独立Whisper识别已连接：先显示初稿，确认后更新稳定字幕与译文。')}
      }else if(data.type==='captions'){
        if(!Number.isInteger(data.sequence)||data.sequence<=this.lastSequence)return;this.lastSequence=data.sequence;
        const index=this.results.length;
        for(const stable of data.stable||[]){if(typeof stable.id!=='string'||typeof stable.text!=='string'||this.seenStable.has(stable.id))continue;this.seenStable.add(stable.id);const row=[{transcript:stable.text}];row.isFinal=true;row.start=Number.isFinite(stable.start)?stable.start+this.audioOffset:undefined;this.results.push(row)}
        const result=this.results.slice();if(data.draft){const row=[{transcript:data.draft}];row.isFinal=false;result.push(row)}
        this.onresult?.({resultIndex:index,results:result});
      }else if(data.type==='error'){this.fallback()}
    };
    socket.onerror=()=>{if(generation!==this.generation)return;if(!ready)this.fallback();else this.onerror?.({error:'network'})};
    socket.onclose=()=>{if(generation!==this.generation)return;clearTimeout(this.connectionTimer);this.cleanupAudio();this.running=false;this.onend?.()};
  }
  startBrowser(){
    if(!SpeechRecognition){this.running=false;this.onerror?.({error:'service-not-allowed'});return}
    const native=this.native=new SpeechRecognition();native.lang=this.lang;native.continuous=true;native.interimResults=true;
    const current=()=>this.native===native&&(this.running||this._captionClosing);
    native.onstart=()=>{if(current())this.onstart?.()};native.onresult=event=>{if(current())this.onresult?.(event)};native.onerror=event=>{if(current())this.onerror?.(event)};native.onend=()=>{if(!current())return;this.running=false;this.onend?.()};
    native.start();
  }
  fallback(){
    if(this._captionClosing){this.abort();return}
    ++this.generation;clearTimeout(this.connectionTimer);try{this.socket?.close()}catch{}this.cleanupAudio();this.useBrowser=true;
    reliabilityNotice('独立识别服务暂不可用，已回退浏览器识别；录音继续保留。');
    try{this.startBrowser()}catch{this.running=false;this.onerror?.({error:'service-not-allowed'})}
  }
  cleanupAudio(){try{this.source?.disconnect();this.node?.disconnect();this.context?.close()}catch{}this.source=this.node=this.context=null;this.pendingPCM=[];this.pendingBytes=0;this.ready=false}
  stop(){
    this._captionClosing=true;
    if(this.native){this.native.stop();return}
    if(this.socket?.readyState===WebSocket.OPEN){
      // Flush captured PCM before stop; wait for the worklet's message barrier.
      const socket=this.socket,node=this.node;
      if(node)node.port.postMessage('flush');
      else socket.send(JSON.stringify({type:'stop'}));
    }else this.abort();
  }
  abort(){++this.generation;clearTimeout(this.connectionTimer);this._captionClosing=false;try{this.native?.abort();this.socket?.close()}catch{}this.cleanupAudio();this.running=false;this.onend?.()}
}
const stopCaptions=stop;
stop=function(){if(recognition)recognition._captionClosing=true;stopCaptions()};$('stop').onclick=stop;
