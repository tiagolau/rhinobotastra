import { WhatsAppSessionService } from './whatsappSessionService';
import { wahaRequest } from '../lib/wahaRequest';

export class WahaSyncService {
  /**
   * Sincroniza todas as sessões da WAHA API com o banco de dados.
   * Usa Map para evitar queries individuais por sessão existente.
   */
  static async syncAllSessions(): Promise<any[]> {
    try {
      const wahaSessions = await wahaRequest('/api/sessions');
      const dbSessions = await WhatsAppSessionService.getAllSessions();
      const sessionMap = new Map(dbSessions.map((s: any) => [s.name, s]));

      for (const wahaSession of wahaSessions) {
        const existing = sessionMap.get(wahaSession.name) || null;

        await WhatsAppSessionService.createOrUpdateSession({
          name: wahaSession.name,
          displayName: existing?.displayName || wahaSession.name,
          status: wahaSession.status || 'STOPPED',
          provider: 'WAHA',
          config: wahaSession.config,
          me: wahaSession.me,
          assignedWorker: wahaSession.assignedWorker,
          qr: existing?.qr || undefined,
          qrExpiresAt: existing?.qrExpiresAt || undefined,
          tenantId: existing?.tenantId || undefined,
        });
      }

      return await WhatsAppSessionService.getAllSessions();
    } catch (error) {
      console.warn('Erro na sincronização com WAHA API:', error);
      return await WhatsAppSessionService.getAllSessions();
    }
  }

  /**
   * Sincroniza uma sessão específica usando dados pré-carregados do banco.
   * Reduz de 3 queries/sessão para 1 (upsert).
   */
  static async syncSessionWithExisting(sessionName: string, existingSession: any): Promise<any> {
    try {
      const wahaSession = await wahaRequest(`/api/sessions/${sessionName}`);

      await WhatsAppSessionService.createOrUpdateSession({
        name: wahaSession.name,
        displayName: existingSession?.displayName || wahaSession.name,
        status: wahaSession.status || 'STOPPED',
        provider: 'WAHA',
        config: wahaSession.config,
        me: wahaSession.me,
        assignedWorker: wahaSession.assignedWorker,
        qr: existingSession?.qr || undefined,
        qrExpiresAt: existingSession?.qrExpiresAt || undefined,
        tenantId: existingSession?.tenantId || undefined,
      });

      return { ...existingSession, status: wahaSession.status || 'STOPPED', me: wahaSession.me };
    } catch (error) {
      console.warn(`Erro ao sincronizar sessão ${sessionName}:`, error);
      return existingSession;
    }
  }

  /**
   * Sincroniza uma sessão específica (sem dados pré-carregados — fallback)
   */
  static async syncSession(sessionName: string): Promise<any> {
    try {
      const wahaSession = await wahaRequest(`/api/sessions/${sessionName}`);

      let existingSession = null;
      try {
        existingSession = await WhatsAppSessionService.getSession(sessionName);
      } catch (error) {
        // Sessão não existe no banco, criar nova
      }

      await WhatsAppSessionService.createOrUpdateSession({
        name: wahaSession.name,
        displayName: existingSession?.displayName || wahaSession.name,
        status: wahaSession.status || 'STOPPED',
        provider: 'WAHA',
        config: wahaSession.config,
        me: wahaSession.me,
        assignedWorker: wahaSession.assignedWorker,
        qr: existingSession?.qr || undefined,
        qrExpiresAt: existingSession?.qrExpiresAt || undefined,
        tenantId: existingSession?.tenantId || undefined,
      });

      return WhatsAppSessionService.getSession(sessionName);
    } catch (error) {
      console.warn(`Erro ao sincronizar sessão ${sessionName}:`, error);

      try {
        return await WhatsAppSessionService.getSession(sessionName);
      } catch (dbError) {
        throw new Error(`Sessão ${sessionName} não encontrada`);
      }
    }
  }

  /**
   * Cria uma nova sessão na WAHA API e salva no banco
   */
  static async createSession(name: string, webhookUrl?: string): Promise<any> {
    const sessionData: any = {
      name,
      config: {
        proxy: null,
        webhooks: [],
      },
    };

    if (webhookUrl) {
      sessionData.config.webhooks = [
        {
          url: webhookUrl,
          events: ['message.any'],
          hmac: null,
          retries: null,
          customHeaders: null,
        },
      ];
    }

    try {
      const result = await wahaRequest('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(sessionData),
      });

      await WhatsAppSessionService.createOrUpdateSession({
        name,
        status: 'STOPPED',
        provider: 'WAHA',
        config: sessionData.config,
      });

      return result;
    } catch (error: any) {
      if (error.message && error.message.includes('422')) {
        try {
          const existingSession = await wahaRequest(`/api/sessions/${name}`);

          await WhatsAppSessionService.createOrUpdateSession({
            name,
            status: existingSession.status || 'STOPPED',
            provider: 'WAHA',
            config: existingSession.config || sessionData.config,
          });

          return existingSession;
        } catch (fetchError) {
          throw new Error(`Sessão "${name}" já existe mas não foi possível obter detalhes`);
        }
      }

      throw error;
    }
  }

  /**
   * Deleta uma sessão da WAHA API e do banco
   */
  static async deleteSession(sessionName: string): Promise<void> {
    try {
      await wahaRequest(`/api/sessions/${sessionName}`, { method: 'DELETE' });
    } catch (wahaError) {
      console.warn(`Erro ao remover da WAHA API: ${wahaError}`);
    }

    await WhatsAppSessionService.deleteSession(sessionName);
  }

  /**
   * Inicia uma sessão e atualiza status no banco
   */
  static async startSession(sessionName: string): Promise<any> {
    const result = await wahaRequest(`/api/sessions/${sessionName}/start`, {
      method: 'POST',
    });

    await WhatsAppSessionService.updateSessionStatus(sessionName, 'SCAN_QR_CODE');
    return result;
  }

  /**
   * Para uma sessão e atualiza status no banco
   */
  static async stopSession(sessionName: string): Promise<any> {
    const result = await wahaRequest(`/api/sessions/${sessionName}/stop`, {
      method: 'POST',
    });

    await WhatsAppSessionService.updateSessionStatus(sessionName, 'STOPPED');
    return result;
  }

  /**
   * Reinicia uma sessão
   */
  static async restartSession(sessionName: string): Promise<any> {
    const result = await wahaRequest(`/api/sessions/${sessionName}/restart`, {
      method: 'POST',
    });

    setTimeout(async () => {
      try {
        await this.syncSession(sessionName);
      } catch (error) {
        console.warn(`Erro ao sincronizar após restart: ${error}`);
      }
    }, 2000);

    return result;
  }
}
