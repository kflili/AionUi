/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Message, Select, Switch } from '@arco-design/web-react';
import { Copy, Delete, Plus, Refresh } from '@icon-park/react';
import { DEFAULT_CALLBACK_BODY, DEFAULT_JS_FILTER_SCRIPT } from '@/common/apiCallback';
import { ipcBridge } from '@/common';
import { ConfigStorage, type IApiConfig, type IProvider } from '@/common/storage';
import { getDefaultAcpConfigOptions } from '@/common/codex/codexConfigOptions';
import { getAgentModes } from '@/renderer/constants/agentModes';
import AcpModelSelector from '@/renderer/components/AcpModelSelector';
import AgentModeSelector from '@/renderer/components/AgentModeSelector';
import GuidAcpConfigSelector from '@/renderer/pages/guid/components/GuidAcpConfigSelector';
import type { AcpBackend, AcpModelInfo, AcpSessionConfigOption } from '@/types/acpTypes';
import type { IWebUIStatus } from '@/common/ipcBridge';

type HeaderItem = { key: string; value: string };
type ConversationType = 'gemini' | 'acp' | 'codex' | 'openclaw-gateway' | 'nanobot';

type CliOption = {
  value: string;
  label: string;
  conversationType: ConversationType;
  backend?: AcpBackend;
  cliPath?: string;
  customAgentId?: string;
};

type ProviderModelOption = {
  value: string;
  label: string;
  provider: IProvider;
  modelId: string;
};

type CliModelOption = {
  value: string;
  label: string;
};

const DEFAULT_MESSAGE = 'Hello from AionUi API';

const PreferenceRow: React.FC<{
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className='flex items-center justify-between gap-12px py-12px'>
    <div className='min-w-0 flex-1'>
      <div className='text-14px text-t-primary'>{label}</div>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex items-center shrink-0'>{children}</div>
  </div>
);

const generateApiToken = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(64);

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes)
    .map((v) => chars[v % chars.length])
    .join('');
};

const parseOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const parseOptionalAcpBackend = (value: unknown): AcpBackend | undefined => {
  const trimmed = parseOptionalString(value);
  return trimmed as AcpBackend | undefined;
};

const parseHeaders = (source?: Record<string, string>): HeaderItem[] => {
  if (!source) return [];
  return Object.entries(source).map(([key, value]) => ({ key, value: String(value ?? '') }));
};

const createProviderModelOptions = (providers: IProvider[] | null | undefined): ProviderModelOption[] => {
  if (!providers || !Array.isArray(providers)) {
    return [];
  }

  const options: ProviderModelOption[] = [];
  for (const provider of providers) {
    if (!provider?.id || !Array.isArray(provider.model)) {
      continue;
    }

    for (const modelId of provider.model) {
      options.push({
        value: `${provider.id}::${modelId}`,
        label: `${provider.name || provider.id} / ${modelId}`,
        provider,
        modelId,
      });
    }
  }

  return options;
};

const getFallbackModel = () => ({
  id: 'default-provider',
  platform: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '***',
  useModel: 'gpt-4o-mini',
});

const buildCliOptions = (
  agents: Array<{
    backend?: AcpBackend;
    name?: string;
    cliPath?: string;
    customAgentId?: string;
  }>
): CliOption[] => {
  const options: CliOption[] = [];

  for (const agent of agents) {
    const backend = parseOptionalAcpBackend(agent.backend);
    const name = parseOptionalString(agent.name);
    const cliPath = parseOptionalString(agent.cliPath);
    const customAgentId = parseOptionalString(agent.customAgentId);

    if (!backend || !name) {
      continue;
    }

    let conversationType: ConversationType = 'acp';
    if (backend === 'gemini' && !cliPath) {
      conversationType = 'gemini';
    } else if (backend === 'openclaw-gateway') {
      conversationType = 'openclaw-gateway';
    } else if (backend === 'nanobot') {
      conversationType = 'nanobot';
    }

    const value = `agent:${backend}:${customAgentId || ''}:${cliPath || ''}:${name}`;
    options.push({
      value,
      label: customAgentId ? `${name} (${backend} / custom)` : `${name} (${backend})`,
      conversationType,
      backend,
      cliPath,
      customAgentId,
    });
  }

  const hasGemini = options.some((item) => item.conversationType === 'gemini');
  if (!hasGemini) {
    options.unshift({
      value: 'builtin:gemini',
      label: 'Gemini (Built-in)',
      conversationType: 'gemini',
      backend: 'gemini',
    });
  }

  const dedup = new Map<string, CliOption>();
  for (const item of options) {
    if (!dedup.has(item.value)) {
      dedup.set(item.value, item);
    }
  }

  const merged = Array.from(dedup.values());
  merged.sort((a, b) => {
    if (a.conversationType === 'gemini' && b.conversationType !== 'gemini') return -1;
    if (a.conversationType !== 'gemini' && b.conversationType === 'gemini') return 1;
    return a.label.localeCompare(b.label);
  });

  return merged;
};

const ApiSettingsContent: React.FC = () => {
  const [config, setConfig] = useState<Partial<IApiConfig>>({
    enabled: false,
    callbackEnabled: false,
    callbackMethod: 'POST',
    callbackHeaders: {},
    callbackBody: DEFAULT_CALLBACK_BODY,
    jsFilterEnabled: false,
    jsFilterScript: DEFAULT_JS_FILTER_SCRIPT,
  });
  const [headers, setHeaders] = useState<HeaderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [webuiStatus, setWebuiStatus] = useState<IWebUIStatus | null>(null);

  const [cliOptions, setCliOptions] = useState<CliOption[]>([]);
  const [providerModelOptions, setProviderModelOptions] = useState<ProviderModelOption[]>([]);
  const [acpCachedModels, setAcpCachedModels] = useState<Record<string, AcpModelInfo>>({});
  const [acpPreferredModelIds, setAcpPreferredModelIds] = useState<Record<string, string | undefined>>({});
  const [acpCachedConfigOptions, setAcpCachedConfigOptions] = useState<Record<string, AcpSessionConfigOption[]>>({});
  const [acpPreferredConfigOptions, setAcpPreferredConfigOptions] = useState<Record<string, Record<string, string>>>({});

  const [selectedCli, setSelectedCli] = useState<string>('');
  const [selectedProviderModel, setSelectedProviderModel] = useState<string>('');
  const [selectedCliModel, setSelectedCliModel] = useState<string>('');
  const [selectedCliConfigOptions, setSelectedCliConfigOptions] = useState<Record<string, string>>({});
  const [selectedMode, setSelectedMode] = useState<string>('default');
  const [workspace, setWorkspace] = useState<string>('');
  const [message, setMessage] = useState<string>(DEFAULT_MESSAGE);

  const loadApiConfig = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipcBridge.database.getApiConfig.invoke();
      if (result) {
        setConfig({
          ...result,
          callbackEnabled: result.callbackEnabled ?? !!result.callbackUrl,
          callbackBody: result.callbackBody || DEFAULT_CALLBACK_BODY,
          jsFilterEnabled: result.jsFilterEnabled ?? false,
          jsFilterScript: result.jsFilterScript || DEFAULT_JS_FILTER_SCRIPT,
        });
        setHeaders(parseHeaders(result.callbackHeaders));
      } else {
        setConfig((prev) => ({
          ...prev,
          callbackEnabled: false,
          callbackBody: DEFAULT_CALLBACK_BODY,
          jsFilterEnabled: false,
          jsFilterScript: DEFAULT_JS_FILTER_SCRIPT,
        }));
        setHeaders([]);
      }
    } catch (error) {
      console.error('[ApiSettings] Failed to load config:', error);
      Message.error('加载 API 配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadGeneratorOptions = useCallback(async () => {
    try {
      const [providers, agentsResult, cachedModels, cachedConfigOptions, acpConfig] = await Promise.all([ipcBridge.mode.getModelConfig.invoke(), ipcBridge.acpConversation.getAvailableAgents.invoke(), ConfigStorage.get('acp.cachedModels'), ConfigStorage.get('acp.cachedConfigOptions'), ConfigStorage.get('acp.config')]);

      const nextProviderOptions = createProviderModelOptions(providers);
      setProviderModelOptions(nextProviderOptions);
      if (nextProviderOptions.length > 0) {
        setSelectedProviderModel((prev) => prev || nextProviderOptions[0].value);
      }

      setAcpCachedModels(cachedModels || {});
      setAcpCachedConfigOptions(cachedConfigOptions || {});

      const preferredMap: Record<string, string | undefined> = {};
      const preferredConfigMap: Record<string, Record<string, string>> = {};
      for (const [backend, backendConfig] of Object.entries(acpConfig || {})) {
        preferredMap[backend] = parseOptionalString((backendConfig as { preferredModelId?: unknown })?.preferredModelId);
        preferredConfigMap[backend] = { ...(((backendConfig as { preferredConfigOptions?: Record<string, string> })?.preferredConfigOptions || {}) as Record<string, string>) };
      }
      setAcpPreferredModelIds(preferredMap);
      setAcpPreferredConfigOptions(preferredConfigMap);

      const agents = agentsResult?.success && Array.isArray(agentsResult.data) ? agentsResult.data : [];
      const nextCliOptions = buildCliOptions(
        agents as Array<{
          backend?: AcpBackend;
          name?: string;
          cliPath?: string;
          customAgentId?: string;
        }>
      );
      setCliOptions(nextCliOptions);
      setSelectedCli((prev) => (nextCliOptions.some((item) => item.value === prev) ? prev : nextCliOptions[0]?.value || ''));
    } catch (error) {
      console.error('[ApiSettings] Failed to load generator options:', error);
    }
  }, []);

  const loadWebuiStatus = useCallback(async () => {
    try {
      const result = await ipcBridge.webui.getStatus.invoke();
      if (result?.success && result.data) {
        setWebuiStatus(result.data);
        return;
      }
      setWebuiStatus(null);
    } catch (error) {
      console.error('[ApiSettings] Failed to load WebUI status:', error);
      setWebuiStatus(null);
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadApiConfig(), loadGeneratorOptions(), loadWebuiStatus()]);
  }, [loadApiConfig, loadGeneratorOptions, loadWebuiStatus]);

  useEffect(() => {
    const unsubscribe = ipcBridge.webui.statusChanged.on(() => {
      void loadWebuiStatus();
    });
    return () => unsubscribe();
  }, [loadWebuiStatus]);

  const selectedCliOption = useMemo(() => {
    return cliOptions.find((item) => item.value === selectedCli) || cliOptions[0];
  }, [cliOptions, selectedCli]);

  const usingAcpModelSource = selectedCliOption?.conversationType === 'acp' && !!selectedCliOption.backend;
  const requiresProviderModel = selectedCliOption?.conversationType === 'gemini';
  const currentCliBackend = selectedCliOption?.conversationType === 'acp' ? selectedCliOption.backend : undefined;

  const cliModelOptions = useMemo<CliModelOption[]>(() => {
    if (!usingAcpModelSource || !selectedCliOption?.backend) {
      return [];
    }
    const modelInfo = acpCachedModels[selectedCliOption.backend];
    if (!modelInfo?.availableModels?.length) {
      return [];
    }
    return modelInfo.availableModels.map((item) => ({
      value: item.id,
      label: item.label || item.id,
    }));
  }, [usingAcpModelSource, selectedCliOption, acpCachedModels]);

  const selectedCliLocalModelInfo = useMemo<AcpModelInfo | null>(() => {
    if (!usingAcpModelSource || !selectedCliOption?.backend) {
      return null;
    }

    const modelInfo = acpCachedModels[selectedCliOption.backend];
    if (!modelInfo?.availableModels?.length) {
      return null;
    }

    const effectiveModelId = selectedCliModel || modelInfo.currentModelId || modelInfo.availableModels[0]?.id || null;
    const matchedModel = effectiveModelId ? modelInfo.availableModels.find((item) => item.id === effectiveModelId) : undefined;

    return {
      ...modelInfo,
      canSwitch: true,
      currentModelId: effectiveModelId,
      currentModelLabel: matchedModel?.label || modelInfo.currentModelLabel || effectiveModelId || '',
    };
  }, [usingAcpModelSource, selectedCliOption, acpCachedModels, selectedCliModel]);
  const selectedCliInitialModelId = selectedCliModel || selectedCliLocalModelInfo?.currentModelId || undefined;

  useEffect(() => {
    if (!usingAcpModelSource || !selectedCliOption?.backend) {
      setSelectedCliModel('');
      return;
    }

    const backend = selectedCliOption.backend;
    const preferred = acpPreferredModelIds[backend];
    const cachedCurrent = acpCachedModels[backend]?.currentModelId || undefined;
    const fallback = cliModelOptions[0]?.value;
    const candidate = preferred || cachedCurrent || fallback || '';

    setSelectedCliModel((prev) => {
      if (prev && cliModelOptions.some((item) => item.value === prev)) {
        return prev;
      }
      return candidate;
    });
  }, [usingAcpModelSource, selectedCliOption, acpPreferredModelIds, acpCachedModels, cliModelOptions]);

  const currentCliConfigOptions = useMemo<AcpSessionConfigOption[]>(() => {
    if (!currentCliBackend) {
      return [];
    }

    const cachedOptions = acpCachedConfigOptions[currentCliBackend] || [];
    return cachedOptions.length > 0 ? cachedOptions : getDefaultAcpConfigOptions(currentCliBackend);
  }, [currentCliBackend, acpCachedConfigOptions]);

  useEffect(() => {
    if (!currentCliBackend) {
      setSelectedCliConfigOptions({});
      return;
    }

    const preferredOptions = acpPreferredConfigOptions[currentCliBackend] || {};
    const nextSelectedOptions = currentCliConfigOptions.reduce<Record<string, string>>((acc, option) => {
      const preferredValue = preferredOptions[option.id];
      if (!preferredValue) {
        return acc;
      }

      const isValueAvailable = option.options?.some((choice) => choice.value === preferredValue) ?? true;
      if (isValueAvailable) {
        acc[option.id] = preferredValue;
      }

      return acc;
    }, {});

    setSelectedCliConfigOptions(nextSelectedOptions);
  }, [currentCliBackend, currentCliConfigOptions, acpPreferredConfigOptions]);

  const modeBackend = useMemo(() => {
    if (!selectedCliOption) return undefined;
    if (selectedCliOption.conversationType === 'acp') return selectedCliOption.backend;
    if (selectedCliOption.conversationType === 'gemini') return 'gemini';
    if (selectedCliOption.conversationType === 'codex') return 'codex';
    return undefined;
  }, [selectedCliOption]);

  const modeOptions = useMemo(() => {
    const options = getAgentModes(modeBackend);
    if (options.length > 0) {
      return options;
    }
    return [{ value: 'default', label: 'Default' }];
  }, [modeBackend]);
  const canUseModeSelector = Boolean(modeBackend && getAgentModes(modeBackend).length > 0);

  useEffect(() => {
    if (!modeOptions.some((item) => item.value === selectedMode)) {
      setSelectedMode(modeOptions[0]?.value || 'default');
    }
  }, [modeOptions, selectedMode]);

  const selectedProviderModelOption = useMemo(() => {
    if (!selectedProviderModel) {
      return providerModelOptions[0];
    }
    return providerModelOptions.find((item) => item.value === selectedProviderModel) || providerModelOptions[0];
  }, [providerModelOptions, selectedProviderModel]);

  const generatedPayload = useMemo(() => {
    const conversationType = selectedCliOption?.conversationType || 'gemini';
    const payload: Record<string, unknown> = {
      type: conversationType,
      cli: selectedCliOption?.backend || conversationType,
      message: message.trim() || DEFAULT_MESSAGE,
    };

    if (requiresProviderModel) {
      payload.model = selectedProviderModelOption
        ? (() => {
            const { model: _modelList, ...base } = selectedProviderModelOption.provider;
            return {
              ...base,
              useModel: selectedProviderModelOption.modelId,
            };
          })()
        : getFallbackModel();
    }

    if (workspace.trim()) {
      payload.workspace = workspace.trim();
    }

    if (conversationType === 'acp') {
      if (selectedCliOption?.backend) payload.backend = selectedCliOption.backend;
      if (selectedCliOption?.cliPath) payload.cliPath = selectedCliOption.cliPath;
      if (selectedCliOption?.customAgentId) payload.customAgentId = selectedCliOption.customAgentId;
      if (selectedMode) payload.mode = selectedMode;

      const effectiveCliModel = selectedCliModel || (selectedCliOption?.backend ? acpCachedModels[selectedCliOption.backend]?.currentModelId : undefined);
      if (effectiveCliModel) {
        payload.currentModelId = effectiveCliModel;
      }
      if (Object.keys(selectedCliConfigOptions).length > 0) {
        payload.configOptionValues = selectedCliConfigOptions;
      }
    } else if (conversationType === 'gemini' || conversationType === 'codex') {
      if (selectedMode) payload.mode = selectedMode;
      if (conversationType === 'codex' && selectedCliModel) {
        payload.codexModel = selectedCliModel;
      }
    }

    return payload;
  }, [requiresProviderModel, selectedProviderModelOption, selectedCliOption, message, workspace, selectedMode, selectedCliModel, selectedCliConfigOptions, acpCachedModels]);

  const generatedPayloadText = useMemo(() => JSON.stringify(generatedPayload, null, 2), [generatedPayload]);
  const docsUrl = useMemo(() => {
    const base = webuiStatus?.localUrl || 'http://localhost:25808';
    return `${base}/api/docs`;
  }, [webuiStatus?.localUrl]);
  const canDirectAccessDocs = !!webuiStatus?.running;
  const callbackEnabled = !!config.callbackEnabled;
  const jsFilterEnabled = !!config.jsFilterEnabled;

  const handleGenerateToken = useCallback(() => {
    const token = generateApiToken();
    setConfig((prev) => ({ ...prev, authToken: token }));
    Message.success('已生成新的 API Token');
  }, []);

  const handleCopy = useCallback((text: string, successText: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => Message.success(successText))
      .catch(() => Message.error('复制失败'));
  }, []);

  const handleAddHeader = useCallback(() => {
    setHeaders((prev) => [...prev, { key: '', value: '' }]);
  }, []);

  const handleDeleteHeader = useCallback((index: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleUpdateHeader = useCallback((index: number, field: keyof HeaderItem, value: string) => {
    setHeaders((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaveLoading(true);
    try {
      const callbackHeaders: Record<string, string> = {};
      for (const item of headers) {
        const key = item.key.trim();
        const value = item.value.trim();
        if (key && value) {
          callbackHeaders[key] = value;
        }
      }

      const result = await ipcBridge.database.saveApiConfig.invoke({
        ...config,
        callbackEnabled,
        callbackHeaders: Object.keys(callbackHeaders).length ? callbackHeaders : undefined,
        callbackBody: config.callbackBody?.trim() ? config.callbackBody : DEFAULT_CALLBACK_BODY,
        jsFilterEnabled,
        jsFilterScript: config.jsFilterScript?.trim() ? config.jsFilterScript : DEFAULT_JS_FILTER_SCRIPT,
      });

      if (result.success) {
        Message.success('API 配置已保存');
        await loadApiConfig();
        return;
      }

      Message.error(`保存失败: ${result.error || '未知错误'}`);
    } catch (error) {
      console.error('[ApiSettings] Save config error:', error);
      Message.error('保存 API 配置失败');
    } finally {
      setSaveLoading(false);
    }
  }, [callbackEnabled, config, headers, jsFilterEnabled, loadApiConfig]);

  const handleEnabledChange = useCallback(
    async (checked: boolean) => {
      const previousEnabled = !!config.enabled;
      setConfig((prev) => ({ ...prev, enabled: checked }));
      setToggleLoading(true);

      try {
        const result = await ipcBridge.database.updateApiEnabled.invoke({ enabled: checked });
        if (result.success) {
          Message.success(checked ? 'HTTP API 已开启' : 'HTTP API 已关闭');
          await loadApiConfig();
          return;
        }

        setConfig((prev) => ({ ...prev, enabled: previousEnabled }));
        Message.error(`切换失败: ${result.error || '未知错误'}`);
      } catch (error) {
        console.error('[ApiSettings] Toggle API enabled error:', error);
        setConfig((prev) => ({ ...prev, enabled: previousEnabled }));
        Message.error('切换 API 开关失败');
      } finally {
        setToggleLoading(false);
      }
    },
    [config.enabled, loadApiConfig]
  );

  const handleOpenDocs = useCallback(() => {
    if (!canDirectAccessDocs) {
      Message.warning('请先启用 WebUI，再访问 Swagger 文档');
      return;
    }
    void ipcBridge.shell.openExternal.invoke(docsUrl);
  }, [canDirectAccessDocs, docsUrl]);

  if (loading) {
    return (
      <div className='flex items-center justify-center h-400px'>
        <div className='text-t-tertiary'>加载 API 配置中...</div>
      </div>
    );
  }

  return (
    <div className='p-20px'>
      <div className='mb-20px'>
        <h3 className='text-16px font-600 text-t-primary mb-8px'>本地 HTTP API</h3>
        <p className='text-12px text-t-tertiary'>Swagger 文档已整合到本地客户端此页面，`/api/docs` 与 `/api/openapi.json` 现在需要登录态访问，不再免登暴露。</p>
      </div>
      <div className='mb-20px'>
        <h4 className='text-13px font-600 text-t-primary mb-8px'>Swagger 接口文档</h4>
        <div className='text-12px text-t-tertiary mb-12px'>
          需要先启用 WebUI，才可以直接访问 Swagger 页面。当前状态：
          <span className={`ml-6px ${canDirectAccessDocs ? 'text-[rgb(var(--green-6))]' : 'text-[rgb(var(--orange-6))]'}`}>{canDirectAccessDocs ? 'WebUI 已启用' : 'WebUI 未启用'}</span>
        </div>
        <div className='flex gap-8px mb-10px'>
          <Input value={docsUrl} readOnly className='flex-1' />
          <Button icon={<Copy />} onClick={() => handleCopy(docsUrl, 'Swagger 链接已复制')}>
            复制链接
          </Button>
          <Button type='primary' onClick={handleOpenDocs} disabled={!canDirectAccessDocs}>
            打开文档
          </Button>
        </div>
      </div>

      <PreferenceRow label='启用 HTTP API' description='开启后可通过 /api/v1/conversation/* 访问本地能力'>
        <Switch checked={!!config.enabled} loading={toggleLoading} disabled={toggleLoading} onChange={handleEnabledChange} />
      </PreferenceRow>

      <div className='border-t border-border-secondary my-16px' />

      <div className='mb-20px'>
        <label className='text-14px text-t-primary mb-8px block'>API Token</label>
        <div className='flex gap-8px'>
          <Input value={config.authToken || ''} readOnly className='flex-1' placeholder='64 位随机 Token' />
          <Button icon={<Refresh />} onClick={handleGenerateToken}>
            生成
          </Button>
          <Button icon={<Copy />} onClick={() => handleCopy(config.authToken || '', 'Token 已复制')} disabled={!config.authToken}>
            复制
          </Button>
        </div>
        <div className='text-12px text-t-tertiary mt-4px'>请求头格式: Authorization: Bearer {'{token}'}</div>
      </div>

      <div className='border-t border-border-secondary my-16px' />

      <div className='mb-20px rounded border border-border-secondary bg-bg-secondary p-12px text-12px text-t-tertiary'>会话运行时诊断能力已迁移到独立扩展页“API 诊断”，方便单独迭代和调试。</div>

      <div className='border-t border-border-secondary my-16px' />

      <div className='mb-20px'>
        <h4 className='text-14px font-600 text-t-primary mb-12px'>回调配置</h4>
        <p className='text-12px text-t-tertiary mb-16px'>会话完成后可自动回调到你的服务端。</p>

        <PreferenceRow label='开启回调' description='默认关闭，开启后会在会话完成时按下方配置发送回调请求'>
          <Switch checked={callbackEnabled} onChange={(checked) => setConfig((prev) => ({ ...prev, callbackEnabled: checked }))} />
        </PreferenceRow>

        {callbackEnabled ? (
          <>
            <div className='mb-12px'>
              <label className='text-13px text-t-primary mb-6px block'>回调 URL</label>
              <Input value={config.callbackUrl || ''} onChange={(value) => setConfig((prev) => ({ ...prev, callbackUrl: value }))} placeholder='https://your-server.com/webhook' />
            </div>

            <div className='mb-12px'>
              <label className='text-13px text-t-primary mb-6px block'>请求方法</label>
              <Select
                value={config.callbackMethod || 'POST'}
                onChange={(value) => setConfig((prev) => ({ ...prev, callbackMethod: value as IApiConfig['callbackMethod'] }))}
                options={[
                  { label: 'POST', value: 'POST' },
                  { label: 'GET', value: 'GET' },
                  { label: 'PUT', value: 'PUT' },
                ]}
                style={{ width: 160 }}
              />
            </div>

            <div className='mb-12px'>
              <div className='flex items-center justify-between mb-6px'>
                <label className='text-13px text-t-primary'>请求头</label>
                <Button size='mini' icon={<Plus />} onClick={handleAddHeader}>
                  添加
                </Button>
              </div>

              {headers.length === 0 && <div className='text-12px text-t-tertiary text-center py-12px bg-bg-secondary rounded'>暂无自定义请求头</div>}

              {headers.map((item, index) => (
                <div key={`${item.key}-${index}`} className='flex gap-8px mb-8px'>
                  <Input value={item.key} onChange={(value) => handleUpdateHeader(index, 'key', value)} placeholder='Header 名称' className='flex-1' />
                  <Input value={item.value} onChange={(value) => handleUpdateHeader(index, 'value', value)} placeholder='Header 值' className='flex-1' />
                  <Button size='small' status='danger' icon={<Delete />} onClick={() => handleDeleteHeader(index)} />
                </div>
              ))}
            </div>

            <div className='mb-12px'>
              <label className='text-13px text-t-primary mb-6px block'>回调请求体 (JSON)</label>
              <Input.TextArea value={config.callbackBody || DEFAULT_CALLBACK_BODY} onChange={(value) => setConfig((prev) => ({ ...prev, callbackBody: value }))} style={{ minHeight: 180, fontFamily: 'monospace' }} />
              <div className='text-12px text-t-tertiary mt-4px'>
                支持变量: {'{{sessionId}}'}, {'{{workspace}}'}, {'{{model}}'}, {'{{conversationHistory}}'}, {'{{lastMessage}}'}, {'{{status}}'}, {'{{state}}'}, {'{{detail}}'}, {'{{canSendMessage}}'}, {'{{runtime}}'}, {'{{jsFitterStr}}'}
              </div>
            </div>

            <div className='mb-12px'>
              <PreferenceRow label='开启 JS 过滤' description='关闭时 {{jsFitterStr}} 默认为空字符串；开启后会执行下方 jsFilter(input) 并返回字符串'>
                <Switch checked={jsFilterEnabled} onChange={(checked) => setConfig((prev) => ({ ...prev, jsFilterEnabled: checked }))} />
              </PreferenceRow>
            </div>

            <div className='mb-12px'>
              <div className='flex items-center justify-between mb-6px'>
                <label className='text-13px text-t-primary'>JS 过滤脚本</label>
                <Button size='mini' onClick={() => setConfig((prev) => ({ ...prev, jsFilterScript: DEFAULT_JS_FILTER_SCRIPT }))}>
                  恢复示例
                </Button>
              </div>
              <Input.TextArea value={config.jsFilterScript || DEFAULT_JS_FILTER_SCRIPT} onChange={(value) => setConfig((prev) => ({ ...prev, jsFilterScript: value }))} style={{ minHeight: 220, fontFamily: 'monospace' }} />
              <div className='text-12px text-t-tertiary mt-4px'>
                需要定义 <code>jsFilter(input)</code> 函数。默认入参包含 sessionId、workspace、model、lastMessage、conversationHistory，返回值会被写入 {'{{jsFitterStr}}'}。
              </div>
            </div>
          </>
        ) : (
          <div className='text-12px text-t-tertiary bg-bg-secondary rounded p-12px'>当前未开启回调，开启后才会显示并生效回调 URL、请求头和请求体配置。</div>
        )}
      </div>

      <div className='border-t border-border-secondary my-16px' />

      <div className='mb-20px'>
        <h4 className='text-14px font-600 text-t-primary mb-12px'>/api/v1/conversation/create 参数生成器</h4>
        <p className='text-12px text-t-tertiary mb-16px'>CLI、模式和 CLI 模型都复用了现有会话侧的检测/缓存逻辑；ACP/CLI 请求不会再额外注入无意义的 provider model。</p>

        <div className='grid grid-cols-1 md:grid-cols-2 gap-12px mb-12px'>
          <div>
            <label className='text-13px text-t-primary mb-6px block'>CLI</label>
            <Select value={selectedCli} onChange={setSelectedCli} options={cliOptions.map((item) => ({ label: item.label, value: item.value }))} placeholder='选择 CLI' />
          </div>

          {usingAcpModelSource ? (
            <div>
              <label className='text-13px text-t-primary mb-6px block'>CLI 模型</label>
              <div className='min-h-32px flex items-center gap-8px'>
                <AcpModelSelector backend={selectedCliOption?.backend} initialModelId={selectedCliInitialModelId} localModelInfo={selectedCliLocalModelInfo} onSelectModel={setSelectedCliModel} />
              </div>
              {!cliModelOptions.length && <div className='text-12px text-t-tertiary mt-4px'>暂无缓存模型，请先在该 CLI 会话里拉取一次模型列表。</div>}
            </div>
          ) : requiresProviderModel ? (
            <div>
              <label className='text-13px text-t-primary mb-6px block'>模型</label>
              <Select value={selectedProviderModel || providerModelOptions[0]?.value} onChange={setSelectedProviderModel} options={providerModelOptions.map((item) => ({ label: item.label, value: item.value }))} placeholder={providerModelOptions.length ? '选择模型' : '未检测到平台模型，使用占位模型'} allowClear={false} />
            </div>
          ) : (
            <div>
              <label className='text-13px text-t-primary mb-6px block'>模型</label>
              <div className='min-h-32px flex items-center text-12px text-t-tertiary'>当前 CLI 类型不需要单独传 `model`。</div>
            </div>
          )}

          <div>
            <label className='text-13px text-t-primary mb-6px block'>模式 (mode)</label>
            <div className='min-h-32px flex items-center gap-8px'>{canUseModeSelector ? <AgentModeSelector backend={modeBackend} compact initialMode={selectedMode} onModeSelect={setSelectedMode} modeLabelFormatter={(mode) => mode.label} compactLabelPrefix='Mode' /> : <Select value={selectedMode} onChange={setSelectedMode} options={modeOptions.map((item) => ({ label: item.label, value: item.value }))} allowClear={false} />}</div>
          </div>

          <div>
            <label className='text-13px text-t-primary mb-6px block'>CLI 对话选项</label>
            <div className='min-h-32px flex flex-wrap items-center gap-8px'>
              <GuidAcpConfigSelector
                backend={currentCliBackend}
                configOptions={currentCliConfigOptions}
                selectedValues={selectedCliConfigOptions}
                onSelectOption={(configId, value) => {
                  setSelectedCliConfigOptions((prev) => ({
                    ...prev,
                    [configId]: value,
                  }));
                }}
              />
              {currentCliBackend && currentCliConfigOptions.length === 0 ? <span className='text-12px text-t-tertiary'>当前 CLI 没有额外会话选项。</span> : null}
              {!currentCliBackend ? <span className='text-12px text-t-tertiary'>选择支持的 ACP/Codex CLI 后，这里会显示对应对话选项。</span> : null}
            </div>
          </div>

          <div>
            <label className='text-13px text-t-primary mb-6px block'>工作空间 (workspace，可选)</label>
            <Input value={workspace} onChange={setWorkspace} allowClear placeholder='留空则使用 AionUi 默认工作空间' />
          </div>
        </div>

        <div className='mb-12px'>
          <label className='text-13px text-t-primary mb-6px block'>首条消息 (message)</label>
          <Input value={message} onChange={setMessage} placeholder='例如：请先扫描工作区并总结项目结构' />
        </div>

        <div className='mb-8px flex items-center justify-between'>
          <label className='text-13px text-t-primary'>生成结果</label>
          <div className='flex items-center gap-8px'>
            <Button size='small' onClick={() => void loadGeneratorOptions()}>
              刷新来源
            </Button>
            <Button size='small' icon={<Copy />} onClick={() => handleCopy(generatedPayloadText, '请求体已复制')}>
              复制 JSON
            </Button>
          </div>
        </div>

        <Input.TextArea value={generatedPayloadText} readOnly style={{ minHeight: 220, fontFamily: 'monospace' }} />
      </div>

      <div className='border-t border-border-secondary my-16px' />

      <div className='flex justify-end'>
        <Button type='primary' onClick={handleSave} loading={saveLoading}>
          保存 API 配置
        </Button>
      </div>
    </div>
  );
};

export default ApiSettingsContent;
