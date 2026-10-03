// AI 供应商预设（渲染层与主进程共享）
export const AI_PRESETS = {
  openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  zhipu: { label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { label: '月之暗面 Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  anthropic: { label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  ollama: { label: 'Ollama（本地）', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  custom: { label: '自定义供应商', protocol: 'openai', baseUrl: '', model: '' },
};

export const AI_SYSTEM_PROMPT =
  '你是 NebulaShell（星云终端）内置的 SSH/运维 AI 助手。用简体中文回答，风格简洁专业。' +
  '优先给出可直接执行的命令，使用带 bash、sh 或 zsh 语言标签的围栏代码块，说明关键参数与风险。' +
  '命令、输出和解释必须分开；命令块不要包含 $ 或 user@host 等终端提示符。' +
  '普通代码、配置文件和输出使用准确的语言标签，不要标成 shell。' +
  '需要替换的参数必须明确说明，不要将占位符当成可直接执行的命令。' +
  '同一命令块会整体提交；需要检查结果后再执行的步骤必须分成不同代码块。' +
  '你只能给出建议，不会自动执行任何命令；只有用户明确点击执行才会发送到当前终端。';
