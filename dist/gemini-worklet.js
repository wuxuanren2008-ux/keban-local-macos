// 100 ms packets; browser sample rates are resampled to 16 kHz mono.
class GeminiPCM extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(1600);this.used=0;this.phase=1;this.last=0;this.port.onmessage=e=>{if(e.data==='flush'){if(this.used)this.port.postMessage(this.buffer.slice(0,this.used).buffer);this.used=0;this.port.postMessage({type:'flushed'})}}}
  process(inputs){const input=inputs[0]?.[0];if(!input)return true;const ratio=sampleRate/16000;for(const value of input){while(this.phase<=1){this.buffer[this.used++]=this.last+(value-this.last)*this.phase;this.phase+=ratio;if(this.used===1600){const packet=this.buffer;this.port.postMessage(packet.buffer,[packet.buffer]);this.buffer=new Float32Array(1600);this.used=0}}this.phase-=1;this.last=value}return true}
}
registerProcessor('gemini-pcm',GeminiPCM);
