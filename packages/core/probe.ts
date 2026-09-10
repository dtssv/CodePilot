import { FallbackProvider } from "./src/providers/fallback.js";
const fake = { name:"a", defaultModel:"m", smallModel:"s", async *stream(){ yield {kind:"text_delta" as const, messageId:"m", text:"x"}; } };
const p = new FallbackProvider([fake]);
console.log(typeof p.stream, p.name);
