import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { App as AntApp, Button, Card, Form, Input, InputNumber, Space, Tag, Typography } from 'antd';
import type { ChannelDto, SettingsDto } from '@aihub/shared';

import { getData, mutateData } from '../api.js';
import { channelEndpointUrl } from '../endpoints.js';

interface SettingsForm {
  gatewayToken: string;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

export function SettingsPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<SettingsForm>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [gatewayToken, setGatewayToken] = useState('');
  const [channels, setChannels] = useState<ChannelDto[]>([]);

  useEffect(() => {
    Promise.all([
      getData<SettingsDto>('/api/admin/settings', token),
      getData<ChannelDto[]>('/api/admin/channels', token),
    ])
      .then(([settings, channels]) => {
        form.setFieldsValue({
          gatewayToken: settings.gatewayToken,
          connectTimeoutMs: settings.connectTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        });
        setGatewayToken(settings.gatewayToken);
        setChannels(channels);
      })
      .catch((error) => message.error(error instanceof Error ? error.message : '加载设置失败'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await mutateData<SettingsDto>('/api/admin/settings', token, 'PUT', {
        gatewayToken: values.gatewayToken,
        connectTimeoutMs: values.connectTimeoutMs,
        streamIdleTimeoutMs: values.streamIdleTimeoutMs,
      });
      setGatewayToken(values.gatewayToken);
      message.success('设置已保存，后续请求即时生效');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  }

  const baseUrl = `${window.location.origin}/v1`;
  const firstChannel = channels[0];
  const sampleBaseUrl = firstChannel ? channelEndpointUrl(firstChannel.id) : baseUrl;
  const sampleModel = firstChannel?.models[0] ?? 'your-model';
  const curlExample = [
    `curl ${sampleBaseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer ${gatewayToken || 'YOUR_TOKEN'}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model":"${sampleModel}","messages":[{"role":"user","content":"Hello"}],"stream":false}'`,
  ].join('\n');

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>设置</Typography.Title>
          <Typography.Text type="secondary">网关 token 与两档超时参数</Typography.Text>
        </div>
      </div>

      <Form form={form} layout="vertical" requiredMark={false}>
        <div className="settings-layout">
        <Card title="访问令牌" loading={loading} className="settings-card">
          <Form.Item
            name="gatewayToken"
            label="网关 Bearer Token"
            extra="客户端调用 /v1/* 时使用。修改后立即生效。"
            rules={[{ required: true, message: '网关 token 不能为空' }]}
          >
            <Input.Password />
          </Form.Item>
        </Card>

        <Card title="超时策略" loading={loading} className="settings-card">
          <Form.Item
            name="connectTimeoutMs"
            label="连接超时（毫秒）"
            extra="覆盖连接建立、响应头和首个流式片段。"
            rules={[{ required: true }]}
          >
            <InputNumber min={100} max={300000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="streamIdleTimeoutMs"
            label="流式空闲超时（毫秒）"
            extra="开始输出后，上游两个片段之间的最大间隔。"
            rules={[{ required: true }]}
          >
            <InputNumber min={100} max={3600000} style={{ width: '100%' }} />
          </Form.Item>
        </Card>

      <Card title="客户端接入" className="settings-card settings-card-wide">
        <div className="settings-rows">
          <div className="settings-row">
            <span className="meta-label">BASE URL</span>
            <Typography.Text className="mono" copyable={{ text: baseUrl }}>
              {baseUrl}
            </Typography.Text>
          </div>
          <div className="settings-row">
            <span className="meta-label">BEARER TOKEN</span>
            <Typography.Text className="mono" copyable={{ text: gatewayToken }}>
              {gatewayToken}
            </Typography.Text>
          </div>
          <div className="settings-row">
            <span className="meta-label">渠道接入地址</span>
            <div className="settings-rows">
              {channels.length ? (
                channels.map((channel) => (
                  <div key={channel.id} className="settings-row">
                    <span className="meta-label">{channel.name}</span>
                    <Space direction="vertical" size={4}>
                      <Typography.Text
                        className="mono"
                        copyable={{ text: channelEndpointUrl(channel.id) }}
                      >
                        {channelEndpointUrl(channel.id)}
                      </Typography.Text>
                      <Space wrap>
                        {channel.models.length ? (
                          channel.models.map((model) => <Tag key={model}>{model}</Tag>)
                        ) : (
                          <Typography.Text type="secondary">未添加模型</Typography.Text>
                        )}
                      </Space>
                    </Space>
                  </div>
                ))
              ) : (
                <Typography.Text type="secondary">尚未配置渠道</Typography.Text>
              )}
            </div>
          </div>
          <div className="settings-row">
            <span className="meta-label">CURL 示例</span>
            <Typography.Paragraph className="code-block" copyable={{ text: curlExample }}>
              {curlExample}
            </Typography.Paragraph>
          </div>
        </div>
      </Card>
        </div>
        <div className="settings-actions">
          <Button type="primary" icon={<Save size={16} />} loading={saving} onClick={() => void save()}>
            保存设置
          </Button>
        </div>
      </Form>
    </div>
  );
}
