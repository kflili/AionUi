/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageText } from '@/common/chat/chatLib';
import { AIONUI_FILES_MARKER } from '@/common/config/constants';
import { iconColors } from '@/renderer/styles/colors';
import { Alert, Message, Tooltip } from '@arco-design/web-react';
import { Copy } from '@icon-park/react';
import classNames from 'classnames';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText, CopyFallbackShown } from '@/renderer/utils/ui/clipboard';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import CollapsibleContent from '@renderer/components/chat/CollapsibleContent';
import FilePreview from '@renderer/components/media/FilePreview';
import HorizontalFileList from '@renderer/components/media/HorizontalFileList';
import MarkdownView from '@renderer/components/Markdown';
import { stripThinkTags, hasThinkTags } from '@renderer/utils/chat/thinkTagFilter';
import MessageCronBadge from './MessageCronBadge';

const parseFileMarker = (content: string) => {
  const markerIndex = content.indexOf(AIONUI_FILES_MARKER);
  if (markerIndex === -1) {
    return { text: content, files: [] as string[] };
  }
  const text = content.slice(0, markerIndex).trimEnd();
  const afterMarker = content.slice(markerIndex + AIONUI_FILES_MARKER.length).trim();
  const files = afterMarker
    ? afterMarker
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return { text, files };
};

/**
 * Shorten a file path for display.
 * - Absolute path inside workspace → relative (e.g., "src/utils/parser.ts")
 * - Absolute path outside workspace → last 2 segments (e.g., ".../Documents/file.txt")
 * - Relative path (legacy) → as-is
 */
const shortenPath = (filePath: string, workspace?: string): string => {
  const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath);
  if (!isAbsolute) return filePath; // legacy relative path

  if (workspace) {
    const normalizedFile = filePath.replace(/\\/g, '/');
    const normalizedWorkspace = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (normalizedFile.startsWith(normalizedWorkspace + '/')) {
      return normalizedFile.slice(normalizedWorkspace.length + 1);
    }
  }

  // External absolute path: show abbreviated with last 2 segments
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length <= 3) return filePath;
  return `.../${segments.slice(-2).join('/')}`;
};

const useFormatContent = (content: string) => {
  return useMemo(() => {
    try {
      const json = JSON.parse(content);
      const isJson = typeof json === 'object';
      return {
        json: isJson,
        data: isJson ? json : content,
      };
    } catch {
      return { data: content };
    }
  }, [content]);
};

const MessageText: React.FC<{ message: IMessageText }> = ({ message }) => {
  const conversationContext = useConversationContextSafe();
  const workspace = conversationContext?.workspace;

  // Filter think tags from content before rendering
  const contentToRender = useMemo(() => {
    const rawContent = message.content.content;
    if (typeof rawContent === 'string' && hasThinkTags(rawContent)) {
      return stripThinkTags(rawContent);
    }
    return rawContent;
  }, [message.content.content]);

  const { text, files } = parseFileMarker(contentToRender);
  const { data, json } = useFormatContent(text);
  const { t } = useTranslation();
  const [showCopyAlert, setShowCopyAlert] = useState(false);
  const isUserMessage = message.position === 'right';

  // 过滤空内容，避免渲染空DOM
  if (!message.content.content || (typeof message.content.content === 'string' && !message.content.content.trim())) {
    return null;
  }

  const handleCopy = () => {
    const baseText = json ? JSON.stringify(data, null, 2) : text;
    const fileList = files.length ? `Files:\n${files.map((p) => `- ${shortenPath(p, workspace)}`).join('\n')}\n\n` : '';
    const textToCopy = fileList + baseText;
    copyText(textToCopy)
      .then(() => {
        setShowCopyAlert(true);
        setTimeout(() => setShowCopyAlert(false), 2000);
      })
      .catch((err: unknown) => {
        if (err instanceof CopyFallbackShown) return;
        Message.error(t('common.copyFailed'));
      });
  };

  const copyButton = (
    <Tooltip content={t('common.copy', { defaultValue: 'Copy' })}>
      <div
        className='p-4px rd-4px cursor-pointer hover:bg-3 transition-colors opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto'
        onClick={handleCopy}
        style={{ lineHeight: 0 }}
      >
        <Copy theme='outline' size='16' fill={iconColors.secondary} />
      </div>
    </Tooltip>
  );

  const cronMeta = message.content.cronMeta;

  return (
    <>
      <div className={classNames('min-w-0 flex flex-col group', isUserMessage ? 'items-end' : 'items-start')}>
        {cronMeta && <MessageCronBadge meta={cronMeta} />}
        {files.length > 0 && (
          <div className={classNames('mt-6px', { 'self-end': isUserMessage })}>
            {files.length === 1 ? (
              <div className='flex items-center'>
                <FilePreview path={files[0]} onRemove={() => undefined} readonly />
              </div>
            ) : (
              <HorizontalFileList>
                {files.map((path) => (
                  <FilePreview key={path} path={path} onRemove={() => undefined} readonly />
                ))}
              </HorizontalFileList>
            )}
          </div>
        )}
        <div
          className={classNames('min-w-0 [&>p:first-child]:mt-0px [&>p:last-child]:mb-0px md:max-w-780px', {
            'bg-aou-2 p-8px': isUserMessage || cronMeta,
            'w-full': !(isUserMessage || cronMeta),
          })}
          style={isUserMessage || cronMeta ? { borderRadius: '8px 0 8px 8px' } : undefined}
        >
          {/* JSON 内容使用折叠组件 Use CollapsibleContent for JSON content */}
          {json ? (
            <CollapsibleContent maxHeight={200} defaultCollapsed={true}>
              <MarkdownView
                codeStyle={{ marginTop: 4, marginBlock: 4 }}
              >{`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``}</MarkdownView>
            </CollapsibleContent>
          ) : (
            <MarkdownView codeStyle={{ marginTop: 4, marginBlock: 4 }}>{data}</MarkdownView>
          )}
        </div>
        <div
          className={classNames('h-32px flex items-center mt-4px', {
            'justify-end': isUserMessage,
            'justify-start': !isUserMessage,
          })}
        >
          {copyButton}
        </div>
      </div>
      {showCopyAlert && (
        <Alert
          type='success'
          content={t('messages.copySuccess')}
          showIcon
          className='fixed top-20px left-50% transform -translate-x-50% z-9999 w-max max-w-[80%]'
          style={{ boxShadow: '0px 2px 12px rgba(0,0,0,0.12)' }}
          closable={false}
        />
      )}
    </>
  );
};

export default MessageText;
