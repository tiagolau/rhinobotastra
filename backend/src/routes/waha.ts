import { Router } from 'express';
import { WahaSyncService } from '../services/wahaSyncService';
import { WhatsAppSessionService } from '../services/whatsappSessionService';
import { evolutionApiService } from '../services/evolutionApiService';
import { settingsService } from '../services/settingsService';
import { configureQuepasaWebhook } from '../services/quepasaMessageService';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { Response } from 'express';
import { checkConnectionQuota } from '../middleware/quotaMiddleware';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const fetch = require('node-fetch');
const crypto = require('crypto');

// Função para gerar token aleatório para sessões Quepasa
function generateQuepasaToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Função para gerar webhook secret para campanhas interativas
function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Função para fazer requisições Evolution com credenciais customizadas (sessões importadas)
const evolutionRequestWithCredentials = async (baseUrl: string, apiKey: string, endpoint: string, options: any = {}) => {
  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      ...(options.headers || {}),
    },
  });
  return response;
};

// Função para buscar credenciais Evolution customizadas de uma sessão (sessões importadas)
const getEvolutionCredentialsForSession = async (sessionName: string): Promise<{ url: string; apiKey: string } | null> => {
  try {
    const session = await prisma.whatsAppSession.findUnique({ where: { name: sessionName } });
    if (session?.config) {
      const config = typeof session.config === 'string' ? JSON.parse(session.config) : session.config;
      if (config.evolutionUrl && config.evolutionApiKey) {
        return { url: config.evolutionUrl, apiKey: config.evolutionApiKey };
      }
    }
  } catch (e) {
    // Ignora erros - usa credenciais globais como fallback
  }
  return null;
};