/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import AgentCliModalContent from '@/renderer/components/settings/SettingsModal/contents/AgentCliModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const AgentCliSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <AgentCliModalContent />
    </SettingsPageWrapper>
  );
};

export default AgentCliSettings;
