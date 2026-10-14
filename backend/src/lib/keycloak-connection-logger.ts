// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { promises as fs } from 'fs';
import path from 'path';
import { logger } from './logger';

interface KeycloakConnectionEvent {
  timestamp: string;
  status: 'connected' | 'failed';
  realm: string;
  baseUrl: string;
  responseTime?: number;
  error?: string;
}

interface KeycloakConnectionState {
  lastConnected: string | null;
  lastAttempt: string;
  status: 'connected' | 'failed';
  realm: string;
  baseUrl: string;
}

class KeycloakConnectionLogger {
  private logFile: string;
  private stateFile: string;
  private cachedState: KeycloakConnectionState | null = null;

  constructor() {
    const logsDir = path.join(process.cwd(), 'logs', 'keycloak');
    this.logFile = path.join(logsDir, 'connections.jsonl');
    this.stateFile = path.join(logsDir, 'last-connection.json');
  }

  private async ensureLogDirectory(): Promise<void> {
    const dir = path.dirname(this.logFile);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      logger.keycloak.error('Failed to create keycloak logs directory', { dir }, error);
    }
  }

  async logConnectionAttempt(
    status: 'connected' | 'failed',
    realm: string,
    baseUrl: string,
    responseTime?: number,
    error?: string
  ): Promise<void> {
    await this.ensureLogDirectory();

    const timestamp = new Date().toISOString();
    const event: KeycloakConnectionEvent = {
      timestamp,
      status,
      realm,
      baseUrl,
      responseTime,
      error
    };

    // Log to JSONL file
    try {
      const logLine = JSON.stringify(event) + '\n';
      await fs.appendFile(this.logFile, logLine, 'utf8');
    } catch (logError) {
      logger.keycloak.error('Failed to write to keycloak connection log', { event }, logError);
    }

    // Update state file
    const state: KeycloakConnectionState = {
      lastConnected: status === 'connected' ? timestamp : this.cachedState?.lastConnected || null,
      lastAttempt: timestamp,
      status,
      realm,
      baseUrl
    };

    try {
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), 'utf8');
      this.cachedState = state;
    } catch (stateError) {
      logger.keycloak.error('Failed to write keycloak connection state', { state }, stateError);
    }

    // Log to console
    if (status === 'connected') {
      logger.keycloak.info('Successfully connected to Keycloak', {
        realm,
        baseUrl,
        responseTime: responseTime ? `${responseTime}ms` : undefined
      });
    } else {
      logger.keycloak.warn('Failed to connect to Keycloak', {
        realm,
        baseUrl,
        error
      });
    }
  }

  async getLastConnectionState(): Promise<KeycloakConnectionState | null> {
    if (this.cachedState) {
      return this.cachedState;
    }

    try {
      const stateContent = await fs.readFile(this.stateFile, 'utf8');
      this.cachedState = JSON.parse(stateContent);
      return this.cachedState;
    } catch {
      // State file doesn't exist or is invalid
      return null;
    }
  }

  async getLastConnectedTime(): Promise<string | null> {
    const state = await this.getLastConnectionState();
    return state?.lastConnected || null;
  }

  async getConnectionHistory(limit = 100): Promise<KeycloakConnectionEvent[]> {
    try {
      const content = await fs.readFile(this.logFile, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      // Get the last N lines and parse them
      const recentLines = lines.slice(-limit);
      const events: KeycloakConnectionEvent[] = [];
      
      for (const line of recentLines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Skip invalid JSON lines
        }
      }
      
      return events.reverse(); // Most recent first
    } catch {
      return [];
    }
  }
}

// Export singleton instance
export const keycloakConnectionLogger = new KeycloakConnectionLogger();
