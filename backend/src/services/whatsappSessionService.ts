import { prisma } from '../lib/prisma';

export interface WhatsAppSessionData {
  name: string; // Nome real usado na API (ex: vendas_c52982e8)
  displayName?: string; // Nome exibido ao usuário (ex: vendas)
  status: 'WORKING' | 'SCAN_QR_CODE' | 'STOPPED' | 'FAILED';
  provider: 'WAHA' | 'EVOLUTION' | 'QUEPASA';
  config?: any;
  me?: {
    id: string;
    pushName: string;
    lid?: string;
    jid?: string;
  };
  qr?: string;
  qrExpiresAt?: Date;
  assignedWorker?: string;
  tenantId?: string;
  quepasaToken?: string; // Token único para cada sessão Quepasa
  interactiveCampaignEnabled?: boolean; // Habilitar webhooks para campanhas interativas
  webhookSecret?: string; // Token único para validar webhooks
}

export class WhatsAppSessionService {
  static async getAllSessions(tenantId?: string) {
    const where: any = {};
    if (tenantId) {
      where.tenantId = tenantId;
    }

    const sessions = await prisma.whatsAppSession.findMany({
      where,
      orderBy: { atualizadoEm: 'desc' }
    });

    return sessions.map(session => ({
      name: session.name,
      displayName: session.displayName || session.name,
      status: session.status,
      provider: session.provider as 'WAHA' | 'EVOLUTION' | 'QUEPASA',
      config: session.config ? JSON.parse(session.config) : {},
      me: session.meId ? {
        id: session.meId,
        pushName: session.mePushName || '',
        lid: session.meLid,
        jid: session.meJid
      } : undefined,
      qr: session.qr,
      qrExpiresAt: session.qrExpiresAt,
      assignedWorker: session.assignedWorker,
      tenantId: session.tenantId,
      quepasaToken: session.quepasaToken
    }));
  }

  static async getSession(name: string, tenantId?: string) {
    const where: any = { name };
    if (tenantId) {
      where.tenantId = tenantId;
    }

    const session = await prisma.whatsAppSession.findFirst({ where });

    if (!session) {
      throw new Error('Sessão não encontrada');
    }

    return {
      name: session.name,
      displayName: session.displayName || session.name,
      status: session.status,
      provider: session.provider,
      config: session.config ? JSON.parse(session.config) : {},
      me: session.meId ? {
        id: session.meId,
        pushName: session.mePushName || '',
        lid: session.meLid,
        jid: session.meJid
      } : undefined,
      qr: session.qr,
      qrExpiresAt: session.qrExpiresAt,
      assignedWorker: session.assignedWorker,
      tenantId: session.tenantId,
      quepasaToken: session.quepasaToken
    };
  }

  static async createOrUpdateSession(data: WhatsAppSessionData) {
    // Dados base para criação
    const baseData = {
      name: data.name,
      displayName: data.displayName || data.name,
      status: data.status,
      provider: data.provider,
      config: data.config ? JSON.stringify(data.config) : null,
      meId: data.me?.id || null,
      mePushName: data.me?.pushName || null,
      meLid: data.me?.lid || null,
      meJid: data.me?.jid || null,
      qr: data.qr || null,
      qrExpiresAt: data.qrExpiresAt || null,
      assignedWorker: data.assignedWorker || null,
      tenantId: data.tenantId || null,
      quepasaToken: data.quepasaToken || null,
    };

    // Dados para update - só incluir interactiveCampaignEnabled e webhookSecret se foram explicitamente passados
    const updateData: any = {
      ...baseData,
      atualizadoEm: new Date()
    };

    // Só atualizar esses campos se foram explicitamente passados (não undefined)
    if (data.interactiveCampaignEnabled !== undefined) {
      updateData.interactiveCampaignEnabled = data.interactiveCampaignEnabled;
    }
    if (data.webhookSecret !== undefined) {
      updateData.webhookSecret = data.webhookSecret;
    }

    // Dados para criação - incluir valores default
    const createData = {
      ...baseData,
      interactiveCampaignEnabled: data.interactiveCampaignEnabled || false,
      webhookSecret: data.webhookSecret || null,
      criadoEm: new Date(),
      atualizadoEm: new Date()
    };

    const session = await prisma.whatsAppSession.upsert({
      where: { name: data.name },
      update: updateData,
      create: createData
    });

    return session;
  }

  static async deleteSession(name: string, tenantId?: string) {
    const where: any = { name };

    // Verificar se a sessão existe e pertence ao tenant (se aplicável)
    if (tenantId) {
      const session = await prisma.whatsAppSession.findFirst({
        where: { name, tenantId }
      });

      if (!session) {
        throw new Error('Sessão não encontrada ou não pertence ao tenant');
      }
    }

    await prisma.whatsAppSession.delete({
      where: { name }
    });
  }

  static async updateSessionStatus(name: string, status: string, additionalData?: Partial<WhatsAppSessionData>, tenantId?: string) {
    if (tenantId) {
      const session = await prisma.whatsAppSession.findFirst({
        where: { name, tenantId }
      });

      if (!session) {
        throw new Error('Sessão não encontrada ou não pertence ao tenant');
      }
    }

    const updateData: any = {
      status,
      atualizadoEm: new Date()
    };

    if (additionalData?.me) {
      updateData.meId = additionalData.me.id;
      updateData.mePushName = additionalData.me.pushName;
      updateData.meLid = additionalData.me.lid;
      updateData.meJid = additionalData.me.jid;
    }

    if (additionalData?.qr !== undefined) {
      updateData.qr = additionalData.qr;
    }

    if (additionalData?.qrExpiresAt !== undefined) {
      updateData.qrExpiresAt = additionalData.qrExpiresAt;
    }

    if (additionalData?.assignedWorker !== undefined) {
      updateData.assignedWorker = additionalData.assignedWorker;
    }

    if (additionalData?.tenantId !== undefined) {
      updateData.tenantId = additionalData.tenantId;
    }

    await prisma.whatsAppSession.update({
      where: { name },
      data: updateData
    });
  }

  /**
   * Atualização rápida de status para operações de sync onde a sessão já existe.
   * Single UPDATE — sem verificação de tenant, sem serialização JSON de config.
   */
  static async updateStatusFast(
    name: string,
    status: string,
    meData?: { id: string; pushName: string; lid?: string; jid?: string },
    additionalFields?: { qr?: string | null; qrExpiresAt?: Date | null; assignedWorker?: string | null; quepasaToken?: string | null; displayName?: string }
  ) {
    const updateData: any = {
      status,
      atualizadoEm: new Date(),
    };

    if (meData) {
      updateData.meId = meData.id;
      updateData.mePushName = meData.pushName;
      updateData.meLid = meData.lid || null;
      updateData.meJid = meData.jid || null;
    }

    if (additionalFields?.qr !== undefined) updateData.qr = additionalFields.qr;
    if (additionalFields?.qrExpiresAt !== undefined) updateData.qrExpiresAt = additionalFields.qrExpiresAt;
    if (additionalFields?.assignedWorker !== undefined) updateData.assignedWorker = additionalFields.assignedWorker;
    if (additionalFields?.quepasaToken !== undefined) updateData.quepasaToken = additionalFields.quepasaToken;
    if (additionalFields?.displayName !== undefined) updateData.displayName = additionalFields.displayName;

    await prisma.whatsAppSession.update({
      where: { name },
      data: updateData,
    });
  }

  /**
   * Atualização em batch de múltiplas sessões numa única transação.
   * Usado após sync para minimizar round-trips ao banco.
   */
  static async batchUpdateStatus(
    updates: Array<{
      name: string;
      status: string;
      me?: { id: string; pushName: string; lid?: string; jid?: string };
    }>
  ) {
    if (updates.length === 0) return;

    const operations = updates.map((u) =>
      prisma.whatsAppSession.update({
        where: { name: u.name },
        data: {
          status: u.status,
          meId: u.me?.id || undefined,
          mePushName: u.me?.pushName || undefined,
          meLid: u.me?.lid || undefined,
          meJid: u.me?.jid || undefined,
          atualizadoEm: new Date(),
        },
      })
    );

    await prisma.$transaction(operations);
  }
}