/**
 * Interactive Campaign Dispatch Service
 * Envia mensagens iniciais de campanhas interativas para contatos configurados
 */

import { PrismaClient } from '@prisma/client';
import { sendMessage, checkContactExists } from './wahaApiService';
import { sendMessageViaEvolution, checkContactExistsEvolution, getEvolutionCredentialsFromSession } from './evolutionMessageService';
import { sendMessageViaQuepasa, checkContactExistsQuepasa } from './quepasaMessageService';
import { interactiveCampaignSessionService } from './interactiveCampaignSessionService';

const prisma = new PrismaClient();

export const interactiveCampaignDispatchService = {
  /**
   * Dispara campanha interativa quando publicada
   */
  async dispatchCampaign(campaignId: string) {
    try {
      console.log(`📤 Starting dispatch for interactive campaign ${campaignId}`);

      const campaign = await prisma.interactiveCampaign.findUnique({
        where: { id: campaignId },
      });

      if (!campaign) {
        throw new Error('Campanha não encontrada');
      }

      if (campaign.status !== 'STARTED' && campaign.status !== 'SCHEDULED') {
        throw new Error('Campanha não está iniciada ou agendada');
      }

      const graph = campaign.graph as any;

      // Buscar nó trigger
      const triggerNode = graph.nodes?.find((n: any) => n.data?.nodeType === 'trigger');

      if (!triggerNode) {
        throw new Error('Campanha não tem nó Trigger');
      }

      const triggerConfig = triggerNode.data?.config;

      if (!triggerConfig) {
        throw new Error('Trigger não está configurado');
      }

      // Validar configuração
      const connections = triggerConfig.connections || [];
      const categories = triggerConfig.categories || [];

      if (connections.length === 0) {
        throw new Error('Nenhuma conexão configurada no Trigger');
      }

      if (categories.length === 0) {
        throw new Error('Nenhuma categoria configurada no Trigger');
      }

      console.log(`✅ Trigger config - Connections: ${connections.length}, Categories: ${categories.length}`);

      // Buscar primeiro nó conectado ao trigger seguindo as edges
      const firstEdge = graph.edges?.find((e: any) => e.source === triggerNode.id);

      if (!firstEdge) {
        console.warn('⚠️ Campanha não tem nós conectados ao Trigger. Apenas ficará aguardando mensagens.');
        return;
      }

      const firstNode = graph.nodes?.find((n: any) => n.id === firstEdge.target);

      if (!firstNode || !firstNode.data?.config) {
        console.warn('⚠️ Primeiro nó não está configurado. Apenas ficará aguardando mensagens.');
        return;
      }

      const nodeType = firstNode.data?.nodeType;
      const nodeConfig = firstNode.data?.config;

      console.log(`📋 First node type: ${nodeType}, id: ${firstNode.id}`);

      // Processar baseado no tipo do primeiro nó
      let messageTemplate: string | null = null;
      let mediaUrl: string | null = null;
      let mediaType: string | null = null;
      let fileName: string | null = null;

      // Suportar novos tipos de nós e backward compatibility com 'action'
      switch (nodeType) {
        case 'text':
          messageTemplate = nodeConfig.content;
          break;

        case 'image':
          mediaUrl = nodeConfig.mediaUrl;
          mediaType = 'image';
          fileName = nodeConfig.fileName;
          messageTemplate = nodeConfig.caption || null;
          break;

        case 'video':
          mediaUrl = nodeConfig.mediaUrl;
          mediaType = 'video';
          fileName = nodeConfig.fileName;
          messageTemplate = nodeConfig.caption || null;
          break;

        case 'audio':
          mediaUrl = nodeConfig.mediaUrl;
          mediaType = 'audio';
          fileName = nodeConfig.fileName;
          break;

        case 'document':
          mediaUrl = nodeConfig.mediaUrl;
          mediaType = 'document';
          fileName = nodeConfig.fileName;
          messageTemplate = nodeConfig.caption || null;
          break;

        case 'action':
          // Backward compatibility
          messageTemplate = nodeConfig.message || nodeConfig.content;
          break;

        default:
          console.warn(`⚠️ Tipo de nó inicial não suportado para disparo: ${nodeType}`);
          return;
      }

      if (!messageTemplate && !mediaUrl) {
        console.warn('⚠️ Primeiro nó não tem conteúdo configurado. Apenas ficará aguardando mensagens.');
        return;
      }

      if (messageTemplate) {
        console.log(`📝 Initial message template: "${messageTemplate.substring(0, 50)}..."`);
      }
      if (mediaUrl) {
        console.log(`📎 Media URL: ${mediaUrl}, Type: ${mediaType}, File: ${fileName}`);
      }

      // Buscar contatos das categorias configuradas
      const contacts = await prisma.contact.findMany({
        where: {
          categoriaId: { in: categories },
          tenantId: campaign.tenantId,
        },
        select: {
          id: true,
          nome: true,
          telefone: true,
          categoriaId: true,
          tenantId: true,
          tags: true,
          perfexLeadId: true,
        },
      });

      console.log(`👥 Found ${contacts.length} contacts in selected categories`);

      if (contacts.length === 0) {
        console.warn('⚠️ Nenhum contato encontrado nas categorias selecionadas');
        return;
      }

      // Buscar dados das conexões (tanto na tabela Connection quanto WhatsAppSession)
      const connectionDataNew = await prisma.connection.findMany({
        where: {
          id: { in: connections },
          status: 'ACTIVE',
        },
      });

      // Buscar também na tabela antiga WhatsAppSession para compatibilidade
      const connectionDataOld = await prisma.whatsAppSession.findMany({
        where: {
          id: { in: connections },
          status: 'WORKING',
        },
        select: {
          id: true,
          name: true,
          provider: true,
          meJid: true,
          quepasaToken: true,
          config: true,
        },
      });

      // Converter WhatsAppSession para formato de Connection
      const convertedOldConnections = connectionDataOld.map((session) => ({
        id: session.id,
        provider: (session.provider || 'WAHA') as 'WAHA' | 'EVOLUTION' | 'QUEPASA',
        instanceName: session.name,
        phoneNumber: session.meJid || session.name,
        status: 'ACTIVE' as const,
        webhookSecret: '',
        callbackUrl: '',
        tenantId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        quepasaToken: session.quepasaToken, // Manter token para uso posterior
        _sessionConfig: session.config, // Config da sessão importada (Evolution credentials)
      }));

      // Mesclar conexões novas e antigas
      const connectionData = [...connectionDataNew, ...convertedOldConnections];

      if (connectionData.length === 0) {
        throw new Error('Nenhuma conexão ativa encontrada');
      }

      console.log(`📱 Active connections: ${connectionData.map(c => c.instanceName).join(', ')}`);

      // Enviar mensagens
      let connectionIndex = 0;
      let successCount = 0;
      let errorCount = 0;

      for (const contact of contacts) {
        try {
          // Distribuição round-robin entre conexões
          const connection = connectionData[connectionIndex % connectionData.length];
          connectionIndex++;

          console.log(`📤 Processing ${contact.nome} (${contact.telefone}) via ${connection.instanceName} (${connection.provider})`);

          // VERIFICAR SE O NÚMERO EXISTE NO WHATSAPP (igual campanha normal)
          let contactCheck: any = { exists: false };
          let sessionToken: string | undefined;

          // Buscar token QuePasa se for o caso
          if (connection.provider === 'QUEPASA') {
            // Verificar se o token já vem da conexão convertida
            sessionToken = (connection as any).quepasaToken;

            // Se não tiver, buscar na WhatsAppSession
            if (!sessionToken) {
              const quepasaSession = await prisma.whatsAppSession.findFirst({
                where: { name: connection.instanceName },
                select: { quepasaToken: true },
              });
              sessionToken = quepasaSession?.quepasaToken || undefined;
            }
          }

          // Verificar existência do contato
          if (connection.provider === 'EVOLUTION') {
            const evolutionCreds = getEvolutionCredentialsFromSession({ config: (connection as any)._sessionConfig });
            contactCheck = await checkContactExistsEvolution(connection.instanceName, contact.telefone, evolutionCreds || undefined);
          } else if (connection.provider === 'QUEPASA') {
            contactCheck = await checkContactExistsQuepasa(connection.instanceName, contact.telefone, sessionToken);
          } else {
            contactCheck = await checkContactExists(connection.instanceName, contact.telefone);
          }

          if (!contactCheck.exists) {
            console.log(`❌ Contact ${contact.telefone} does not exist on WhatsApp (${connection.provider}). Skipping.`);
            errorCount++;

            // Criar sessão com status de ERRO para rastreamento
            try {
              await interactiveCampaignSessionService.upsertSession({
                campaignId: campaign.id,
                contactId: contact.id,
                contactPhone: contact.telefone,
                currentNodeId: firstNode.id,
                tenantId: campaign.tenantId || undefined,
                status: 'FAILED', // Marcar como falhou
                variables: {
                  nome: contact.nome,
                  telefone: contact.telefone,
                  errorReason: 'Número não existe no WhatsApp',
                },
              });
              console.log(`📊 Session created with FAILED status for ${contact.nome}`);
            } catch (sessionError: any) {
              console.error(`⚠️ Error creating failed session:`, sessionError.message);
            }

            continue;
          }

          // Usar número validado pela API
          const validatedPhone = contactCheck.validPhone || contactCheck.chatId || contact.telefone;
          console.log(`✅ Contact exists. Using validated phone: ${validatedPhone}`);

          // Personalizar mensagem
          let personalizedMessage = messageTemplate ? messageTemplate.replace(/\{\{nome\}\}/gi, contact.nome).replace(/\{\{telefone\}\}/gi, contact.telefone) : null;

          console.log(`📤 Sending ${mediaUrl ? mediaType : 'text'} to ${contact.nome} (${validatedPhone})`);

          // Preparar payload da mensagem
          let messagePayload: any;

          if (mediaUrl) {
            // Mensagem com mídia
            messagePayload = {
              media: {
                url: mediaUrl,
                caption: personalizedMessage || undefined,
              },
            };
          } else {
            // Mensagem de texto
            messagePayload = { text: personalizedMessage };
          }

          // Enviar baseado no provider usando número validado
          switch (connection.provider) {
            case 'WAHA':
              // Para WAHA, passar o chatId validado diretamente
              await sendMessage(
                connection.instanceName,
                contact.telefone, // Telefone original (não usado quando validatedChatId é fornecido)
                messagePayload,
                validatedPhone // chatId validado pela API
              );
              break;

            case 'EVOLUTION': {
              const evolutionCreds = getEvolutionCredentialsFromSession({ config: (connection as any)._sessionConfig });
              await sendMessageViaEvolution(
                connection.instanceName,
                validatedPhone,
                messagePayload,
                evolutionCreds || undefined
              );
              break;
            }

            case 'QUEPASA':
              await sendMessageViaQuepasa(
                connection.instanceName,
                validatedPhone,
                messagePayload,
                sessionToken
              );
              break;

            default:
              throw new Error(`Provider ${connection.provider} não suportado`);
          }

          // Salvar sessão do contato (estado inicial = primeiro nó)
          const session = await interactiveCampaignSessionService.upsertSession({
            campaignId: campaign.id,
            contactId: contact.id,
            contactPhone: validatedPhone, // Usar número validado
            currentNodeId: firstNode.id,
            tenantId: campaign.tenantId || undefined,
            variables: {
              nome: contact.nome,
              telefone: validatedPhone, // Usar número validado
            },
          });

          console.log(`✅ Session created for contact ${contact.nome} at node ${firstNode.id}`);

          // Registrar envio do primeiro nó
          try {
            await interactiveCampaignSessionService.addVisitedNode(
              session.id,
              firstNode.id,
              true // sent = true
            );
            console.log(`✅ First node ${firstNode.id} tracked for ${contact.nome}`);
          } catch (trackError: any) {
            console.error(`⚠️ Error tracking first node:`, trackError.message);
          }

          // Enviar nós subsequentes automaticamente
          await this.sendSubsequentNodes(graph, firstNode.id, contact, validatedPhone, connection, sessionToken, session.id);

          successCount++;

          // Delay entre envios (200ms)
          await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error: any) {
          console.error(`❌ Error sending to ${contact.nome}:`, error.message);
          errorCount++;

          // Criar sessão com status de ERRO para rastreamento de falhas no envio
          try {
            await interactiveCampaignSessionService.upsertSession({
              campaignId: campaign.id,
              contactId: contact.id,
              contactPhone: contact.telefone,
              currentNodeId: firstNode.id,
              tenantId: campaign.tenantId || undefined,
              status: 'FAILED', // Marcar como falhou
              variables: {
                nome: contact.nome,
                telefone: contact.telefone,
                errorReason: `Erro no envio: ${error.message}`,
              },
            });
            console.log(`📊 Session created with FAILED status for ${contact.nome} due to send error`);
          } catch (sessionError: any) {
            console.error(`⚠️ Error creating failed session:`, sessionError.message);
          }
        }
      }

      console.log(`✅ Dispatch completed - Success: ${successCount}, Errors: ${errorCount}`);

      // Verificar se há sessões ativas aguardando resposta (waitreply, condition, etc.)
      const activeSessions = await prisma.interactiveCampaignSession.count({
        where: {
          campaignId: campaignId,
          status: 'ACTIVE',
        },
      });

      if (activeSessions > 0) {
        // Manter campanha como STARTED enquanto há sessões aguardando resposta
        console.log(`⏳ Campaign ${campaignId} has ${activeSessions} active sessions waiting for replies - keeping status STARTED`);
      } else {
        // Apenas marcar como COMPLETED se não há sessões ativas
        await prisma.interactiveCampaign.update({
          where: { id: campaignId },
          data: { status: 'COMPLETED' },
        });
        console.log(`✅ Campaign ${campaignId} status updated to COMPLETED`);
      }

      return {
        success: true,
        totalContacts: contacts.length,
        successCount,
        errorCount,
      };

    } catch (error: any) {
      console.error(`❌ Error dispatching campaign ${campaignId}:`, error);
      throw error;
    }
  },

  /**
   * Envia nós subsequentes automaticamente (para nós conectados em sequência)
   */
  async sendSubsequentNodes(graph: any, currentNodeId: string, contact: any, validatedPhone: string, connection: any, sessionToken?: string, sessionId?: string) {
    try {
      let nextNodeId = currentNodeId;

      // Percorrer todos os nós conectados em sequência
      while (true) {
        // Buscar próxima edge
        const nextEdge = graph.edges?.find((e: any) => e.source === nextNodeId);

        if (!nextEdge) {
          console.log(`🏁 No more nodes to send for ${contact.nome}`);
          break;
        }

        const nextNode = graph.nodes?.find((n: any) => n.id === nextEdge.target);

        if (!nextNode || !nextNode.data) {
          console.log(`⚠️ Next node not found or has no data`);
          break;
        }

        const nodeType = nextNode.data?.nodeType;
        const nodeConfig = nextNode.data?.config;

        // Parar em nós que requerem interação do usuário ou finalização
        if (['condition', 'stop', 'waitreply'].includes(nodeType)) {
          console.log(`⏸️ Stopping at ${nodeType} node - requires user interaction`);
          // Atualizar currentNodeId da sessão para aguardar resposta do usuário
          if (sessionId) {
            try {
              await interactiveCampaignSessionService.updateSession(sessionId, {
                currentNodeId: nextNode.id
              });
              console.log(`✅ Session updated to wait at ${nodeType} node ${nextNode.id}`);
            } catch (updateError: any) {
              console.error(`⚠️ Error updating session currentNodeId:`, updateError.message);
            }
          }
          break; // PARAR aqui e aguardar resposta do usuário
        }

        // Processar nós de integração (Perfex, Chatwoot) antes de continuar
        if (nodeType === 'integration_perfex' || nodeType === 'integration_chatwoot') {
          console.log(`🔧 Processing integration node: ${nodeType} (${nextNode.id})`);

          try {
            // Executar integração usando o flowEngineService
            const { flowEngineService } = await import('./flowEngineService');
            const context = {
              from: contact.telefone,
              to: connection.instanceName,
              content: '',
              type: 'text',
              timestamp: new Date(),
              contactTags: contact.tags,
              tenantId: contact.tenantId || '',
              phonenumber: contact.telefone,
              contactId: contact.id
            };

            const result = await flowEngineService.processNode(nextNode, context);
            console.log(`✅ Integration processed: ${result.result} - ${result.message}`);
          } catch (error: any) {
            console.error(`❌ Error processing integration ${nodeType}:`, error.message);
          }

          // Continuar para próximo nó
          nextNodeId = nextNode.id;
          continue;
        }

        // Ignorar nós que não são de envio de mensagem mas não requerem parada
        if (['trigger', 'delay'].includes(nodeType)) {
          console.log(`⏭️ Skipping node type ${nodeType}`);
          nextNodeId = nextNode.id;
          continue;
        }

        console.log(`📤 Sending subsequent node: ${nodeType} (${nextNode.id})`);

        // Delay de 2 segundos entre cada nó
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Preparar conteúdo baseado no tipo
        let messagePayload: any = null;

        switch (nodeType) {
          case 'text':
            const textContent = nodeConfig.content || '';
            const personalizedText = textContent
              .replace(/\{\{nome\}\}/gi, contact.nome)
              .replace(/\{\{telefone\}\}/gi, contact.telefone);
            messagePayload = { text: personalizedText };
            break;

          case 'image':
            const imageUrl = nodeConfig.mediaUrl;
            const imageCaption = nodeConfig.caption || '';
            const personalizedImageCaption = imageCaption
              .replace(/\{\{nome\}\}/gi, contact.nome)
              .replace(/\{\{telefone\}\}/gi, contact.telefone);
            messagePayload = {
              image: { url: imageUrl },
              caption: personalizedImageCaption || undefined,
            };
            break;

          case 'video':
            const videoUrl = nodeConfig.mediaUrl;
            const videoCaption = nodeConfig.caption || '';
            const personalizedVideoCaption = videoCaption
              .replace(/\{\{nome\}\}/gi, contact.nome)
              .replace(/\{\{telefone\}\}/gi, contact.telefone);
            messagePayload = {
              video: { url: videoUrl },
              caption: personalizedVideoCaption || undefined,
            };
            break;

          case 'audio':
            const audioUrl = nodeConfig.mediaUrl;
            messagePayload = {
              audio: { url: audioUrl },
            };
            break;

          case 'document':
            const documentUrl = nodeConfig.mediaUrl;
            const fileName = nodeConfig.fileName;
            messagePayload = {
              document: { url: documentUrl },
              fileName: fileName || 'document.pdf',
            };
            break;

          case 'action':
            // Backward compatibility
            const actionContent = nodeConfig.message || nodeConfig.content || '';
            const personalizedAction = actionContent
              .replace(/\{\{nome\}\}/gi, contact.nome)
              .replace(/\{\{telefone\}\}/gi, contact.telefone);
            messagePayload = { text: personalizedAction };
            break;

          default:
            console.log(`⚠️ Unsupported node type for auto-send: ${nodeType}`);
            break;
        }

        if (!messagePayload) {
          console.log(`⚠️ No message payload for node ${nextNode.id}`);
          nextNodeId = nextNode.id;
          continue;
        }

        // Enviar mensagem
        let sendSuccess = false;
        let sendError: string | undefined;

        try {
          switch (connection.provider) {
            case 'WAHA':
              await sendMessage(
                connection.instanceName,
                contact.telefone,
                messagePayload,
                validatedPhone
              );
              break;

            case 'EVOLUTION': {
              const evolutionCreds = getEvolutionCredentialsFromSession({ config: (connection as any)._sessionConfig });
              await sendMessageViaEvolution(
                connection.instanceName,
                validatedPhone,
                messagePayload,
                evolutionCreds || undefined
              );
              break;
            }

            case 'QUEPASA':
              await sendMessageViaQuepasa(
                connection.instanceName,
                validatedPhone,
                messagePayload,
                sessionToken
              );
              break;

            default:
              throw new Error(`Provider ${connection.provider} not supported`);
          }

          sendSuccess = true;
          console.log(`✅ Sent ${nodeType} to ${contact.nome}`);
        } catch (error: any) {
          sendError = error.message;
          console.error(`❌ Error sending ${nodeType} to ${contact.nome}:`, error.message);
        }

        // Registrar visita ao nó (mesmo que tenha falhado)
        if (sessionId) {
          try {
            await interactiveCampaignSessionService.addVisitedNode(
              sessionId,
              nextNode.id,
              sendSuccess,
              sendError
            );
            console.log(`✅ Node ${nextNode.id} tracked for ${contact.nome} (sent: ${sendSuccess})`);
          } catch (trackError: any) {
            console.error(`⚠️ Error tracking node ${nextNode.id}:`, trackError.message);
          }
        }

        nextNodeId = nextNode.id;
      }
    } catch (error: any) {
      console.error(`❌ Error sending subsequent nodes:`, error.message);
    }
  },
};
