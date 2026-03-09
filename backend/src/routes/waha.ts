import { Router } from 'express';
import { WahaSyncService } from '../services/wahaSyncService';
import { WhatsAppSessionService } from '../services/whatsappSessionService';
import { evolutionApiService } from '../services/evolutionApiService';
import { settingsService } from '../services/settingsService';
import { configureQuepasaWebhook } from '../services/quepasaMessageService';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { Response } from 'express';
import { checkConnectionQuota } from '../middleware/quotaMiddleware';
import { prisma } from '../lib/prisma';
import { wahaRequest } from '../lib/wahaRequest';

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

// Busca credenciais Evolution para uma sessão a partir dos dados já carregados (sem query extra)
// Aceita config como string JSON (raw Prisma) ou objeto já parseado (via WhatsAppSessionService)
const getEvolutionCredentialsFromSession = (session: any): { url: string; apiKey: string } | null => {
  try {
    let config: any = null;
    if (typeof session.config === 'string') {
      config = JSON.parse(session.config);
    } else if (typeof session.config === 'object' && session.config !== null) {
      config = session.config;
    }
    if (config && config.evolutionUrl && config.evolutionApiKey) {
      return { url: config.evolutionUrl, apiKey: config.evolutionApiKey };
    }
  } catch (e) {}
  return null;
};

const router = Router();

// Listar todas as sessões (leitura rápida do banco — sem sync com APIs externas)
router.get('/sessions', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;
    const sessions = await WhatsAppSessionService.getAllSessions(tenantId);
    res.json(sessions);
  } catch (error) {
    console.error('Erro ao listar sessões:', error);
    res.status(500).json({ error: 'Erro ao listar sessões WhatsApp' });
  }
});

// Sincronizar sessões com APIs externas (WAHA, Quepasa, Evolution)
router.post('/sessions/sync', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;

    // ── Buscar TODAS as sessões do tenant UMA ÚNICA VEZ ──
    const allDbSessions = await WhatsAppSessionService.getAllSessions(tenantId);

    // ── Helper: processar itens em batches paralelos ──
    const processInBatches = async <T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>) => {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(fn));
      }
    };

    // ── Sync WAHA (paralelo em batches de 5) ──
    const syncWaha = async () => {
      const wahaSessionsFiltered = allDbSessions.filter((s: any) => s.provider === 'WAHA');
      if (wahaSessionsFiltered.length === 0) return;
      console.log(`🔄 Atualizando status de ${wahaSessionsFiltered.length} sessões WAHA do tenant...`);
      await processInBatches(wahaSessionsFiltered, 5, async (session: any) => {
        try {
          await WahaSyncService.syncSessionWithExisting(session.name, session);
        } catch (err) {
          console.warn(`⚠️ Erro ao sincronizar sessão WAHA ${session.name}:`, err);
        }
      });
    };

    // ── Sync Quepasa (sequencial — evita race condition na descoberta de servidores) ──
    const syncQuepasa = async () => {
      const quepasaSessionsFiltered = allDbSessions.filter((s: any) => s.provider === 'QUEPASA');
      if (quepasaSessionsFiltered.length === 0) return;
      const quepasaConfig = await settingsService.getQuepasaConfig();
      if (quepasaConfig.url && quepasaConfig.login) {
        for (const session of quepasaSessionsFiltered) {
          try {
            console.log(`🔍 Verificando status Quepasa para ${session.name}...`);

            // Usar APENAS o token da sessão (não usar token global)
            const sessionToken = (session as any).quepasaToken;

            // Se não tiver token, a sessão ainda não foi iniciada - manter status atual
            if (!sessionToken) {
              console.log(`⏭️ Sessão ${session.name} não tem token - ainda não foi iniciada, mantendo status: ${(session as any).status}`);
              continue;
            }

            console.log(`🔑 Usando token da sessão para ${session.name}: ${sessionToken.substring(0, 16)}...`);

            // Primeiro tentar /health com o token da sessão
            const statusResponse = await fetch(`${quepasaConfig.url}/health`, {
              headers: {
                'Accept': 'application/json',
                'X-QUEPASA-TOKEN': sessionToken
              }
            });

            console.log(`📡 Response status: ${statusResponse.status} ${statusResponse.statusText}`);

            // Erro 400 = token não encontrado na Quepasa
            // Se a sessão está em SCAN_QR_CODE, verificar se o usuário já escaneou o QR
            // (a QuePasa gera um token próprio quando o QR é escaneado)
            if (statusResponse.status === 400) {
              console.log(`⏳ Token ${sessionToken.substring(0, 16)}... não encontrado na Quepasa`);

              // Se a sessão está aguardando QR, verificar se há servidor ready
              if ((session as any).status === 'SCAN_QR_CODE') {
                console.log(`🔍 Sessão ${session.name} aguardando QR, verificando servidores ready...`);

                try {
                  // Listar todos os servidores do usuário
                  const listResponse = await fetch(`${quepasaConfig.url}/health`, {
                    headers: {
                      'Accept': 'application/json',
                      'X-QUEPASA-USER': quepasaConfig.login,
                      'X-QUEPASA-PASSWORD': quepasaConfig.password || ''
                    }
                  });

                  if (listResponse.ok) {
                    const listData = await listResponse.json();

                    if (listData.success && listData.items && Array.isArray(listData.items)) {
                      // Procurar servidor ready que não está associado a nenhuma sessão
                      for (const server of listData.items) {
                        const serverStatus = String(server.status || '').toLowerCase();
                        const isReady = serverStatus.includes('ready') || server.health === true;

                        if (server.token && isReady) {
                          // Verificar se este token já está sendo usado por outra sessão
                          const existingWithToken = await prisma.whatsAppSession.findFirst({
                            where: {
                              quepasaToken: server.token,
                              name: { not: session.name }
                            }
                          });

                          if (!existingWithToken) {
                            console.log(`✅ Servidor ready encontrado para ${session.name}! Token: ${server.token.substring(0, 16)}...`);

                            // Atualizar sessão com o token real da QuePasa (método rápido)
                            await WhatsAppSessionService.updateStatusFast(
                              session.name,
                              'WORKING',
                              {
                                id: server.wid || server.number || 'unknown',
                                pushName: server.name || 'Quepasa'
                              },
                              {
                                quepasaToken: server.token,
                                displayName: (session as any).displayName
                              }
                            );

                            console.log(`💾 Sessão ${session.name} atualizada para WORKING com token real`);

                            // Configurar webhook se campanha interativa estiver habilitada
                            const fullSession = await prisma.whatsAppSession.findUnique({
                              where: { name: session.name }
                            });

                            if (fullSession?.interactiveCampaignEnabled && fullSession?.webhookSecret) {
                              const baseUrl = await settingsService.getAppBaseUrl();
                              const webhookUrlForQuepasa = `${baseUrl}/api/webhooks/incoming/${fullSession.id}/${fullSession.webhookSecret}`;
                              console.log(`🔗 Configurando webhook QuePasa para campanhas interativas: ${webhookUrlForQuepasa}`);

                              const webhookResult = await configureQuepasaWebhook(server.token, webhookUrlForQuepasa);
                              if (webhookResult.success) {
                                console.log(`✅ Webhook QuePasa configurado com sucesso para ${session.name}`);
                              } else {
                                console.error(`❌ Erro ao configurar webhook QuePasa: ${webhookResult.error}`);
                              }
                            }

                            break;
                          }
                        }
                      }
                    }
                  }
                } catch (listError) {
                  console.warn(`⚠️ Erro ao listar servidores QuePasa:`, listError);
                }
              }

              continue;
            }

            if (statusResponse.ok) {
              const statusData = await statusResponse.json();
              console.log(`📱 Status Quepasa completo (JSON):`, JSON.stringify(statusData, null, 2));

              // Endpoint /health retorna: { success: true/false, status: "server status is ready"/"server status is disconnected"/etc }
              let mappedStatus: 'WORKING' | 'SCAN_QR_CODE' | 'STOPPED' | 'FAILED' = 'STOPPED';
              const statusLower = String(statusData.status).toLowerCase();

              console.log(`🔍 Debug - success: ${statusData.success}, status original: "${statusData.status}", statusLower: "${statusLower}"`);

              // /health retorna "server status is ready" quando conectado
              if (statusData.success === true && statusLower.includes('ready')) {
                mappedStatus = 'WORKING';
                console.log('✅ Mapeado para WORKING');
              } else if (statusLower.includes('starting') || statusLower.includes('qrcode')) {
                mappedStatus = 'SCAN_QR_CODE';
                console.log('⏳ Mapeado para SCAN_QR_CODE');
              } else if (statusLower.includes('disconnected') || statusLower.includes('stopped')) {
                mappedStatus = 'STOPPED';
                console.log('⏹️ Mapeado para STOPPED');
              } else {
                mappedStatus = 'FAILED';
                console.log('❌ Mapeado para FAILED');
              }

              console.log(`📱 Status mapeado para ${session.name}: ${mappedStatus}`);

              // Extrair informações do número conectado se disponível
              let meData: any = undefined;
              if (statusData.number || statusData.wid || statusData.id) {
                const phoneNumber = statusData.number || statusData.wid || statusData.id;
                meData = {
                  id: phoneNumber,
                  pushName: statusData.pushName || statusData.name || 'Quepasa',
                };
                console.log(`📞 Número Quepasa detectado:`, meData);
              }

              // Verificar se estava em outro status e agora está WORKING (primeira vez conectando)
              const previousStatus = (session as any).status;
              const isNewlyConnected = mappedStatus === 'WORKING' && previousStatus !== 'WORKING';

              // Atualizar status no banco (usa método rápido — sessão já existe)
              await WhatsAppSessionService.updateStatusFast(
                session.name,
                mappedStatus,
                meData,
                { quepasaToken: sessionToken }
              );

              // Se acabou de conectar (WORKING), configurar webhook se campanha interativa estiver habilitada
              if (isNewlyConnected) {
                const fullSession = await prisma.whatsAppSession.findUnique({
                  where: { name: session.name }
                });

                if (fullSession?.interactiveCampaignEnabled && fullSession?.webhookSecret) {
                  const baseUrl = await settingsService.getAppBaseUrl();
                  const webhookUrlForQuepasa = `${baseUrl}/api/webhooks/incoming/${fullSession.id}/${fullSession.webhookSecret}`;
                  console.log(`🔗 Configurando webhook QuePasa para campanhas interativas (status sync): ${webhookUrlForQuepasa}`);

                  const webhookResult = await configureQuepasaWebhook(sessionToken, webhookUrlForQuepasa);
                  if (webhookResult.success) {
                    console.log(`✅ Webhook QuePasa configurado com sucesso para ${session.name}`);
                  } else {
                    console.error(`❌ Erro ao configurar webhook QuePasa: ${webhookResult.error}`);
                  }
                }
              }
            }
          } catch (quepasaError) {
            console.warn(`⚠️ Erro ao sincronizar status Quepasa para ${session.name}:`, quepasaError);
          }
        }
      }
    };

    // ── Sync Evolution (paralelo em batches de 5) ──
    const syncEvolution = async () => {
      const evolutionSessions = allDbSessions.filter((s: any) => s.provider === 'EVOLUTION');
      if (evolutionSessions.length === 0) return;
      console.log(`🔄 Atualizando status de ${evolutionSessions.length} sessões Evolution do tenant...`);
      await processInBatches(evolutionSessions, 5, async (session: any) => {
        try {
          // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
          const customCreds = getEvolutionCredentialsFromSession(session);

            // Preservar status anterior como fallback em caso de erro temporário
            const previousStatus = session.status || 'STOPPED';
            let mappedStatus: string | null = null;
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
                } else {
                  console.warn(`⚠️ Evolution customizada retornou HTTP ${stateRes.status} para ${session.name} (${customCreds.url}) — mantendo status anterior: ${previousStatus}`);
                }
              } catch (e) {
                console.warn(`⚠️ Erro de rede ao verificar status Evolution customizado para ${session.name} (${customCreds.url}) — mantendo status anterior: ${previousStatus}:`, e);
                // Não derrubar sessão por erro temporário de rede/timeout
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
              try {
                mappedStatus = await evolutionApiService.getInstanceStatus(session.name);
              } catch (e) {
                console.warn(`⚠️ Erro ao verificar status Evolution global para ${session.name} — mantendo status anterior: ${previousStatus}`);
              }
              try {
                instanceInfo = await evolutionApiService.getInstanceInfo(session.name);
              } catch (e) {
                // info não crítica
              }
            }

            // Se não conseguiu obter status (erro de rede/timeout), manter o anterior
            const effectiveStatus = mappedStatus || previousStatus;
            console.log(`🔍 Status Evolution para ${session.name}: ${effectiveStatus}${!mappedStatus ? ' (mantido — erro ao consultar)' : ''}`);

            // Montar dados do 'me' quando conectado
            let meData = undefined;
            const evolutionData = instanceInfo as any;
            if (effectiveStatus === 'WORKING' && evolutionData && (evolutionData.ownerJid || evolutionData.owner)) {
              const jid = evolutionData.ownerJid || evolutionData.owner;
              meData = {
                id: jid,
                pushName: evolutionData.profileName || evolutionData.profileName || 'Usuário WhatsApp',
                jid: jid
              };
            }

            // Atualizar sessão no banco (já existe, só atualiza status — usa método rápido)
            if (effectiveStatus && ['WORKING', 'SCAN_QR_CODE', 'STOPPED', 'FAILED'].includes(effectiveStatus)) {
              await WhatsAppSessionService.updateStatusFast(
                session.name,
                effectiveStatus,
                meData
              );
            }
          } catch (instanceError) {
            console.warn(`⚠️ Erro ao atualizar sessão Evolution ${session.name}:`, instanceError);
          }
      });
    };

    // ── Executar os 3 provedores em PARALELO ──
    await Promise.allSettled([syncWaha(), syncQuepasa(), syncEvolution()]);

    // Retornar todas as sessões atualizadas do banco
    const updatedSessions = await WhatsAppSessionService.getAllSessions(tenantId);
    res.json(updatedSessions);
  } catch (error) {
    console.error('Erro ao sincronizar sessões:', error);
    res.status(500).json({ error: 'Erro ao sincronizar sessões WhatsApp' });
  }
});

// Obter informações de uma sessão específica
router.get('/sessions/:sessionName', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log('🔍 GET /sessions/:sessionName - sessionName:', sessionName, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    // SUPERADMIN pode ver qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Primeiro tentar buscar a sessão no banco com tenant isolation
    try {
      const session = await WhatsAppSessionService.getSession(sessionName, tenantId);
      console.log('✅ Sessão encontrada no banco:', session.name);
      return res.json(session);
    } catch (dbError) {
      console.log('⚠️ Sessão não encontrada no banco, tentando sincronizar com WAHA...');
    }

    // Se não encontrar no banco, tentar sincronizar com WAHA
    const session = await WahaSyncService.syncSession(sessionName);
    res.json(session);
  } catch (error) {
    console.error('Erro ao obter sessão:', error);
    res.status(500).json({ error: 'Erro ao obter informações da sessão' });
  }
});

// Importar sessão Evolution API existente
router.post('/sessions/import-evolution', authMiddleware, checkConnectionQuota, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { url, instanceName, apiKey, displayName, interactiveCampaignEnabled } = req.body;

    if (!url || !instanceName || !apiKey) {
      return res.status(400).json({ error: 'URL, instanceName e apiKey são obrigatórios' });
    }

    const normalizedUrl = url.replace(/\/$/, '');

    // Verificar se a instância existe na Evolution API informada
    const verifyResponse = await fetch(`${normalizedUrl}/instance/connectionState/${instanceName}`, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': apiKey,
      },
    });

    if (!verifyResponse.ok) {
      const errText = await verifyResponse.text();
      return res.status(400).json({ error: `Instância não encontrada ou credenciais inválidas. Verifique a URL, instância e API Key. Detalhe: ${errText}` });
    }

    const instanceData = await verifyResponse.json();
    const evolutionState = instanceData?.instance?.state || instanceData?.state || 'close';

    const statusMap: { [key: string]: string } = {
      'open': 'WORKING',
      'connecting': 'SCAN_QR_CODE',
      'close': 'STOPPED',
      'closed': 'STOPPED',
    };
    const mappedStatus = (statusMap[evolutionState?.toLowerCase()] || 'STOPPED') as 'WORKING' | 'SCAN_QR_CODE' | 'STOPPED' | 'FAILED';

    const tenantId = req.tenantId;
    const webhookSecret = generateWebhookSecret();

    await WhatsAppSessionService.createOrUpdateSession({
      name: instanceName,
      displayName: displayName || instanceName,
      status: mappedStatus,
      provider: 'EVOLUTION',
      tenantId,
      interactiveCampaignEnabled: interactiveCampaignEnabled || false,
      webhookSecret,
      config: {
        evolutionUrl: normalizedUrl,
        evolutionApiKey: apiKey,
        imported: true,
      },
    });

    console.log(`✅ Sessão Evolution importada: ${instanceName} (${normalizedUrl})`);
    res.json({ success: true, message: `Sessão ${instanceName} importada com sucesso`, status: mappedStatus });
  } catch (error) {
    console.error('Erro ao importar sessão Evolution:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Erro ao importar sessão' });
  }
});

// Criar nova sessão
router.post('/sessions', authMiddleware, checkConnectionQuota, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, provider = 'WAHA', interactiveCampaignEnabled = false } = req.body;
    console.log('➕ POST /sessions - name:', name, 'provider:', provider, 'interactiveCampaign:', interactiveCampaignEnabled, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    if (!name) {
      return res.status(400).json({ error: 'Nome da sessão é obrigatório' });
    }

    if (!['WAHA', 'EVOLUTION', 'QUEPASA'].includes(provider)) {
      return res.status(400).json({ error: 'Provedor deve ser WAHA, EVOLUTION ou QUEPASA' });
    }

    // Usar tenantId do usuário autenticado (SUPERADMIN pode especificar tenant no body se necessário)
    const tenantId = req.user?.role === 'SUPERADMIN' ? req.body.tenantId || req.tenantId : req.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'TenantId é obrigatório' });
    }

    // Gerar nome real: displayName_primeiros8CharsTenantId
    // Ex: vendas_c52982e8
    const displayName = name.trim();
    const tenantPrefix = tenantId.substring(0, 8);
    const realName = `${displayName}_${tenantPrefix}`;

    console.log('📝 Criando sessão - displayName:', displayName, 'realName:', realName);

    // Verificar se já existe uma sessão com este realName
    const existingSession = await prisma.whatsAppSession.findUnique({
      where: { name: realName }
    });

    if (existingSession) {
      console.log('⚠️ Sessão já existe:', realName);
      return res.status(409).json({ error: 'Já existe uma conexão com este nome' });
    }

    let result;
    let webhookSecret: string | undefined;
    let webhookUrl: string | undefined;

    // Se campanha interativa habilitada, gerar webhook secret e URL
    if (interactiveCampaignEnabled) {
      webhookSecret = generateWebhookSecret();
      console.log(`🔑 Webhook secret gerado para sessão ${realName}: ${webhookSecret.substring(0, 16)}...`);
    }

    if (provider === 'EVOLUTION') {
      const { evolutionApiService } = await import('../services/evolutionApiService');

      // Se campanha interativa habilitada, construir URL do webhook
      // Nota: sessionId será gerado após criar a sessão no banco
      const tempSession = await prisma.whatsAppSession.create({
        data: {
          name: realName,
          displayName,
          status: 'SCAN_QR_CODE',
          provider: 'EVOLUTION',
          tenantId,
          interactiveCampaignEnabled,
          webhookSecret
        }
      });

      if (interactiveCampaignEnabled && webhookSecret) {
        const baseUrl = await settingsService.getAppBaseUrl();
        webhookUrl = `${baseUrl}/api/webhooks/incoming/${tempSession.id}/${webhookSecret}`;
        console.log(`🔗 Webhook URL para Evolution: ${webhookUrl}`);
      }

      result = await evolutionApiService.createInstance(realName, webhookUrl);

      // Extrair QR code da resposta da criação (se disponível)
      let qrCode: string | undefined;
      let qrExpiresAt: Date | undefined;

      if (result.qrcode?.base64) {
        // QR code veio na resposta
        qrCode = result.qrcode.base64.startsWith('data:image/')
          ? result.qrcode.base64
          : `data:image/png;base64,${result.qrcode.base64}`;
        qrExpiresAt = new Date(Date.now() + 300000); // 5 minutos
        console.log(`✅ QR Code Evolution recebido na criação para ${realName}`);
      }

      // Atualizar sessão com QR code
      await WhatsAppSessionService.createOrUpdateSession({
        name: realName,
        displayName,
        status: 'SCAN_QR_CODE',
        provider: 'EVOLUTION',
        tenantId,
        qr: qrCode,
        qrExpiresAt: qrExpiresAt,
        interactiveCampaignEnabled,
        webhookSecret
      });
    } else if (provider === 'QUEPASA') {
      // Quepasa - criar sessão e gerar token único
      // O QR code será gerado quando o usuário clicar para conectar
      const quepasaToken = generateQuepasaToken();
      console.log(`🔑 Token único gerado para sessão QuePasa ${realName}: ${quepasaToken.substring(0, 16)}...`);

      // Primeiro criar sessão no banco para obter o ID
      const tempSession = await prisma.whatsAppSession.create({
        data: {
          name: realName,
          displayName,
          status: 'STOPPED',
          provider: 'QUEPASA',
          tenantId,
          quepasaToken,
          interactiveCampaignEnabled,
          webhookSecret
        }
      });

      // Se campanha interativa habilitada, gerar webhook URL
      if (interactiveCampaignEnabled && webhookSecret) {
        const baseUrl = await settingsService.getAppBaseUrl();
        webhookUrl = `${baseUrl}/api/webhooks/incoming/${tempSession.id}/${webhookSecret}`;
        console.log(`🔗 Webhook URL para QuePasa: ${webhookUrl}`);

        // Nota: O webhook será configurado na API QuePasa quando a sessão conectar (status WORKING)
        // porque precisamos do token válido e sessão ativa
      }

      result = { name: realName, status: 'STOPPED', provider: 'QUEPASA', token: quepasaToken, webhookUrl };

    } else {
      // WAHA (comportamento original)
      // Se campanha interativa habilitada, criar sessão primeiro para obter ID
      const tempSession = await prisma.whatsAppSession.create({
        data: {
          name: realName,
          displayName,
          status: 'SCAN_QR_CODE',
          provider: 'WAHA',
          tenantId,
          interactiveCampaignEnabled,
          webhookSecret
        }
      });

      if (interactiveCampaignEnabled && webhookSecret) {
        const baseUrl = await settingsService.getAppBaseUrl();
        webhookUrl = `${baseUrl}/api/webhooks/incoming/${tempSession.id}/${webhookSecret}`;
        console.log(`🔗 Webhook URL para WAHA: ${webhookUrl}`);
      }

      result = await WahaSyncService.createSession(realName, webhookUrl);

      // Atualizar sessão
      await WhatsAppSessionService.createOrUpdateSession({
        name: realName,
        displayName,
        status: 'SCAN_QR_CODE',
        provider: 'WAHA',
        tenantId,
        interactiveCampaignEnabled,
        webhookSecret
      });
    }

    console.log('✅ Sessão criada:', realName, '(display:', displayName, ') tenant:', tenantId);

    res.json(result);
  } catch (error) {
    console.error('Erro ao criar sessão:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Erro ao criar sessão WhatsApp' });
  }
});

// Iniciar sessão
router.post('/sessions/:sessionName/start', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log('▶️ POST /sessions/:sessionName/start - sessionName:', sessionName, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    // SUPERADMIN pode iniciar qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Verificar o provedor da sessão
    let sessionProvider = 'WAHA'; // Default para WAHA (compatibilidade)
    let sessionData: any;
    try {
      sessionData = await WhatsAppSessionService.getSession(sessionName, tenantId);
      sessionProvider = sessionData.provider || 'WAHA';
    } catch (error) {
      console.error('❌ Sessão não encontrada ou não pertence ao tenant:', error);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    console.log(`▶️ Iniciando sessão ${sessionName} via ${sessionProvider}`);

    let result;
    if (sessionProvider === 'EVOLUTION') {
      // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
      const customCreds = getEvolutionCredentialsFromSession(sessionData);

      try {
        let qrCodeData: string;

        if (customCreds) {
          // Sessão importada: usar credenciais customizadas
          console.log(`🔄 Conectando instância Evolution importada ${sessionName} (${customCreds.url})...`);
          const connectRes = await evolutionRequestWithCredentials(
            customCreds.url,
            customCreds.apiKey,
            `/instance/connect/${sessionName}`
          );
          if (!connectRes.ok) {
            const errText = await connectRes.text();
            throw new Error(`Evolution API Error: ${connectRes.status} - ${errText}`);
          }
          const data = await connectRes.json();
          qrCodeData = data.base64
            ? (data.base64.startsWith('data:image/') ? data.base64 : `data:image/png;base64,${data.base64}`)
            : data.code || '';
        } else {
          // Sessão global: usar evolutionApiService normalmente
          console.log(`🔄 Conectando instância Evolution ${sessionName}...`);
          qrCodeData = await evolutionApiService.getQRCode(sessionName);
        }

        // Se conseguiu obter QR, salvar no banco
        if (qrCodeData) {
          const qrExpiresAt = new Date(Date.now() + 300000); // 5 minutos

          await WhatsAppSessionService.createOrUpdateSession({
            name: sessionName,
            status: 'SCAN_QR_CODE',
            provider: 'EVOLUTION',
            tenantId: sessionData.tenantId,
            qr: qrCodeData,
            qrExpiresAt: qrExpiresAt
          });

          console.log(`✅ Sessão Evolution ${sessionName} iniciada com QR Code salvo`);
        }

        // Retornar o QR code para o frontend
        result = { qr: qrCodeData, status: 'SCAN_QR_CODE' };
      } catch (error: any) {
        console.error(`❌ Erro ao conectar instância Evolution ${sessionName}:`, error.message);
        throw new Error(`Erro ao iniciar sessão WhatsApp: ${error.message}`);
      }
    } else if (sessionProvider === 'QUEPASA') {
      // Usar Quepasa API - gerar QR Code
      try {
        console.log(`🔄 Conectando instância Quepasa ${sessionName}...`);

        // Buscar configurações do Quepasa
        const quepasaConfig = await settingsService.getQuepasaConfig();

        if (!quepasaConfig.url || !quepasaConfig.login) {
          throw new Error('Configure as credenciais Quepasa nas configurações do sistema');
        }

        // Usar APENAS o token da sessão (não usar token global)
        let sessionToken = sessionData.quepasaToken;

        // Se não tiver token, gerar e salvar um novo (para sessões criadas antes da implementação)
        if (!sessionToken) {
          sessionToken = generateQuepasaToken();
          console.log(`🔑 Gerando novo token para sessão ${sessionName} (sessão sem token): ${sessionToken.substring(0, 16)}...`);

          await WhatsAppSessionService.createOrUpdateSession({
            name: sessionName,
            status: sessionData.status,
            provider: 'QUEPASA',
            tenantId: sessionData.tenantId,
            quepasaToken: sessionToken
          });
          console.log(`💾 Token salvo para sessão ${sessionName}`);
        }

        console.log(`🔑 Usando token da sessão para ${sessionName}`);

        // Fazer requisição para gerar QR Code
        const qrResponse = await fetch(`${quepasaConfig.url}/scan`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-QUEPASA-USER': quepasaConfig.login,
            'X-QUEPASA-TOKEN': sessionToken
          }
        });

        if (!qrResponse.ok) {
          throw new Error(`Erro ao gerar QR Code Quepasa: ${qrResponse.status} ${qrResponse.statusText}`);
        }

        // Converter resposta para base64
        const imageBuffer = await qrResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const qrBase64 = `data:image/png;base64,${base64Image}`;

        const qrExpiresAt = new Date(Date.now() + 300000); // 5 minutos

        // Salvar QR no banco (preservando o token!)
        await WhatsAppSessionService.createOrUpdateSession({
          name: sessionName,
          status: 'SCAN_QR_CODE',
          provider: 'QUEPASA',
          tenantId: sessionData.tenantId,
          quepasaToken: sessionToken, // IMPORTANTE: preservar o token
          qr: qrBase64,
          qrExpiresAt: qrExpiresAt
        });

        console.log(`✅ Sessão Quepasa ${sessionName} iniciada com QR Code salvo (token: ${sessionToken.substring(0, 16)}...)`);

        result = { qr: qrBase64, status: 'SCAN_QR_CODE' };
      } catch (error: any) {
        console.error(`❌ Erro ao conectar instância Quepasa ${sessionName}:`, error.message);
        throw new Error(`Erro ao iniciar sessão Quepasa: ${error.message}`);
      }
    } else {
      // Usar WAHA com chamada direta
      result = await wahaRequest(`/api/sessions/${sessionName}/start`, {
        method: 'POST'
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Erro ao iniciar sessão:', error);
    res.status(500).json({ error: 'Erro ao iniciar sessão WhatsApp' });
  }
});

// Parar sessão
router.post('/sessions/:sessionName/stop', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log('⏹️ POST /sessions/:sessionName/stop - sessionName:', sessionName, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    // SUPERADMIN pode parar qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Verificar o provedor da sessão
    let sessionProvider = 'WAHA';
    let sessionData: any;
    try {
      sessionData = await WhatsAppSessionService.getSession(sessionName, tenantId);
      sessionProvider = sessionData.provider || 'WAHA';
    } catch (error) {
      console.error('❌ Sessão não encontrada ou não pertence ao tenant:', error);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    console.log(`⏹️ Parando sessão ${sessionName} via ${sessionProvider}`);

    let result;
    if (sessionProvider === 'EVOLUTION') {
      // Para Evolution API, não há stop específico, apenas deletar
      result = { message: 'Sessão Evolution parada (conceitual)' };
      await WhatsAppSessionService.createOrUpdateSession({
        name: sessionName,
        status: 'STOPPED',
        provider: 'EVOLUTION',
        tenantId: sessionData.tenantId
      });
    } else {
      result = await WahaSyncService.stopSession(sessionName);
    }

    res.json(result);
  } catch (error) {
    console.error('Erro ao parar sessão:', error);
    res.status(500).json({ error: 'Erro ao parar sessão WhatsApp' });
  }
});

// Reiniciar sessão
router.post('/sessions/:sessionName/restart', async (req, res) => {
  try {
    const { sessionName } = req.params;

    // Verificar o provedor da sessão
    let sessionProvider = 'WAHA';
    try {
      const savedSession = await WhatsAppSessionService.getSession(sessionName);
      sessionProvider = (savedSession as any).provider || 'WAHA';
    } catch (error) {
      // Se sessão não existe no banco, assumir WAHA
    }

    console.log(`🔄 Reiniciando sessão ${sessionName} via ${sessionProvider}`);

    let result;
    if (sessionProvider === 'EVOLUTION') {
      // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
      const savedSession = await prisma.whatsAppSession.findFirst({ where: { name: sessionName }, select: { config: true, tenantId: true } });
      const customCreds = getEvolutionCredentialsFromSession(savedSession || {});

      if (customCreds) {
        // Sessão importada: usar credenciais customizadas
        console.log(`🔄 Reiniciando instância Evolution importada ${sessionName} (${customCreds.url})...`);
        const restartRes = await evolutionRequestWithCredentials(
          customCreds.url,
          customCreds.apiKey,
          `/instance/restart/${sessionName}`,
          { method: 'PUT' }
        );
        if (!restartRes.ok) {
          const errText = await restartRes.text();
          throw new Error(`Evolution API Error: ${restartRes.status} - ${errText}`);
        }
        result = await restartRes.json().catch(() => ({ message: 'Instance restarted' }));
      } else {
        // Sessão global: usar evolutionApiService normalmente
        result = await evolutionApiService.restartInstance(sessionName);
      }

      await WhatsAppSessionService.createOrUpdateSession({
        name: sessionName,
        status: 'SCAN_QR_CODE',
        provider: 'EVOLUTION',
        tenantId: savedSession?.tenantId || undefined
      });
    } else {
      result = await WahaSyncService.restartSession(sessionName);
    }

    res.json(result);
  } catch (error) {
    console.error('Erro ao reiniciar sessão:', error);
    res.status(500).json({ error: 'Erro ao reiniciar sessão WhatsApp' });
  }
});

// Deletar sessão
router.delete('/sessions/:sessionName', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log('🗑️ DELETE /sessions/:sessionName - sessionName:', sessionName, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    // SUPERADMIN pode deletar qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Verificar o provedor da sessão
    let sessionProvider: 'WAHA' | 'EVOLUTION' | 'QUEPASA' = 'WAHA';
    try {
      const savedSession = await WhatsAppSessionService.getSession(sessionName, tenantId);
      sessionProvider = (savedSession.provider as 'WAHA' | 'EVOLUTION' | 'QUEPASA') || 'WAHA';
    } catch (error) {
      console.error('❌ Sessão não encontrada ou não pertence ao tenant:', error);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    console.log(`🗑️ Deletando sessão ${sessionName} via ${sessionProvider}`);

    // Deletar da API correspondente
    if (sessionProvider === 'EVOLUTION') {
      // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
      const savedSessionData = await prisma.whatsAppSession.findFirst({ where: { name: sessionName }, select: { config: true } });
      const customCreds = getEvolutionCredentialsFromSession(savedSessionData || {});

      try {
        if (customCreds) {
          // Sessão importada: usar credenciais customizadas para deletar
          console.log(`🗑️ Deletando instância Evolution importada ${sessionName} (${customCreds.url})...`);
          const deleteRes = await evolutionRequestWithCredentials(
            customCreds.url,
            customCreds.apiKey,
            `/instance/delete/${sessionName}`,
            { method: 'DELETE' }
          );
          if (!deleteRes.ok) {
            const errText = await deleteRes.text();
            console.warn(`⚠️ Erro ao deletar ${sessionName} da Evolution externa: ${deleteRes.status} - ${errText}`);
          } else {
            console.log(`✅ Sessão ${sessionName} deletada da Evolution API externa`);
          }
        } else {
          // Sessão global: usar evolutionApiService normalmente
          await evolutionApiService.deleteInstance(sessionName);
          console.log(`✅ Sessão ${sessionName} deletada da Evolution API`);
        }
      } catch (error) {
        console.warn(`⚠️ Erro ao deletar ${sessionName} da Evolution API:`, error);
      }
      // Deletar do banco também
      try {
        await WhatsAppSessionService.deleteSession(sessionName, tenantId);
        console.log(`✅ Sessão ${sessionName} removida do banco de dados`);
      } catch (error) {
        console.warn(`⚠️ Erro ao deletar ${sessionName} do banco:`, error);
      }
    } else if (sessionProvider === 'QUEPASA') {
      try {
        // Buscar configurações do Quepasa e dados da sessão
        const quepasaConfig = await settingsService.getQuepasaConfig();
        const savedSession = await WhatsAppSessionService.getSession(sessionName, tenantId);

        if (quepasaConfig.url && quepasaConfig.login) {
          // Usar o token da sessão salvo no banco
          let sessionToken = (savedSession as any).quepasaToken;

          console.log(`🗑️ Deletando servidor Quepasa - Token: ${sessionToken ? sessionToken.substring(0, 16) + '...' : 'SEM TOKEN'}`);

          if (!sessionToken) {
            console.warn(`⚠️ Sessão ${sessionName} não tem token Quepasa salvo, pulando deleção na API`);
          } else {
            console.log(`🗑️ Deletando servidor Quepasa via API DELETE /info...`);

            // Deletar o servidor no Quepasa usando DELETE /info
            const deleteResponse = await fetch(`${quepasaConfig.url}/info`, {
              method: 'DELETE',
              headers: {
                'Accept': 'application/json',
                'X-QUEPASA-TOKEN': sessionToken
              }
            });

            console.log(`📡 Delete response status: ${deleteResponse.status} ${deleteResponse.statusText}`);

            if (deleteResponse.ok) {
              try {
                const deleteData = await deleteResponse.json();
                console.log(`✅ Servidor Quepasa deletado com sucesso:`, JSON.stringify(deleteData, null, 2));
              } catch (jsonError) {
                // Algumas APIs retornam 200 sem body
                console.log(`✅ Servidor Quepasa deletado (resposta sem JSON)`);
              }
            } else {
              const errorText = await deleteResponse.text();
              console.warn(`⚠️ Erro ao deletar do Quepasa: ${deleteResponse.status} - ${errorText}`);
            }
          }
        }
      } catch (quepasaError) {
        console.warn(`⚠️ Erro ao deletar ${sessionName} do Quepasa:`, quepasaError);
      }

      // Deletar do banco de dados
      try {
        await WhatsAppSessionService.deleteSession(sessionName, tenantId);
        console.log(`✅ Sessão ${sessionName} removida do banco de dados`);
      } catch (error) {
        console.warn(`⚠️ Erro ao deletar ${sessionName} do banco:`, error);
      }
    } else {
      // Deletar via WAHA (já remove do banco também)
      await WahaSyncService.deleteSession(sessionName);
    }

    res.json({ success: true, message: 'Sessão removida com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar sessão:', error);
    res.status(500).json({ error: 'Erro ao remover sessão WhatsApp' });
  }
});

// Obter QR Code da sessão
router.get('/sessions/:sessionName/auth/qr', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log(`🔍 GET /sessions/:sessionName/auth/qr - sessionName: ${sessionName}, user: ${req.user?.email}, tenantId: ${req.tenantId}`);

    // SUPERADMIN pode ver QR de qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Primeiro, verificar se existe QR salvo no banco com tenant isolation
    try {
      const savedSession = await WhatsAppSessionService.getSession(sessionName, tenantId);

      if (savedSession.qr && savedSession.qrExpiresAt && savedSession.qrExpiresAt > new Date()) {
        console.log(`💾 Retornando QR salvo do banco para ${sessionName}`);
        return res.json({
          qr: savedSession.qr,
          expiresAt: savedSession.qrExpiresAt,
          status: savedSession.status,
          message: "QR code retornado do banco de dados"
        });
      }
    } catch (dbError) {
      console.log(`📋 Sessão ${sessionName} não encontrada no banco ou não pertence ao tenant, verificando WAHA API...`);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    // Verificar o provedor da sessão para rotear corretamente
    let sessionProvider: 'WAHA' | 'EVOLUTION' | 'QUEPASA' = 'WAHA'; // Default para WAHA (compatibilidade)
    let sessionData: any;
    try {
      sessionData = await WhatsAppSessionService.getSession(sessionName, tenantId);
      console.log(`🔍 Sessão ${sessionName} encontrada no banco:`, {
        provider: sessionData.provider,
        status: sessionData.status
      });
      sessionProvider = (sessionData.provider as 'WAHA' | 'EVOLUTION' | 'QUEPASA') || 'WAHA';
    } catch (error) {
      console.log(`⚠️ Sessão ${sessionName} não encontrada no banco ou não pertence ao tenant, assumindo WAHA`);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    console.log(`🔍 Processando QR para sessão ${sessionName} via ${sessionProvider}`);

    // Se for Evolution API, usar o serviço específico
    if (sessionProvider === 'EVOLUTION') {
      try {
        // Verificar se sessão tem credenciais customizadas (importada de Evolution externa)
        const customCreds = getEvolutionCredentialsFromSession(sessionData);
        let qrCodeData: string;

        if (customCreds) {
          // Sessão importada: usar credenciais customizadas
          console.log(`🔍 Obtendo QR code da Evolution importada ${sessionName} (${customCreds.url})...`);
          const connectRes = await evolutionRequestWithCredentials(
            customCreds.url,
            customCreds.apiKey,
            `/instance/connect/${sessionName}`
          );
          if (!connectRes.ok) {
            const errText = await connectRes.text();
            throw new Error(`Evolution API Error: ${connectRes.status} - ${errText}`);
          }
          const data = await connectRes.json();
          qrCodeData = data.base64
            ? (data.base64.startsWith('data:image/') ? data.base64 : `data:image/png;base64,${data.base64}`)
            : data.code || '';
        } else {
          // Sessão global: usar evolutionApiService normalmente
          qrCodeData = await evolutionApiService.getQRCode(sessionName);
        }

        const expiresAt = new Date(Date.now() + 300000); // 5 minutos

        // Salvar o QR code no banco de dados
        await WhatsAppSessionService.createOrUpdateSession({
          name: sessionName,
          status: 'SCAN_QR_CODE',
          provider: 'EVOLUTION',
          qr: qrCodeData,
          qrExpiresAt: expiresAt,
          tenantId: sessionData.tenantId
        });

        console.log(`💾 QR code Evolution salvo no banco para sessão ${sessionName}`);

        return res.json({
          qr: qrCodeData,
          expiresAt: expiresAt,
          status: 'SCAN_QR_CODE',
          provider: 'EVOLUTION',
          message: "QR code gerado via Evolution API"
        });
      } catch (evolutionError: any) {
        console.error(`❌ Erro ao obter QR da Evolution API:`, evolutionError);
        return res.status(500).json({
          error: 'Erro ao obter QR Code da Evolution API',
          details: evolutionError.message
        });
      }
    } else if (sessionProvider === 'QUEPASA') {
      try {
        // Buscar configurações do Quepasa
        const quepasaConfig = await settingsService.getQuepasaConfig();

        if (!quepasaConfig.url || !quepasaConfig.login) {
          throw new Error('Configure as credenciais Quepasa nas configurações do sistema');
        }

        // Usar APENAS o token da sessão (não usar token global)
        let sessionToken = sessionData.quepasaToken;

        // Se não tiver token, gerar e salvar um novo (para sessões criadas antes da implementação)
        if (!sessionToken) {
          sessionToken = generateQuepasaToken();
          console.log(`🔑 Gerando novo token para sessão ${sessionName} (sessão sem token): ${sessionToken.substring(0, 16)}...`);

          await WhatsAppSessionService.createOrUpdateSession({
            name: sessionName,
            status: sessionData.status,
            provider: 'QUEPASA',
            tenantId: sessionData.tenantId,
            quepasaToken: sessionToken
          });
          console.log(`💾 Token salvo para sessão ${sessionName}`);
        }

        console.log(`🔑 Usando token da sessão para ${sessionName}`);

        // Fazer requisição para gerar QR Code
        const qrResponse = await fetch(`${quepasaConfig.url}/scan`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-QUEPASA-USER': quepasaConfig.login,
            'X-QUEPASA-TOKEN': sessionToken
          }
        });

        if (!qrResponse.ok) {
          throw new Error(`Erro ao gerar QR Code Quepasa: ${qrResponse.status} ${qrResponse.statusText}`);
        }

        // Converter resposta para base64
        const imageBuffer = await qrResponse.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const qrBase64 = `data:image/png;base64,${base64Image}`;

        const expiresAt = new Date(Date.now() + 300000); // 5 minutos

        // Salvar o QR code no banco de dados (preservando o token!)
        await WhatsAppSessionService.createOrUpdateSession({
          name: sessionName,
          status: 'SCAN_QR_CODE',
          provider: 'QUEPASA',
          quepasaToken: sessionToken, // IMPORTANTE: preservar o token
          qr: qrBase64,
          qrExpiresAt: expiresAt,
          tenantId: sessionData.tenantId
        });

        console.log(`💾 QR code Quepasa salvo no banco para sessão ${sessionName} (token: ${sessionToken.substring(0, 16)}...)`);

        return res.json({
          qr: qrBase64,
          expiresAt: expiresAt,
          status: 'SCAN_QR_CODE',
          provider: 'QUEPASA',
          message: "QR code gerado via Quepasa API"
        });
      } catch (quepasaError: any) {
        console.error(`❌ Erro ao obter QR da Quepasa API:`, quepasaError);
        return res.status(500).json({
          error: 'Erro ao obter QR Code da Quepasa API',
          details: quepasaError.message
        });
      }
    } else {
      // Para WAHA, manter lógica original
    let sessionStatus;
    try {
      sessionStatus = await wahaRequest(`/api/sessions/${sessionName}`);
      console.log(`🔍 Status da sessão ${sessionName}:`, sessionStatus.status);
    } catch (wahaError: any) {
      console.error(`❌ Erro ao consultar status da sessão ${sessionName} na WAHA:`, wahaError.message);
      // Se não conseguir acessar WAHA, mas temos a sessão no banco com status SCAN_QR_CODE,
      // vamos tentar gerar o QR usando apenas a URL
      if (sessionData.status === 'SCAN_QR_CODE') {
        console.log(`🔄 Tentando gerar QR com base no banco (status: ${sessionData.status})`);
        sessionStatus = { status: 'SCAN_QR_CODE' };
      } else {
        return res.status(400).json({
          error: 'Não foi possível acessar a API WAHA para verificar o status da sessão',
          details: wahaError.message
        });
      }
    }

    // Priorizar status do banco se for SCAN_QR_CODE, senão usar status da WAHA
    const effectiveStatus = sessionData.status === 'SCAN_QR_CODE' ? 'SCAN_QR_CODE' : sessionStatus.status;
    console.log(`🔄 Status efetivo para ${sessionName}: ${effectiveStatus} (banco: ${sessionData.status}, WAHA: ${sessionStatus.status})`);

    if (effectiveStatus === 'SCAN_QR_CODE') {
      // Sessão está aguardando QR code - buscar QR da WAHA API
      console.log(`📱 Buscando QR code da WAHA API para sessão ${sessionName}`);

      try {
        // Buscar configurações WAHA
        const config = await settingsService.getWahaConfig();
        const WAHA_BASE_URL = config.host || process.env.WAHA_BASE_URL || process.env.DEFAULT_WAHA_HOST || '';
        const WAHA_API_KEY = config.apiKey || process.env.WAHA_API_KEY || process.env.DEFAULT_WAHA_API_KEY || '';

        // Buscar QR como imagem e converter para base64
        const qrImageUrl = `${WAHA_BASE_URL}/api/${sessionName}/auth/qr?format=image`;
        console.log(`📱 Buscando QR image da WAHA: ${qrImageUrl}`);

        const response = await fetch(qrImageUrl, {
          headers: {
            'X-API-KEY': WAHA_API_KEY,
            'Accept': 'image/png'
          }
        });

        if (!response.ok) {
          throw new Error(`Erro ao buscar QR da WAHA: ${response.status} ${response.statusText}`);
        }

        // Converter para base64
        const imageBuffer = await response.arrayBuffer();
        const base64Image = Buffer.from(imageBuffer).toString('base64');
        const qrBase64 = `data:image/png;base64,${base64Image}`;

        console.log(`📱 QR convertido para base64, tamanho: ${qrBase64.length} caracteres`);

        const expiresAt = new Date(Date.now() + 300000); // 5 minutos

        // Salvar o QR base64 no banco de dados
        await WhatsAppSessionService.createOrUpdateSession({
          name: sessionName,
          status: 'SCAN_QR_CODE',
          provider: 'WAHA',
          qr: qrBase64,
          qrExpiresAt: expiresAt,
          tenantId: sessionData.tenantId
        });

        console.log(`💾 QR WAHA base64 salvo no banco para sessão ${sessionName}`);

        res.json({
          qr: qrBase64,
          expiresAt: expiresAt,
          status: 'SCAN_QR_CODE',
          provider: 'WAHA',
          message: "QR code obtido da WAHA API e convertido para base64"
        });

      } catch (qrError: any) {
        console.error('❌ Erro ao buscar QR da WAHA:', qrError);

        res.status(500).json({
          error: 'Erro ao obter QR Code da WAHA API',
          details: qrError.message
        });
      }

    } else if (effectiveStatus === 'WORKING') {
      console.log(`✅ Sessão ${sessionName} já está conectada`);
      res.status(400).json({
        error: 'Sessão já está conectada',
        status: effectiveStatus
      });

    } else {
      // Para outros status (FAILED, STOPPED), ainda retornar QR se existe no banco
      try {
        if (sessionData.qr && sessionData.qrExpiresAt && sessionData.qrExpiresAt > new Date()) {
          console.log(`📋 Retornando QR existente do banco para sessão ${sessionName} (status: ${effectiveStatus})`);
          return res.json({
            qr: sessionData.qr,
            expiresAt: sessionData.qrExpiresAt,
            status: effectiveStatus,
            message: "QR code retornado do banco (sessão não disponível)"
          });
        }
      } catch (dbError) {
        // Continua para gerar erro abaixo
      }

      console.log(`❌ Sessão ${sessionName} não está disponível para QR code`);
      res.status(400).json({
        error: 'Sessão não está disponível para QR code',
        status: effectiveStatus
      });
    }
    }

  } catch (error) {
    console.error('Erro ao obter QR Code da WAHA:', error);
    res.status(500).json({ error: 'Erro ao obter QR Code' });
  }
});

// Obter status da sessão (leitura rápida do banco — para polling do QR modal)
router.get('/sessions/:sessionName/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    try {
      const session = await WhatsAppSessionService.getSession(sessionName, tenantId);
      res.json({
        name: session.name,
        displayName: session.displayName,
        status: session.status,
        provider: session.provider,
        me: session.me,
        qr: session.qr,
        qrExpiresAt: session.qrExpiresAt,
      });
    } catch (error) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
  } catch (error) {
    console.error('Erro ao obter status:', error);
    res.status(500).json({ error: 'Erro ao obter status da sessão' });
  }
});

// Obter informações "me" da sessão
router.get('/sessions/:sessionName/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    console.log('👤 GET /sessions/:sessionName/me - sessionName:', sessionName, 'user:', req.user?.email, 'tenantId:', req.tenantId);

    // SUPERADMIN pode ver informações de qualquer sessão, outros usuários só do seu tenant
    const tenantId = req.user?.role === 'SUPERADMIN' ? undefined : req.tenantId;

    // Verificar se a sessão pertence ao tenant
    try {
      await WhatsAppSessionService.getSession(sessionName, tenantId);
    } catch (error) {
      console.error('❌ Sessão não encontrada ou não pertence ao tenant:', error);
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    const me = await wahaRequest(`/api/sessions/${sessionName}/me`);
    res.json(me);
  } catch (error) {
    console.error('Erro ao obter informações do usuário:', error);
    res.status(500).json({ error: 'Erro ao obter informações do usuário' });
  }
});

// Associar sessão a um tenant (SUPERADMIN only)
router.patch('/sessions/:sessionName/assign-tenant', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionName } = req.params;
    const { tenantId } = req.body;

    console.log('🔧 PATCH /sessions/:sessionName/assign-tenant - sessionName:', sessionName, 'tenantId:', tenantId, 'user:', req.user?.email);

    // Apenas SUPERADMIN pode associar sessões a tenants
    if (req.user?.role !== 'SUPERADMIN') {
      return res.status(403).json({ error: 'Apenas SUPERADMIN pode associar sessões a tenants' });
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    // Buscar sessão sem filtro de tenant (SUPERADMIN vê todas)
    const session = await WhatsAppSessionService.getSession(sessionName);

    // Atualizar sessão com o novo tenantId
    await WhatsAppSessionService.createOrUpdateSession({
      name: sessionName,
      status: session.status as any,
      provider: session.provider as 'WAHA' | 'EVOLUTION',
      me: session.me ? {
        id: session.me.id,
        pushName: session.me.pushName,
        lid: session.me.lid || undefined,
        jid: session.me.jid || undefined
      } : undefined,
      qr: session.qr || undefined,
      qrExpiresAt: session.qrExpiresAt || undefined,
      tenantId
    });

    console.log(`✅ Sessão ${sessionName} associada ao tenant ${tenantId}`);
    res.json({ success: true, message: 'Sessão associada ao tenant com sucesso' });
  } catch (error) {
    console.error('Erro ao associar sessão:', error);
    res.status(500).json({ error: 'Erro ao associar sessão ao tenant' });
  }
});

export default router;
