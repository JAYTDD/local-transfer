import { useEffect, useState } from 'react';
import {
  Activity,
  CloudDownload,
  Copy,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  verticalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ChannelDto, ChannelTestResult, PullModelsResult } from '@aihub/shared';

import { getData, mutateData } from '../api.js';
import { channelEndpointUrl } from '../endpoints.js';

interface ChannelForm {
  name: string;
  protocol: 'openai' | 'responses' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  defaultMaxTokens: number;
  enabled: boolean;
  models: string[];
}

interface PulledModel {
  id: string;
  displayName?: string;
}

const CUSTOM_PRESET = 'custom';

const CHANNEL_PRESETS: Array<{
  value: string;
  label: string;
  protocol: ChannelForm['protocol'];
  baseUrl: string;
  defaultMaxTokens: number;
}> = [
  {
    value: 'openai',
    label: 'OpenAI Chat',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultMaxTokens: 4096,
  },
  {
    value: 'responses',
    label: 'OpenAI Responses',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    defaultMaxTokens: 4096,
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultMaxTokens: 4096,
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultMaxTokens: 4096,
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultMaxTokens: 4096,
  },
];

const PROTOCOL_LABELS: Record<ChannelForm['protocol'], string> = {
  openai: 'OpenAI',
  responses: 'Responses',
  anthropic: 'Anthropic',
};

const PROTOCOL_COLORS: Record<ChannelForm['protocol'], string> = {
  openai: 'cyan',
  responses: 'blue',
  anthropic: 'gold',
};

interface SortableChannelCardProps {
  channel: ChannelDto;
  testing: boolean;
  onToggle: (channel: ChannelDto, enabled: boolean) => void;
  onTest: (channel: ChannelDto) => void;
  onEdit: (channel: ChannelDto) => void;
  onDuplicate: (channel: ChannelDto) => void;
  onRemove: (channel: ChannelDto) => void;
}

function SortableChannelCard({
  channel,
  testing,
  onToggle,
  onTest,
  onEdit,
  onDuplicate,
  onRemove,
}: SortableChannelCardProps) {
  const { message } = AntApp.useApp();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channel.id,
  });
  const endpointUrl = channelEndpointUrl(channel.id);
  return (
    <div
      ref={setNodeRef}
      data-channel-id={channel.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <Card
        className={`channel-card ${channel.enabled ? '' : 'is-disabled'}`}
      >
        <div className="channel-row">
          <div className="channel-row-identity">
            <Button
              type="text"
              size="small"
              className="drag-handle"
              aria-label={`拖拽排序 ${channel.name}`}
              icon={<GripVertical size={16} />}
              {...attributes}
              {...listeners}
            />
            <span className="status-dot" data-enabled={channel.enabled} />
            <div className="channel-row-title">
              <span className="channel-name">{channel.name}</span>
              <span className="channel-row-sub">
                {channel.models.length} 个模型 · {channel.enabled ? '运行中' : '已停用'}
              </span>
            </div>
            <Tag color={PROTOCOL_COLORS[channel.protocol]}>{PROTOCOL_LABELS[channel.protocol]}</Tag>
          </div>

          <div className="channel-row-meta">
            <div className="channel-meta-item">
              <span className="meta-label">BASE URL</span>
              <span className="mono">{channel.baseUrl}</span>
            </div>
            <div className="channel-meta-item">
              <span className="meta-label">ENDPOINT</span>
              <Space size={4}>
                <span className="mono">{endpointUrl}</span>
                <Tooltip title="复制接入地址">
                  <Button
                    type="text"
                    size="small"
                    aria-label={`复制 ${channel.name} 接入地址`}
                    icon={<Copy size={14} />}
                    onClick={() => {
                      const clipboard = navigator.clipboard;
                      if (!clipboard) {
                        message.error('当前环境不支持剪贴板');
                        return;
                      }
                      void clipboard.writeText(endpointUrl).then(
                        () => message.success('接入地址已复制'),
                        () => message.error('复制失败'),
                      );
                    }}
                  />
                </Tooltip>
              </Space>
            </div>
            <div className="channel-meta-item">
              <span className="meta-label">KEY</span>
              <span className="mono">{channel.apiKeyMasked}</span>
            </div>
            <div className="channel-meta-item">
              <span className="meta-label">MAX TOKENS</span>
              <span className="mono">{channel.defaultMaxTokens}</span>
            </div>
          </div>

          <div className="channel-row-side">
            <div className="channel-row-models">
              {channel.models.length ? (
                <Space size={4} wrap>
                  {channel.models.slice(0, 3).map((model) => (
                    <Tag key={model}>{model}</Tag>
                  ))}
                  {channel.models.length > 3 ? (
                    <Tooltip title={channel.models.slice(3).join(', ')}>
                      <Tag>+{channel.models.length - 3}</Tag>
                    </Tooltip>
                  ) : null}
                </Space>
              ) : (
                <Typography.Text type="secondary">未添加模型</Typography.Text>
              )}
            </div>
            <div className="channel-row-actions">
              <Tooltip title="启用或停用">
                <Switch
                  size="small"
                  checked={channel.enabled}
                  onChange={(checked) => onToggle(channel, checked)}
                />
              </Tooltip>
              <Tooltip title="测试连通性">
                <Button
                  type="text"
                  aria-label={`测试 ${channel.name}`}
                  icon={<Activity size={16} />}
                  loading={testing}
                  onClick={() => onTest(channel)}
                />
              </Tooltip>
              <Tooltip title="编辑">
                <Button
                  type="text"
                  aria-label={`编辑 ${channel.name}`}
                  icon={<Pencil size={16} />}
                  onClick={() => onEdit(channel)}
                />
              </Tooltip>
              <Tooltip title="复制">
                <Button
                  type="text"
                  aria-label={`复制 ${channel.name}`}
                  icon={<Copy size={16} />}
                  onClick={() => onDuplicate(channel)}
                />
              </Tooltip>
              <Tooltip title="删除">
                <Button
                  type="text"
                  danger
                  aria-label={`删除 ${channel.name}`}
                  icon={<Trash2 size={16} />}
                  onClick={() => onRemove(channel)}
                />
              </Tooltip>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function ChannelsPage({ token }: { token: string }) {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm<ChannelForm>();
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ChannelDto | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pulledModels, setPulledModels] = useState<PulledModel[]>([]);
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [preset, setPreset] = useState<string>(CUSTOM_PRESET);
  const [testingId, setTestingId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function load() {
    setLoading(true);
    try {
      setChannels(await getData<ChannelDto[]>('/api/admin/channels', token));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载渠道失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openCreate() {
    setEditing(null);
    setPreset(CUSTOM_PRESET);
    setPulledModels([]);
    form.setFieldsValue({
      name: '',
      protocol: 'openai',
      baseUrl: '',
      apiKey: '',
      defaultMaxTokens: 4096,
      enabled: true,
      models: [],
    });
    setModalOpen(true);
  }

  function openEdit(channel: ChannelDto) {
    setEditing(channel);
    setPreset(CUSTOM_PRESET);
    setPulledModels([]);
    form.setFieldsValue({
      name: channel.name,
      protocol: channel.protocol,
      baseUrl: channel.baseUrl,
      apiKey: '',
      defaultMaxTokens: channel.defaultMaxTokens,
      enabled: channel.enabled,
      models: channel.models,
    });
    setModalOpen(true);
  }

  function applyPreset(value: string) {
    setPreset(value);
    const item = CHANNEL_PRESETS.find((candidate) => candidate.value === value);
    if (!item) return;
    form.setFieldsValue({
      protocol: item.protocol,
      baseUrl: item.baseUrl,
      defaultMaxTokens: item.defaultMaxTokens,
    });
  }

  async function save() {
    const values = await form.validateFields();
    const models = [...new Set((values.models ?? []).map((model) => model.trim()).filter(Boolean))];
    setSaving(true);
    try {
      const payload = {
        ...values,
        models,
        ...(editing && !values.apiKey ? { apiKey: undefined } : {}),
      };
      if (editing) {
        await mutateData(`/api/admin/channels/${editing.id}`, token, 'PUT', payload);
      } else {
        await mutateData('/api/admin/channels', token, 'POST', payload);
      }
      message.success(editing ? '渠道已更新' : '渠道已创建');
      setModalOpen(false);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(channel: ChannelDto, enabled: boolean) {
    try {
      await mutateData(`/api/admin/channels/${channel.id}`, token, 'PATCH', { enabled });
      setChannels((items) => items.map((item) => (item.id === channel.id ? { ...item, enabled } : item)));
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新状态失败');
    }
  }

  function remove(channel: ChannelDto) {
    modal.confirm({
      title: `删除渠道「${channel.name}」？`,
      content: '该渠道下的模型会同时移除，此操作不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        await mutateData(`/api/admin/channels/${channel.id}`, token, 'DELETE');
        message.success('渠道已删除');
        await load();
      },
    });
  }

  async function duplicate(channel: ChannelDto) {
    try {
      await mutateData(`/api/admin/channels/${channel.id}/duplicate`, token, 'POST');
      message.success('渠道已复制');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制失败');
    }
  }

  async function testChannel(channel: ChannelDto) {
    if (channel.models.length === 0) {
      message.warning('请先为渠道添加模型');
      return;
    }
    setTestingId(channel.id);
    try {
      const result = await mutateData<ChannelTestResult>(
        `/api/admin/channels/${channel.id}/test`,
        token,
        'POST',
        {},
      );
      if (result.ok) {
        message.success(`测试通过 · ${result.latencyMs}ms`);
      } else {
        message.error(`测试失败：${result.errorSummary ?? `HTTP ${result.httpStatus}`}`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '测试失败');
    } finally {
      setTestingId(null);
    }
  }

  async function pullModels() {
    const values = await form.validateFields(['name', 'protocol', 'baseUrl', 'apiKey']);
    if (!editing && !values.apiKey) {
      message.warning('新渠道拉取模型前需要填写上游密钥');
      return;
    }
    setPulling(true);
    try {
      const result = await mutateData<PullModelsResult>('/api/admin/channels/pull-models', token, 'POST', {
        ...(editing ? { id: editing.id } : {}),
        protocol: values.protocol,
        baseUrl: values.baseUrl,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      });
      setPulledModels(result.models);
      setModelSelectOpen(true);
      message.success(`拉取到 ${result.models.length} 个模型 · ${result.latencyMs}ms`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '拉取模型失败');
    } finally {
      setPulling(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = channels.findIndex((channel) => channel.id === active.id);
    const newIndex = channels.findIndex((channel) => channel.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const previous = channels;
    const next = arrayMove(channels, oldIndex, newIndex);
    setChannels(next);
    try {
      const updated = await mutateData<ChannelDto[]>('/api/admin/channels/order', token, 'PUT', {
        ids: next.map((channel) => channel.id),
      });
      setChannels(updated);
    } catch (error) {
      setChannels(previous);
      message.error(error instanceof Error ? error.message : '保存渠道顺序失败');
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>渠道</Typography.Title>
          <Typography.Text type="secondary">管理上游协议、地址、密钥、模型与故障转移顺序</Typography.Text>
        </div>
        <Space>
          <Button icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          <Button type="primary" icon={<Plus size={16} />} onClick={openCreate}>
            新建渠道
          </Button>
        </Space>
      </div>

      <div className="stat-strip">
        <div className="stat-item">
          <span className="stat-value">{channels.length}</span>
          <span className="stat-label">渠道总数</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{channels.filter((item) => item.enabled).length}</span>
          <span className="stat-label">启用中</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{channels.reduce((sum, item) => sum + item.models.length, 0)}</span>
          <span className="stat-label">模型总数</span>
        </div>
        <div className="stat-item">
          <span className="stat-value">{new Set(channels.map((item) => item.protocol)).size}</span>
          <span className="stat-label">协议类型</span>
        </div>
      </div>

      {channels.length === 0 && !loading ? (
        <Empty description="还没有配置渠道" />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <SortableContext items={channels.map((channel) => channel.id)} strategy={verticalListSortingStrategy}>
            <div className="channel-list">
              {channels.map((channel) => (
                <SortableChannelCard
                  key={channel.id}
                  channel={channel}
                  testing={testingId === channel.id}
                  onToggle={(item, enabled) => void toggle(item, enabled)}
                  onTest={(item) => void testChannel(item)}
                  onEdit={openEdit}
                  onDuplicate={(item) => void duplicate(item)}
                  onRemove={remove}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <Modal
        title={editing ? '编辑渠道' : '新建渠道'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存"
        width={620}
        footer={(_, { OkBtn, CancelBtn }) => (
          <Space>
            <Button
              icon={<CloudDownload size={16} />}
              loading={pulling}
              onClick={() => void pullModels()}
            >
              拉取模型
            </Button>
            <CancelBtn />
            <OkBtn />
          </Space>
        )}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            label="快速预设"
            extra="选择后自动填充协议、地址与默认 max_tokens，不影响名称与密钥"
          >
            <Select
              aria-label="渠道预设"
              value={preset}
              onChange={applyPreset}
              options={[
                { value: CUSTOM_PRESET, label: '自定义' },
                ...CHANNEL_PRESETS.map((item) => ({ value: item.value, label: item.label })),
              ]}
            />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
            <Input placeholder="例如 DeepSeek 主线路" />
          </Form.Item>
          <Form.Item name="protocol" label="上游协议" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'openai', label: 'OpenAI 兼容 chat completions' },
                { value: 'responses', label: 'OpenAI Responses API' },
                { value: 'anthropic', label: 'Anthropic Messages API' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            extra="包含版本路径，例如 https://api.openai.com/v1"
            rules={[{ required: true, type: 'url', message: '请输入完整 URL' }]}
          >
            <Input placeholder="https://api.example.com/v1" />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label={editing ? '上游密钥（留空保持不变）' : '上游密钥'}
            rules={editing ? [] : [{ required: true, message: '请输入上游密钥' }]}
          >
            <Input.Password placeholder={editing ? '留空保持不变' : 'sk-...'} />
          </Form.Item>
          <Form.Item name="models" label="模型" extra="支持搜索选择或直接输入模型 ID">
            <Select
              mode="tags"
              open={modelSelectOpen}
              onOpenChange={(open) => setModelSelectOpen(open)}
              placeholder="选择或输入上游模型 ID"
              optionFilterProp="label"
              options={pulledModels.map((model) => ({
                value: model.id,
                label: model.displayName ? `${model.id} · ${model.displayName}` : model.id,
              }))}
            />
          </Form.Item>
          <Space size="large" align="start">
            <Form.Item name="defaultMaxTokens" label="默认 max_tokens" rules={[{ required: true }]}>
              <InputNumber min={1} max={200000} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
