class LecturePCM extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(32000);this.used=0;this.phase=1;this.last=0;this.port.onmessage=e=>{if(e.data==='flush'){if(this.used){this.port.postMessage(this.buffer.slice(0,this.used).buffer);this.used=0}this.port.postMessage({type:'flushed'})}}}
  process(inputs){
    const input=inputs[0]?.[0];if(!input)return true;
    const ratio=sampleRate/16000;
    for(let i=0;i<input.length;i++){
      while(this.phase<=1){const value=this.last+(input[i]-this.last)*this.phase;this.buffer[this.used++]=value;this.phase+=ratio;if(this.used===this.buffer.length){const packet=this.buffer;this.port.postMessage(packet.buffer,[packet.buffer]);this.buffer=new Float32Array(32000);this.used=0}}
      this.phase-=1;this.last=input[i];
    }
    return true;
  }
}
registerProcessor('lecture-pcm',LecturePCM);
