/**
 * 嵌入模型设置（语义/向量检索用，独立于聊天模型）。
 * 自带 IPC（embedding:getConfig/setConfig/test），不走 settingsStore。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, Switch, TextField } from '@heroui/react'
import { AlertCircle, CheckCircle, Plug } from 'lucide-react'
import type { EmbeddingConfig } from '@/types/electron'

const DEFAULT_CFG: EmbeddingConfig = {
  enabled: false,
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  dimension: 0,
}

export default function EmbeddingTab() {
  const [cfg, setCfg] = useState<EmbeddingConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.embedding.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<EmbeddingConfig>) => setCfg((c) => ({ ...c, ...p }))

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
          <Description>{cfg.dimension > 0 ? `已探测维度：${cfg.dimension}` : '测试连接后自动回填向量维度。'}</Description>
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
