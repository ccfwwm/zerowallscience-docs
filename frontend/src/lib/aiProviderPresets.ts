export interface ProviderPreset {
  id: string;
  name: string;
  desc: string;
  url: string;
  defaultModel: string;
  needsKey: boolean;
  color: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "qwen", name: "通义千问", desc: "DashScope OpenAI 兼容接口", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", needsKey: true, color: "from-violet-500 to-blue-500" },
  { id: "openai", name: "OpenAI", desc: "OpenAI 官方接口", url: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", needsKey: true, color: "from-emerald-500 to-teal-500" },
  { id: "gemini", name: "Google Gemini", desc: "Gemini OpenAI 兼容接口", url: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash", needsKey: true, color: "from-blue-500 to-cyan-500" },
  { id: "deepseek", name: "DeepSeek", desc: "DeepSeek 官方接口", url: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", needsKey: true, color: "from-sky-500 to-indigo-500" },
  { id: "doubao", name: "豆包（火山引擎）", desc: "火山方舟 OpenAI 兼容接口", url: "https://ark.cn-beijing.volces.com/api/v3", defaultModel: "doubao-1.5-pro-32k", needsKey: true, color: "from-orange-500 to-pink-500" },
  { id: "ollama", name: "Ollama", desc: "本地或局域网模型", url: "http://localhost:11434/v1", defaultModel: "qwen2.5:7b", needsKey: false, color: "from-zinc-500 to-zinc-700" },
  { id: "custom", name: "自定义 API", desc: "任意 OpenAI 兼容服务", url: "", defaultModel: "", needsKey: true, color: "from-purple-500 to-indigo-500" },
];
