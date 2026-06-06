/**
 * 嵌入模型设置（语义/向量检索用，独立于聊天模型）。
 * UI 与"AI 接入"的聊天模型配置一致：服务商下拉（带 logo）+ baseURL + Key + 模型 + 测试。
 * 自带 IPC（embedding:getConfig/setConfig/test）。嵌入模型不在 catalog 列表里，故型号为手填。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, ListBox, Select, Switch, TextField } from '@heroui/react'
import { AlertCircle, CheckCircle, Plug } from 'lucide-react'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import { getAIProviders, type AIProviderInfo } from '@/types/ai'
import type { EmbeddingConfig } from '@/types/electron'

const DEFAULT_CFG: EmbeddingConfig = {
  enabled: false,
  provider: '',
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  dimension: 0,
}

function ProviderOptionContent({ info }: { info: AIProviderInfo }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <AIProviderLogo providerId={info.id} logo={info.logo} alt={info.displayName} className="shrink-0" size={18} />
      <strong className="truncate font-medium text-foreground text-sm">{info.displayName}</strong>
    </span>
  )
}

export default function EmbeddingTab() {
  const [cfg, setCfg] = useState<EmbeddingConfig>(DEFAULT_CFG)
  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.embedding.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config })
      setLoaded(true)
    })
    void getAIProviders().then(setProviders)
  }, [])

  const patch = (p: Partial<EmbeddingConfig>) => setCfg((c) => ({ ...c, ...p }))
  const currentProvider = useMemo(() => providers.find((p) => p.id === cfg.provider), [providers, cfg.provider])

  const handleSelectProvider = (providerId: string) => {
    const p = providers.find((x) => x.id === providerId)
    if (!p) {
      patch({ provider: providerId })
      return
    }
    patch({
      provider: providerId,
      protocol: p.protocol === 'openai-responses' ? 'openai' : 'openai-compatible',
      baseURL: p.allowCustomBaseURL ? cfg.baseURL : p.baseURL || cfg.baseURL,
    })
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.test(cfg)
      if (res.success) {
        patch({ dimension: res.dimension || 0 })
        setStatus({ ok: true, text: `连接成功，向量维度 ${res.dimension}` })
      } else {
        setStatus({ ok: false, text: res.error || '测试失败' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.setConfig(cfg)
      setStatus(res.success ? { ok: true, text: '已保存' } : { ok: false, text: res.error || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <Card>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div>
          <Card.Title>语义检索（嵌入模型）</Card.Title>
          <Card.Description>
            供 AI 助手做语义/向量检索，独立于聊天模型。需 OpenAI 兼容的嵌入接口（如硅基流动 bge-m3、通义、智谱、OpenAI）。
          </Card.Description>
        </div>
        <Switch isSelected={cfg.enabled} onChange={(v) => patch({ enabled: v })}>
          启用
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <Select
          fullWidth
          onSelectionChange={(key) => key != null && handleSelectProvider(String(key))}
          placeholder="请选择服务商"
          selectedKey={cfg.provider || null}
          variant="secondary"
        >
          <Label>服务商</Label>
          <Select.Trigger>
            <Select.Value>
              {({ defaultChildren, isPlaceholder }) =>
                isPlaceholder || !currentProvider ? defaultChildren : <ProviderOptionContent info={currentProvider} />
              }
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox className="max-h-72 overflow-auto">
              {providers.map((p) => (
                <ListBox.Item className="shrink-0" id={p.id} key={p.id} textValue={p.displayName}>
                  <ProviderOptionContent info={p} />
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
          <Label>接口 URL（baseURL）</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="https://api.siliconflow.cn/v1" />
          </InputGroup>
          <Description>填 /v1 基地址即可，会自动拼 /embeddings。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="请输入嵌入服务 API Key" type="password" />
          </InputGroup>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>嵌入模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="BAAI/bge-m3" />
          </InputGroup>
          <Description>
            {cfg.dimension > 0 ? `已探测维度：${cfg.dimension}` : '嵌入型号需手填（不在聊天模型列表里），测试连接后自动回填维度。'}
          </Description>
        </TextField>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
            {status.text}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
          <Plug size={16} />
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}
