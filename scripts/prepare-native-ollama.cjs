/* Runs the production, checksum-verified macOS installer on the native test host. */
const path=require('node:path');
const setup=require('../desktop/model-setup.cjs');
const data=path.resolve('test-results/native-model-environment');
const timer=setInterval(()=>{const p=setup.progress();if(p.total)console.log('Ollama download '+Math.round(p.received/p.total*100)+'%')},10000);
setup.install(data).then(()=>{
  clearInterval(timer);console.log('Production macOS Ollama setup completed: '+path.join(data,'ollama','ollama'));
  // Leave this local test server alive for subsequent steps in this ephemeral VM.
  process.exit(0);
}).catch(error=>{clearInterval(timer);console.error(error);setup.stop();process.exit(1)});
