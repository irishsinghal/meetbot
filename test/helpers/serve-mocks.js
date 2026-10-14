// Manual testing: node test/helpers/serve-mocks.js  -> prints env settings that point MeetBot at local mocks.
import { startMockVoicegain, meetingScript } from './mock-voicegain.js';
import { startMockOllama } from './mock-ollama.js';
const vg = await startMockVoicegain({ scripts: [meetingScript()] });
const ol = await startMockOllama();
console.log(JSON.stringify({ VOICEGAIN_BASE_URL: vg.baseUrl, VOICEGAIN_JWT: vg.jwt, VOICEGAIN_SA_CONFIG: vg.saConfig, OLLAMA_URL: ol.url }));
setInterval(() => {}, 1 << 30);
