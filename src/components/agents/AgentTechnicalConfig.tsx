import React from 'react';
import { Form, Input, InputNumber } from 'antd';

const AgentTechnicalConfig: React.FC = () => {
  return (
    <>
      <Form.Item name="provider" label="Provider">
        <Input placeholder="openai / anthropic / custom" />
      </Form.Item>

      <Form.Item name="endpoint" label="Endpoint">
        <Input placeholder="https://api.example.com/v1" />
      </Form.Item>

      <Form.Item name="model" label="Model">
        <Input placeholder="gpt-4o-mini" />
      </Form.Item>

      <Form.Item
        name="apiKey"
        label="API Key"
        tooltip="Stored securely server-side. Value is never displayed after save."
      >
        <Input.Password placeholder="Enter API key" autoComplete="new-password" />
      </Form.Item>

      <Form.Item name="timeoutMs" label="Timeout (ms)">
        <InputNumber min={1000} step={500} style={{ width: '100%' }} />
      </Form.Item>
    </>
  );
};

export default AgentTechnicalConfig;