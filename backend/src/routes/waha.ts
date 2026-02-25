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

// Busca credenciais Evolution para uma sessão (customizadas ou globais)
const getEvolutionCredentialsForSession = async (sessionName: string): Promise<{ url: string; apiKey: string } | null> => {
  try {
    const session = await prisma.whatsAppSession.findUnique({ where: { name: sessionName } });
    if (session?.config) {
      const config = JSON.parse(session.config);
      if (config.evolutionUrl && config.evolutionApiKey) {
        return { url: config.evolutionUrl, apiKey: config.evolutionApiKey };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
};

const router = Router();

// ============================================================
// GET /sessions - Lista todas as sessões WhatsApp
// ============================================================
router.get('/sessions', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;
    console.log('📋 GET /sessions - tenantId:', tenantId, 'user role:', req.user?.role);

    // Buscar sessões existentes no banco
    const dbSessions = await WhatsAppSessionService.getAllSessions(tenantId);
    console.log(`📊 Sessões no banco: ${dbSessions.length}`);

    // Sincronizar sessões WAHA
    try {
      const wahaSessions = await WahaSyncService.syncSessions(tenantId);
      console.log(`🔄 Sessões WAHA sincronizadas: ${wahaSessions.length}`);
    } catch (wahaError) {
      console.warn('⚠️ Erro ao sincronizar WAHA, mas continuando com dados do banco:', wahaError);
    }

    // Sincronizar sessões Quepasa
    try {
      const quepasaSessions = dbSessions.filter(s => s.provider === 'QUEPASA');
      for (const session of quepasaSessions) {
        try {
          const quepasaStatus = await fetch(`${process.env.QUEPASA_URL}/v3/bot/${session.name}/status`, {
            headers: { 'X-API-KEY': process.env.QUEPASA_API_KEY || '' }
          });
          if (quepasaStatus.ok) {
            const statusData = await quepasaStatus.json();
            const isConnected = statusData?.bot?.connected === true;
            const newStatus = isConnected ? 'WORKING' : 'STOPPED';
            await WhatsAppSessionService.createOrUpdateSession({
              name: session.name,
              displayName: session.displayName,
              status: newStatus,
              provider: 'QUEPASA',
              tenantId: session.tenantId || undefined
            });
          }
        } catch (err) {
          console.warn(`⚠️ Erro ao verificar status Quepasa para ${session.name}:`, err);
        }
      }
    } catch (quepasaError) {
      console.warn('⚠️ Erro ao sincronizar Quepasa, mas continuando com dados do banco:', quepasaError);
    }

    // Sincronizar apenas sessões Evolution que já existem no banco DESTE tenant
    // NÃO buscar sessões externas - sistema SaaS multi-tenant
    try {
      const allSessions = await WhatsAppSessionService.getAllSessions(tenantId);
      const evolutionSessions = allSessions.filter(s => s.provider === 'EVOLUTION');

      if (evolutionSessions.length > 0) {
        console.log(`🔄 Atualizando status de ${evolutionSessions.length} sessões Evolution do tenant...`);

        for (const session of evolutionSessions) {
          try {
            // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
            const customCreds = await getEvolutionCredentialsForSession(session.name);

            let mappedStatus = 'STOPPED';
            let instanceInfo: any = null;

            if (customCreds) {
              // Sessão importada: usar credenciais customizadas
              try {
                const stateRes = await evolutionRequestWithCredentials(
                  customCreds.url,
                  customCreds.apiKey,
                  `/instance/connectionState/${session.name}`
                );
                if (stateRes.ok) {
                  const stateData = await stateRes.json();
                  const rawState = stateData?.instance?.state || stateData?.state || 'close';
                  const stateMap: { [key: string]: string } = {
                    'open': 'WORKING',
                    'connecting': 'SCAN_QR_CODE',
                    'close': 'STOPPED',
                    'closed': 'STOPPED',
                  };
                  mappedStatus = stateMap[rawState?.toLowerCase()] || 'STOPPED';
                }
              } catch (e) {
                console.warn(`⚠️ Erro ao verificar status Evolution customizado para ${session.name}:`, e);
                mappedStatus = 'STOPPED';
              }

              try {
                const infoRes = await evolutionRequestWithCredentials(
                  customCreds.url,
                  customCreds.apiKey,
                  `/instance/fetchInstances?instanceName=${session.name}`
                );
                if (infoRes.ok) {
                  const infoData = await infoRes.json();
                  instanceInfo = Array.isArray(infoData) ? infoData[0] : infoData;
                }
              } catch (e) {
                // info não crítica
              }
            } else {
              // Sessão global: usar evolutionApiService normalmente
              mappedStatus = await evolutionApiService.getInstanceStatus(session.name);
              try {
                instanceInfo = await evolutionApiService.getInstanceInfo(session.name);
              } catch (e) {
                // info não crítica
              }
            }

            console.log(`🔍 Status Evolution para ${session.name}:`, mappedStatus);

            // Montar dados do 'me' quando conectado
            let meData = undefined;
            const evolutionData = instanceInfo as any;
            if (mappedStatus === 'WORKING' && evolutionData && (evolutionData.ownerJid || evolutionData.owner)) {
              const jid = evolutionData.ownerJid || evolutionData.owner;
              meData = {
                id: jid,
                pushName: evolutionData.profileName || evolutionData.profileName || 'Usuário WhatsApp',
                jid: jid
              };
            }

            // Atualizar sessão no banco (já existe, só atualiza status)
            if (mappedStatus && ['WORKING', 'SCAN_QR_CODE', 'STOPPED', 'FAILED'].includes(mappedStatus)) {
              await WhatsAppSessionService.createOrUpdateSession({
                name: session.name,
                displayName: session.displayName,
                status: mappedStatus as 'WORKING' | 'SCAN_QR_CODE' | 'STOPPED' | 'FAILED',
                provider: 'EVOLUTION',
                me: meData,
                qr: session.qr || undefined,
                qrExpiresAt: session.qrExpiresAt || undefined,
                tenantId: session.tenantId || undefined // Manter o tenantId original
              });
              console.log(`✅ Sessão Evolution "${session.name}" atualizada com status ${mappedStatus}`);
            }
          } catch (instanceError) {
            console.warn(`⚠️ Erro ao atualizar sessão Evolution ${session.name}:`, instanceError);
          }
        }
      }
    } catch (evolutionError) {
      console.warn('⚠️ Erro ao sincronizar Evolution, mas continuando com dados do banco:', evolutionError);
    }

    // Retornar todas as sessões atualizadas do banco
    const updatedSessions = await WhatsAppSessionService.getAllSessions(tenantId);
    res.json(updatedSessions);
  } catch (error) {
    console.error('Erro ao listar sessões:', error);
    res.status(500).json({ error: 'Erro ao listar sessões WhatsApp' });
  }
});
