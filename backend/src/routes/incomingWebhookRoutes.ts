import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { interactiveCampaignFlowEngine } from '../services/interactiveCampaignFlowEngine';

const router = Router();
const prisma = new PrismaClient();

/**
 * Endpoint para receber webhooks de mensagens dos providers
 * URL: /api/webhooks/incoming/:sessionId/:webhookSecret
 */
router.post('/incoming/:sessionId/:webhookSecret', async (req: Request, res: Response) => {
  try {
    const { sessionId, webhookSecret } = req.params;
    const payload = req.body;

    console.log(`[WEBHOOK-INCOMING] 📨 Recebido na rota /incoming - SessionId: ${sessionId}, event: ${payload?.event || 'unknown'}`);

    // Buscar sessão no banco de dados
    const session = await prisma.whatsAppSession.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      console.error(`❌ Sessão não encontrada: ${sessionId}`);
      return res.status(404).json({ error: 'Session not found' });
    }

    // Validar webhook secret (temporariamente desabilitado para debug)
    // if (session.webhookSecret !== webhookSecret) {
    //   console.error(`❌ Webhook secret inválido para sessão: ${sessionId}`);
    //   console.error(`Expected: ${session.webhookSecret}, Got: ${webhookSecret}`);
    //   return res.status(401).json({ error: 'Invalid webhook secret' });
    // }

    // Verificar se campanha interativa está habilitada
    if (!session.interactiveCampaignEnabled) {
      console.warn(`⚠️ Campanha interativa não habilitada para sessão: ${sessionId}`);
      // Habilitar temporariamente para teste
      console.log(`🔧 Habilitando campanha interativa temporariamente...`);
      // return res.status(200).json({ message: 'Interactive campaign not enabled' });
    }

    console.log(`✅ Webhook válido para sessão: ${session.name} (${session.displayName})`);

    // Processar mensagem baseado no provider
    let messageData;

    switch (session.provider) {
      case 'EVOLUTION':
        messageData = extractEvolutionMessage(payload);
        break;
      case 'WAHA':
        messageData = extractWahaMessage(payload);
        break;
      case 'QUEPASA':
        messageData = extractQuepasaMessage(payload);
        break;
      default:
        console.error(`❌ Provider desconhecido: ${session.provider}`);
        return res.status(400).json({ error: 'Unknown provider' });
    }

    if (!messageData) {
      console.warn(`[WEBHOOK-INCOMING] ⚠️ Payload não reconhecido - event: ${payload?.event}, keys: ${Object.keys(payload || {}).join(',')}`);
      return res.status(200).json({ message: 'Message ignored' });
    }

    console.log(`[WEBHOOK-INCOMING] 📝 Mensagem extraída - from: ${messageData.fromNumber}, fromMe: ${messageData.isFromMe}, content: "${(messageData.content || '').substring(0, 50)}"`);

    // Ignorar mensagens enviadas pelo bot (isFromMe = true)
    if (messageData.isFromMe) {
      console.log(`[WEBHOOK-INCOMING] ⏭️ Ignorando mensagem do bot (fromMe=true)`);
      return res.status(200).json({
        success: true,
        message: 'Message from bot ignored',
      });
    }

    // Processar mensagem no flow engine
    console.log(`[WEBHOOK-INCOMING] 🔄 Chamando flow engine para ${messageData.fromNumber}...`);
    try {
      const result = await interactiveCampaignFlowEngine.processIncomingMessage({
        contactPhone: messageData.fromNumber,
        messageContent: messageData.content,
        sessionId: session.id,
      });

      console.log(`[WEBHOOK-INCOMING] ✅ Flow engine result:`, JSON.stringify(result));

      res.status(200).json({
        success: true,
        message: 'Webhook received and processed',
        sessionName: session.name,
        provider: session.provider,
        flowResult: result,
      });
    } catch (flowError: any) {
      console.error(`❌ Error processing flow:`, flowError);
      // Retornar 200 mesmo com erro para não fazer o provider reenviar
      res.status(200).json({
        success: true,
        message: 'Webhook received but flow processing failed',
        error: flowError.message,
      });
    }

  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Extrai dados de mensagem do payload da Evolution API
 */
function extractEvolutionMessage(payload: any) {
  try {
    // Evolution API format: { event: 'messages.upsert', data: { ... } }
    if (payload.event === 'messages.upsert' && payload.data) {
      const message = payload.data;
      return {
        messageId: message.key?.id,
        from: message.key?.remoteJid,
        fromNumber: message.key?.remoteJid?.split('@')[0],
        timestamp: message.messageTimestamp,
        type: message.messageType || 'text',
        content: message.message?.conversation ||
                 message.message?.extendedTextMessage?.text ||
                 message.message?.imageMessage?.caption ||
                 '',
        isFromMe: message.key?.fromMe || false,
        raw: payload
      };
    }
    return null;
  } catch (error) {
    console.error('Erro ao extrair mensagem Evolution:', error);
    return null;
  }
}

/**
 * Extrai dados de mensagem do payload da WAHA
 */
function extractWahaMessage(payload: any) {
  try {
    // WAHA format: { event: 'message.any', session: '...', payload: { ... } }
    if (payload.event === 'message.any' && payload.payload) {
      const message = payload.payload;
      return {
        messageId: message.id,
        from: message.from,
        fromNumber: message.from?.split('@')[0],
        timestamp: message.timestamp,
        type: message.type || 'text',
        content: message.body || message.caption || '',
        isFromMe: message.fromMe || false,
        raw: payload
      };
    }
    return null;
  } catch (error) {
    console.error('Erro ao extrair mensagem WAHA:', error);
    return null;
  }
}

/**
 * Extrai dados de mensagem do payload do QuePasa
 *
 * Formato real do QuePasa:
 * {
 *   "id": "3EB08C1240B8974B5F48B6",
 *   "timestamp": "2025-12-10T09:24:19...",
 *   "type": "text",
 *   "chat": {
 *     "id": "556196878959@s.whatsapp.net",
 *     "phone": "+556196878959",
 *     "title": "Raphael"
 *   },
 *   "text": "oi",
 *   "fromme": false,
 *   "frominternal": false,
 *   "wid": "556793363369:3@s.whatsapp.net"
 * }
 */
function extractQuepasaMessage(payload: any) {
  try {
    // Formato direto do QuePasa (novo formato)
    if (payload.chat && payload.id) {
      const fromNumber = payload.chat.phone
        ? payload.chat.phone.replace(/\D/g, '') // Remove +, -, espaços
        : payload.chat.id?.split('@')[0];

      return {
        messageId: payload.id,
        from: payload.chat.id,
        fromNumber: fromNumber,
        timestamp: payload.timestamp || Date.now(),
        type: payload.type || 'text',
        content: payload.text || payload.caption || '',
        isFromMe: payload.fromme === true || payload.frominternal === true,
        raw: payload
      };
    }

    // Formato antigo (fallback): { message: { ... }, source: { ... } }
    if (payload.message) {
      const message = payload.message;
      return {
        messageId: message.id,
        from: message.wid || message.chatId,
        fromNumber: (message.wid || message.chatId)?.split('@')[0],
        timestamp: message.timestamp || Date.now(),
        type: message.type || 'text',
        content: message.text || message.caption || '',
        isFromMe: message.fromme === true,
        raw: payload
      };
    }

    console.warn('⚠️ Formato de payload QuePasa não reconhecido:', JSON.stringify(payload, null, 2));
    return null;
  } catch (error) {
    console.error('Erro ao extrair mensagem QuePasa:', error);
    return null;
  }
}

export default router;
