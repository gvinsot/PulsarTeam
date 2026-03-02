import React, { useEffect } from 'react';
import { Button, Form, Input, InputNumber, Space } from 'antd';
import AgentTemplateSelector from './AgentTemplateSelector';
import AgentTechnicalConfig from './AgentTechnicalConfig';
import type { CreateAgentPayload } from '../../types/agent';

type Props = {
  mode: 'create' | 'edit';
  initialValues?: Partial<CreateAgentPayload>;
  onSubmit: (payload: CreateAgentPayload) => Promise<void>;
  onCancel: () => void;
  sourceAgentId?: string;
};

const AgentForm: React.FC<Props> = ({ mode, initialValues, onSubmit, onCancel }) => {
  const [form] = Form.useForm<CreateAgentPayload>();

  useEffect(() => {
    form.setFieldsValue(initialValues || {});
  }, [initialValues, form]);

  const handleFinish = async (values: CreateAgentPayload) => {
    await onSubmit(values);
  };

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={handleFinish}
      initialValues={initialValues}
      preserve={false}
    >
      <Form.Item
        name="name"
        label="Agent Name"
        rules={[{ required: true, message: 'Please enter agent name' }]}
      >
        <Input placeholder="My Agent" />
      </Form.Item>

      <Form.Item
        name="description"
        label="Description"
      >
        <Input.TextArea rows={3} placeholder="Describe this agent" />
      </Form.Item>

      <AgentTemplateSelector />

      <AgentTechnicalConfig />

      <Form.Item name="temperature" label="Temperature">
        <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
      </Form.Item>

      <Form.Item name="maxTokens" label="Max Tokens">
        <InputNumber min={1} style={{ width: '100%' }} />
      </Form.Item>

      <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="primary" htmlType="submit">
          {mode === 'create' ? 'Create Agent' : 'Save Changes'}
        </Button>
      </Space>
    </Form>
  );
};

export default AgentForm;