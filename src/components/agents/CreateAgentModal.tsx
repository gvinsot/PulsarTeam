import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Select, Space, Typography } from 'antd';
import AgentForm from './AgentForm';
import { useAgents } from '../../hooks/useAgents';
import type { Agent, CreateAgentPayload } from '../../types/agent';

const { Text } = Typography;

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (payload: CreateAgentPayload) => Promise<void>;
};

const TECHNICAL_FIELDS: (keyof CreateAgentPayload)[] = [
  'provider',
  'endpoint',
  'model',
  'apiKey',
  'temperature',
  'maxTokens',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'headers',
  'timeoutMs',
];

function buildPrefillFromSource(source?: Agent | null): Partial<CreateAgentPayload> {
  if (!source) return {};
  const prefill: Partial<CreateAgentPayload> = {};
  for (const key of TECHNICAL_FIELDS) {
    const value = (source as any)[key];
    if (value !== undefined && value !== null) {
      (prefill as any)[key] = value;
    }
  }
  return prefill;
}

const CreateAgentModal: React.FC<Props> = ({ open, onClose, onCreate }) => {
  const { agents, loading } = useAgents();
  const [sourceAgentId, setSourceAgentId] = useState<string | undefined>(undefined);
  const [prefill, setPrefill] = useState<Partial<CreateAgentPayload>>({});

  const sourceOptions = useMemo(
    () =>
      (agents || []).map((a) => ({
        label: a.name,
        value: a.id,
      })),
    [agents]
  );

  const selectedSource = useMemo(
    () => (agents || []).find((a) => a.id === sourceAgentId) || null,
    [agents, sourceAgentId]
  );

  useEffect(() => {
    if (!open) {
      setSourceAgentId(undefined);
      setPrefill({});
      return;
    }
    setPrefill(buildPrefillFromSource(selectedSource));
  }, [open, selectedSource]);

  const handleSourceChange = (id?: string) => {
    setSourceAgentId(id);
    const source = (agents || []).find((a) => a.id === id) || null;
    setPrefill(buildPrefillFromSource(source));
  };

  return (
    <Modal
      title="Create Agent"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
      width={900}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div>
          <Text strong>Copy technical settings from existing agent (optional)</Text>
          <Select
            allowClear
            showSearch
            style={{ width: '100%', marginTop: 8 }}
            placeholder="Select source agent"
            options={sourceOptions}
            loading={loading}
            value={sourceAgentId}
            onChange={handleSourceChange}
            optionFilterProp="label"
          />
          <Text type="secondary">
            This copies provider/API endpoint/model and related runtime settings. You can edit all copied values before saving.
          </Text>
        </div>

        <AgentForm
          mode="create"
          initialValues={prefill}
          onSubmit={onCreate}
          onCancel={onClose}
          sourceAgentId={sourceAgentId}
        />
      </Space>
    </Modal>
  );
};

export default CreateAgentModal;