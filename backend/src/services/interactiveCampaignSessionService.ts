/**
 * Interactive Campaign Session Service
 * Gerencia o estado de cada contato durante uma campanha interativa
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface CreateSessionData {
  campaignId: string;
  contactId: string;
  contactPhone: string;
  currentNodeId: string;
  tenantId?: string;
  status?: string;
  variables?: Record<string, any>;
}

export interface UpdateSessionData {
  currentNodeId?: string;
  status?: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  variables?: Record<string, any>;
  lastResponse?: string;
  lastMessageAt?: Date;
}

export interface VisitedNode {
  nodeId: string;
  visitedAt: Date;
  sent: boolean;
  error?: string;
}

export const interactiveCampaignSessionService = {
  /**
   * Cria ou atualiza uma sessão de contato em uma campanha
   */
  async upsertSession(data: CreateSessionData) {
    console.log(`📝 Creating/updating session for contact ${data.contactPhone} in campaign ${data.campaignId}`);

    return prisma.interactiveCampaignSession.upsert({
      where: {
        campaignId_contactId: {
          campaignId: data.campaignId,
          contactId: data.contactId,
        },
      },
      create: {
        campaignId: data.campaignId,
        contactId: data.contactId,
        contactPhone: data.contactPhone,
        currentNodeId: data.currentNodeId,
        tenantId: data.tenantId,
        status: data.status || 'ACTIVE',
        variables: data.variables || {},
        lastMessageAt: new Date(),
      },
      update: {
        currentNodeId: data.currentNodeId,
        lastMessageAt: new Date(),
        status: data.status || 'ACTIVE',
      },
    });
  },

  /**
   * Busca sessão ativa de um contato em uma campanha
   */
  async getActiveSession(campaignId: string, contactId: string) {
    return prisma.interactiveCampaignSession.findFirst({
      where: {
        campaignId,
        contactId,
        status: 'ACTIVE',
      },
      include: {
        campaign: true,
        contact: true,
      },
    });
  },

  /**
   * Busca sessão ativa por telefone (para webhook)
   * Lida com normalização de números brasileiros onde o WhatsApp
   * pode remover o 9° dígito no JID (ex: 5531991570107 -> 553191570107)
   */
  async getActiveSessionByPhone(contactPhone: string) {
    // Normalizar telefone (remover caracteres especiais)
    const normalizedPhone = contactPhone.replace(/[^\d]/g, '');

    // Gerar variações de número brasileiro (com/sem 9° dígito)
    const phoneVariations = [normalizedPhone];

    if (normalizedPhone.startsWith('55') && normalizedPhone.length >= 12) {
      const ddd = normalizedPhone.substring(2, 4);
      const rest = normalizedPhone.substring(4);

      if (normalizedPhone.length === 12) {
        // Número sem 9° dígito (12 dígitos: 55+DDD+8dig) - adicionar 9
        phoneVariations.push(`55${ddd}9${rest}`);
      } else if (normalizedPhone.length === 13 && rest.startsWith('9')) {
        // Número com 9° dígito (13 dígitos: 55+DDD+9+8dig) - remover 9
        phoneVariations.push(`55${ddd}${rest.substring(1)}`);
      }
    }

    console.log(`[SESSION-LOOKUP] 🔍 Buscando sessão ativa - input: ${contactPhone}, variações: [${phoneVariations.join(', ')}]`);

    const session = await prisma.interactiveCampaignSession.findFirst({
      where: {
        OR: phoneVariations.map(phone => ({
          contactPhone: { contains: phone },
        })),
        status: 'ACTIVE',
      },
      include: {
        campaign: true,
        contact: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    if (session) {
      console.log(`[SESSION-LOOKUP] ✅ Sessão encontrada - id: ${session.id}, campanha: "${session.campaign.name}", nó atual: ${session.currentNodeId}, telefone armazenado: ${session.contactPhone}`);
    } else {
      // Log extra para debug: listar sessões ativas existentes
      const activeSessions = await prisma.interactiveCampaignSession.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, contactPhone: true, currentNodeId: true, campaignId: true },
        take: 10,
      });
      console.log(`[SESSION-LOOKUP] ❌ Nenhuma sessão encontrada para [${phoneVariations.join(', ')}]. Sessões ativas no sistema: ${activeSessions.length > 0 ? activeSessions.map(s => `${s.contactPhone} (nó: ${s.currentNodeId})`).join(', ') : 'NENHUMA'}`);
    }

    return session;
  },

  /**
   * Atualiza estado da sessão
   */
  async updateSession(sessionId: string, data: UpdateSessionData) {
    console.log(`🔄 Updating session ${sessionId}:`, data);

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (data.currentNodeId !== undefined) {
      updateData.currentNodeId = data.currentNodeId;
    }

    if (data.status !== undefined) {
      updateData.status = data.status;
    }

    if (data.lastResponse !== undefined) {
      updateData.lastResponse = data.lastResponse;
    }

    if (data.lastMessageAt !== undefined) {
      updateData.lastMessageAt = data.lastMessageAt;
    }

    if (data.variables !== undefined) {
      // Mesclar variáveis existentes com novas
      const session = await prisma.interactiveCampaignSession.findUnique({
        where: { id: sessionId },
      });

      if (session) {
        const existingVars = (session.variables as Record<string, any>) || {};
        updateData.variables = { ...existingVars, ...data.variables };
      } else {
        updateData.variables = data.variables;
      }
    }

    return prisma.interactiveCampaignSession.update({
      where: { id: sessionId },
      data: updateData,
    });
  },

  /**
   * Finaliza sessão e verifica se a campanha pode ser marcada como COMPLETED
   */
  async completeSession(sessionId: string) {
    const updatedSession = await this.updateSession(sessionId, {
      status: 'COMPLETED',
      lastMessageAt: new Date(),
    });

    // Verificar se todas as sessões da campanha foram finalizadas
    await this.checkAndCompleteCampaign(updatedSession.campaignId);

    return updatedSession;
  },

  /**
   * Verifica se todas as sessões de uma campanha terminaram e atualiza o status da campanha
   */
  async checkAndCompleteCampaign(campaignId: string) {
    const activeSessions = await prisma.interactiveCampaignSession.count({
      where: {
        campaignId,
        status: 'ACTIVE',
      },
    });

    if (activeSessions === 0) {
      const campaign = await prisma.interactiveCampaign.findUnique({
        where: { id: campaignId },
        select: { status: true },
      });

      // Só marcar como COMPLETED se a campanha está STARTED (dispatch já ocorreu)
      if (campaign && campaign.status === 'STARTED') {
        await prisma.interactiveCampaign.update({
          where: { id: campaignId },
          data: { status: 'COMPLETED' },
        });
        console.log(`✅ All sessions completed - Campaign ${campaignId} status updated to COMPLETED`);
      }
    } else {
      console.log(`⏳ Campaign ${campaignId} still has ${activeSessions} active sessions`);
    }
  },

  /**
   * Marca sessão como falha e verifica se a campanha pode ser marcada como COMPLETED
   */
  async failSession(sessionId: string) {
    const updatedSession = await this.updateSession(sessionId, {
      status: 'FAILED',
      lastMessageAt: new Date(),
    });

    // Verificar se todas as sessões da campanha foram finalizadas
    await this.checkAndCompleteCampaign(updatedSession.campaignId);

    return updatedSession;
  },

  /**
   * Lista todas as sessões de uma campanha
   */
  async getCampaignSessions(campaignId: string, status?: string) {
    return prisma.interactiveCampaignSession.findMany({
      where: {
        campaignId,
        ...(status && { status }),
      },
      include: {
        contact: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
  },

  /**
   * Exclui sessões antigas/expiradas
   */
  async cleanupExpiredSessions(olderThanDays: number = 7) {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() - olderThanDays);

    const result = await prisma.interactiveCampaignSession.updateMany({
      where: {
        status: 'ACTIVE',
        updatedAt: {
          lt: expirationDate,
        },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    console.log(`🧹 Expired ${result.count} inactive sessions older than ${olderThanDays} days`);
    return result;
  },

  /**
   * Registra que um nó foi visitado/enviado
   */
  async addVisitedNode(sessionId: string, nodeId: string, sent: boolean, error?: string) {
    const session = await prisma.interactiveCampaignSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new Error('Session not found');
    }

    const visitedNodes = (session.visitedNodes as any[]) || [];

    // Adicionar novo nó visitado
    visitedNodes.push({
      nodeId,
      visitedAt: new Date().toISOString(),
      sent,
      ...(error && { error }),
    });

    return prisma.interactiveCampaignSession.update({
      where: { id: sessionId },
      data: {
        visitedNodes,
      },
    });
  },
};
