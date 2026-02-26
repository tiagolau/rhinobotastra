import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Header } from '../components/Header';
import { Portal } from '../components/Portal';
import { useSettings } from '../hooks/useSettings';
import { useTenant } from '../contexts/TenantContext';
import { useWhatsAppSessions } from '../hooks/useWhatsAppSessions';
import type { WhatsAppSession } from '../hooks/useWhatsAppSessions';

// Componente para exibir contador do QR Code
function QRCountdown({ expiresAt }: { expiresAt: Date }) {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date().getTime();
      const expiry = expiresAt.getTime();
      const difference = expiry - now;
      return Math.max(0, Math.ceil(difference / 1000));
    };

    setTimeLeft(calculateTimeLeft());

    const timer = setInterval(() => {
      const newTimeLeft = calculateTimeLeft();
      setTimeLeft(newTimeLeft);

      if (newTimeLeft <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  if (timeLeft <= 0) {
    return <span className="text-red-600 text-sm">QR Code expirado</span>;
  }

  return (
    <span className="text-orange-600 text-sm">
      Expira em {timeLeft}s
    </span>
  );
}

export function WhatsAppConnectionsPage() {
  const { settings } = useSettings();
  const { selectedTenantId, loading: tenantLoading } = useTenant();
  const {
    sessions, loading, listSessions, syncSessions,
    pollSessionStatus, authenticatedFetch
  } = useWhatsAppSessions({ listIntervalMs: 5000, syncIntervalMs: 60000 });
  const [newSessionName, setNewSessionName] = useState('');
  const [newSessionProvider, setNewSessionProvider] = useState<'WAHA' | 'EVOLUTION' | 'QUEPASA'>('WAHA');
  const [interactiveCampaignEnabled, setInteractiveCampaignEnabled] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [loadingQR, setLoadingQR] = useState<string | null>(null);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [currentQRSession, setCurrentQRSession] = useState<WhatsAppSession | null>(null);
  const [createSessionModalOpen, setCreateSessionModalOpen] = useState(false);
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [allowedProviders, setAllowedProviders] = useState<string[]>(['WAHA', 'EVOLUTION', 'QUEPASA']);

  // States for Import Evolution modal
  const [importEvolutionModalOpen, setImportEvolutionModalOpen] = useState(false);
  const [importEvolutionUrl, setImportEvolutionUrl] = useState('');
  const [importEvolutionInstance, setImportEvolutionInstance] = useState('');
  const [importEvolutionApiKey, setImportEvolutionApiKey] = useState('');
  const [importEvolutionDisplayName, setImportEvolutionDisplayName] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  // Preload das imagens dos provedores para carregamento instantâneo
  useEffect(() => {
    const images = [
      '/iconewaha.png',
      '/iconeevolutionapi.png',
      '/iconequepasa.png'
    ];

    images.forEach(src => {
      const img = new Image();
      img.src = src;
    });
  }, []);

  // Carregar provedores permitidos do tenant
  const loadAllowedProviders = async () => {
    try {
      const response = await authenticatedFetch('/api/tenants/allowed-providers');
      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.allowedProviders)) {
          setAllowedProviders(data.allowedProviders);
          // Definir o primeiro provedor permitido como padrão
          if (data.allowedProviders.length > 0 && !data.allowedProviders.includes(newSessionProvider)) {
            setNewSessionProvider(data.allowedProviders[0] as 'WAHA' | 'EVOLUTION' | 'QUEPASA');
          }
        }
      }
    } catch (error) {
      console.error('Erro ao carregar provedores permitidos:', error);
    }
  };

  // Carregar provedores permitidos quando tenant muda
  useEffect(() => {
    if (tenantLoading || !selectedTenantId) return;
    loadAllowedProviders();
  }, [selectedTenantId, tenantLoading]);

  // Polling do QR modal — usa endpoint leve de status de sessão individual
  useEffect(() => {
    if (!qrModalOpen || !currentQRSession) return;

    const interval = setInterval(async () => {
      const updated = await pollSessionStatus(currentQRSession.name);
      if (updated?.status === 'WORKING') {
        setQrModalOpen(false);
        setCurrentQRSession(null);
        await listSessions(false);
        const userName = updated.me?.pushName || 'Usuário';
        toast.success(`WhatsApp conectado com sucesso! Logado como: ${userName}`);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [qrModalOpen, currentQRSession, pollSessionStatus, listSessions]);

  const importEvolutionSession = async () => {
    if (!importEvolutionUrl.trim() || !importEvolutionInstance.trim() || !importEvolutionApiKey.trim()) {
      toast.error('Preencha todos os campos obrigatórios');
      return;
    }

    setIsImporting(true);
    try {
      const response = await authenticatedFetch('/api/waha/sessions/import-evolution', {
        method: 'POST',
        body: JSON.stringify({
          url: importEvolutionUrl.trim(),
          instanceName: importEvolutionInstance.trim(),
          apiKey: importEvolutionApiKey.trim(),
          displayName: importEvolutionDisplayName.trim() || importEvolutionInstance.trim(),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      toast.success(`Sessão "${importEvolutionInstance}" importada com sucesso!`);
      setImportEvolutionModalOpen(false);
      setImportEvolutionUrl('');
      setImportEvolutionInstance('');
      setImportEvolutionApiKey('');
      setImportEvolutionDisplayName('');
      await listSessions(true);
    } catch (error) {
      console.error('Erro ao importar sessão:', error);
      toast.error(error instanceof Error ? error.message : 'Erro ao importar sessão');
    } finally {
      setIsImporting(false);
    }
  };

  const createSession = async () => {
    if (!newSessionName.trim()) {
      toast.error('Digite um nome para a sessão');
      return;
    }

    // Validar se as configurações do provedor estão disponíveis
    if (newSessionProvider === 'WAHA' && (!settings?.wahaHost || !settings?.wahaApiKey)) {
      toast.error('Configure as credenciais WAHA nas configurações do sistema');
      return;
    }

    if (newSessionProvider === 'EVOLUTION' && (!settings?.evolutionHost || !settings?.evolutionApiKey)) {
      toast.error('Configure as credenciais Evolution API nas configurações do sistema');
      return;
    }

    if (newSessionProvider === 'QUEPASA' && (!settings?.quepasaUrl || !settings?.quepasaLogin || !settings?.quepasaPassword)) {
      toast.error('Configure as credenciais Quepasa nas configurações do sistema');
      return;
    }

    setIsCreating(true);
    try {
      const response = await authenticatedFetch('/api/waha/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: newSessionName.trim(),
          provider: newSessionProvider,
          interactiveCampaignEnabled
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro desconhecido' }));

        // Verificar se é erro de quota
        if (errorData.upgradeRequired || (errorData.message && errorData.message.includes('Limite'))) {
          toast.error(errorData.message || 'Limite de conexões atingido. Faça upgrade do seu plano para continuar.', {
            duration: 6000,
            icon: '⚠️'
          });
          throw new Error(errorData.message);
        }

        throw new Error(errorData.error || errorData.message || `HTTP ${response.status}`);
      }

      const createdSessionData = await response.json();

      toast.success(`Sessão ${newSessionProvider} criada com sucesso`);
      setNewSessionName('');
      setNewSessionProvider('WAHA');

      // Recarregar imediatamente
      await listSessions(true);

      // Se for Evolution e veio QR code, abrir modal automaticamente
      if (newSessionProvider === 'EVOLUTION' && createdSessionData.qrcode?.base64) {
        setTimeout(async () => {
          // Buscar o nome real da sessão criada
          const sessions = await authenticatedFetch('/api/waha/sessions').then(r => r.json());
          const createdSession = sessions.find((s: any) => s.name.startsWith(newSessionName.trim()));

          if (createdSession) {
            await openQRModal(createdSession.name);
          }
        }, 1000);
      }

      // Aguardar mais um pouco e recarregar novamente para pegar status atualizado
      setTimeout(() => {
        listSessions(false);
      }, 2000);
    } catch (error) {
      console.error('Erro ao criar sessão:', error);
      // Não mostrar toast de erro genérico se já mostramos o toast específico de quota
      if (!(error instanceof Error && error.message.includes('Limite'))) {
        toast.error(error instanceof Error ? error.message : 'Erro ao criar sessão');
      }
    } finally {
      setIsCreating(false);
    }
  };

  const deleteSession = async (sessionName: string) => {
    if (!confirm(`Tem certeza que deseja remover a sessão "${sessionName}"?`)) {
      return;
    }

    try {
      const response = await authenticatedFetch(`/api/waha/sessions/${sessionName}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      toast.success('Sessão removida com sucesso');
      listSessions(true);
    } catch (error) {
      console.error('Erro ao remover sessão:', error);
      toast.error(error instanceof Error ? error.message : 'Erro ao remover sessão');
    }
  };

  const restartSession = async (sessionName: string) => {
    try {
      const response = await authenticatedFetch(`/api/waha/sessions/${sessionName}/restart`, {
        method: 'POST'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      toast.success('Sessão reiniciada');

      // Aguardar um pouco antes de recarregar
      setTimeout(() => {
        listSessions(false);
      }, 1000);
    } catch (error) {
      console.error('Erro ao reiniciar sessão:', error);
      toast.error(error instanceof Error ? error.message : 'Erro ao reiniciar sessão');
    }
  };

  const requestQRCode = async (sessionName: string) => {
    setLoadingQR(sessionName);
    try {
      // Primeiro, iniciar a sessão
      const startResponse = await authenticatedFetch(`/api/waha/sessions/${sessionName}/start`, {
        method: 'POST'
      });

      if (!startResponse.ok) {
        const errorData = await startResponse.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errorData.error || `HTTP ${startResponse.status}`);
      }

      toast.success('QR Code solicitado. Aguarde...');

      // Aguardar um pouco e abrir modal para mostrar QR
      setTimeout(async () => {
        await openQRModal(sessionName);
        listSessions(false);
      }, 2000);

    } catch (error) {
      console.error('Erro ao solicitar QR Code:', error);
      toast.error(error instanceof Error ? error.message : 'Erro ao solicitar QR Code');
    } finally {
      setLoadingQR(null);
    }
  };

  const openQRModal = async (sessionName: string) => {
    try {
      // Primeiro, verificar se já temos um QR salvo no banco para esta sessão
      const currentSession = sessions.find(s => s.name === sessionName);

      if (currentSession?.qr && currentSession?.qrExpiresAt && currentSession.qrExpiresAt > new Date()) {
        // Usar QR code já salvo no banco se ainda não expirou
        const sessionWithQR: WhatsAppSession = {
          name: sessionName,
          status: 'SCAN_QR_CODE',
          provider: currentSession.provider,
          qr: currentSession.qr,
          qrExpiresAt: currentSession.qrExpiresAt,
          me: currentSession.me
        };

        setCurrentQRSession(sessionWithQR);
        setQrModalOpen(true);
        return;
      }

      // Primeiro, iniciar a sessão para gerar o QR
      const startResponse = await authenticatedFetch(`/api/waha/sessions/${sessionName}/start`, {
        method: 'POST'
      });

      if (!startResponse.ok) {
        const startError = await startResponse.json();
        toast.error(`Erro ao iniciar sessão: ${startError.error || 'Erro desconhecido'}`);
        return;
      }

      // Aguardar um pouco para a sessão inicializar
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Agora buscar QR através do backend (que vai rotear para API correta)
      const qrResponse = await authenticatedFetch(`/api/waha/sessions/${sessionName}/auth/qr`);

      if (qrResponse.ok) {
        const qrData = await qrResponse.json();

        if (qrData.qr) {
          const sessionWithQR: WhatsAppSession = {
            name: sessionName,
            status: 'SCAN_QR_CODE',
            provider: currentSession?.provider || 'WAHA',
            qr: qrData.qr,
            qrExpiresAt: qrData.expiresAt ? new Date(qrData.expiresAt) : new Date(Date.now() + 60000),
            me: undefined
          };

          setCurrentQRSession(sessionWithQR);
          setQrModalOpen(true);

          // Recarregar sessões para obter dados atualizados do banco
          setTimeout(() => {
            listSessions(false);
          }, 1000);
        } else {
          toast.error('QR Code não disponível');
        }
      } else {
        const errorData = await qrResponse.json();
        toast.error(errorData.error || 'Erro ao buscar QR Code');
      }
    } catch (error) {
      console.error('Erro ao buscar QR Code:', error);
      toast.error('Erro ao buscar QR Code');
    }
  };

  const closeQRModal = () => {
    setQrModalOpen(false);
    setCurrentQRSession(null);
    // Recarregar sessões para verificar se conectou
    listSessions(false);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'WORKING':
        return 'bg-green-100 text-green-800';
      case 'SCAN_QR_CODE':
        return 'bg-yellow-100 text-yellow-800';
      case 'STOPPED':
        return 'bg-gray-100 text-gray-800';
      case 'FAILED':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'WORKING':
        return 'Conectado';
      case 'SCAN_QR_CODE':
        return 'Aguardando QR Code';
      case 'STOPPED':
        return 'Parado';
      case 'FAILED':
        return 'Erro';
      default:
        return status;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2 text-gray-600">Carregando conexões...</span>
      </div>
    );
  }

  return (
    <>
      <Header
        title="Conexões WhatsApp"
        subtitle={`${sessions.length} ${sessions.length === 1 ? 'sessão ativa' : 'sessões ativas'}`}
        actions={
          <div className="flex gap-3">
            <button
              onClick={() => setImportEvolutionModalOpen(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-medium transition-colors"
            >
              Importar do Evolution
            </button>
            <button
              onClick={() => setCreateSessionModalOpen(true)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 text-sm font-medium transition-colors"
            >
              + Nova Sessão
            </button>
            <button
              onClick={() => syncSessions()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-medium transition-colors"
            >
              Atualizar
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-6">

      {/* Lista de Sessões */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Sessões Ativas</h3>
        </div>

        {sessions.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            Nenhuma sessão WhatsApp encontrada. Crie uma nova sessão para começar.
          </div>
        ) : (
          <div className="divide-y divide-gray-200">
            {sessions.map((session) => (
              <div key={session.name} className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h4 className="text-lg font-medium text-gray-900">{session.displayName || session.name}</h4>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        session.provider === 'EVOLUTION' ? 'bg-blue-100 text-blue-800' :
                        session.provider === 'QUEPASA' ? 'bg-purple-100 text-purple-800' :
                        'bg-green-100 text-green-800'
                      }`}>
                        <img
                          src={
                            session.provider === 'EVOLUTION' ? '/iconeevolutionapi.png' :
                            session.provider === 'QUEPASA' ? '/iconequepasa.png' :
                            '/iconewaha.png'
                          }
                          alt={session.provider}
                          className="w-4 h-4 object-contain"
                        />
                        {session.provider === 'EVOLUTION' ? 'Evolution API' :
                         session.provider === 'QUEPASA' ? 'Quepasa' :
                         'Waha'}
                      </span>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(session.status)}`}>
                        {getStatusText(session.status)}
                      </span>
                    </div>

                    {session.me && (
                      <p className="text-sm text-gray-600">
                        Conectado como: <span className="font-medium">{session.me.pushName}</span> ({session.me.id})
                      </p>
                    )}
                  </div>

                  <div className="flex gap-2 ml-4">
                    {session.status === 'STOPPED' && (
                      <button
                        onClick={() => requestQRCode(session.name)}
                        disabled={loadingQR === session.name}
                        className="px-3 py-1 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 disabled:opacity-50"
                      >
                        {loadingQR === session.name ? 'Solicitando...' : 'Conectar'}
                      </button>
                    )}
                    {session.status === 'SCAN_QR_CODE' && (
                      <button
                        onClick={() => openQRModal(session.name)}
                        className="px-3 py-1 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
                      >
                        Ver QR Code
                      </button>
                    )}
                    <button
                      onClick={() => restartSession(session.name)}
                      className="px-3 py-1 bg-yellow-600 text-white text-sm rounded-md hover:bg-yellow-700"
                    >
                      Reiniciar
                    </button>
                    <button
                      onClick={() => deleteSession(session.name)}
                      className="px-3 py-1 bg-red-600 text-white text-sm rounded-md hover:bg-red-700"
                    >
                      Remover
                    </button>
                  </div>
                </div>

              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal Importar Sessão Evolution */}
      {importEvolutionModalOpen && (
        <Portal>
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center backdrop-blur-sm" style={{ zIndex: 9999 }}>
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-100 m-4" role="dialog" aria-labelledby="import-evolution-title">
              <div className="text-center mb-8">
                <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl mx-auto mb-4 flex items-center justify-center">
                  <img src="/iconeevolutionapi.png" alt="Evolution API" className="w-10 h-10 object-contain" />
                </div>
                <h2 id="import-evolution-title" className="text-2xl font-bold text-gray-900">
                  Importar do Evolution API
                </h2>
                <p className="text-gray-500 mt-2">
                  Importe uma instância já existente na sua Evolution API
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    URL da Evolution API *
                  </label>
                  <input
                    type="url"
                    value={importEvolutionUrl}
                    onChange={(e) => setImportEvolutionUrl(e.target.value)}
                    placeholder="https://sua-evolution.com"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    disabled={isImporting}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Nome da Instância *
                  </label>
                  <input
                    type="text"
                    value={importEvolutionInstance}
                    onChange={(e) => setImportEvolutionInstance(e.target.value)}
                    placeholder="Ex: minha-instancia"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    disabled={isImporting}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    API Key *
                  </label>
                  <input
                    type="password"
                    value={importEvolutionApiKey}
                    onChange={(e) => setImportEvolutionApiKey(e.target.value)}
                    placeholder="Sua API Key da Evolution"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    disabled={isImporting}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Nome de Exibição (opcional)
                  </label>
                  <input
                    type="text"
                    value={importEvolutionDisplayName}
                    onChange={(e) => setImportEvolutionDisplayName(e.target.value)}
                    placeholder="Ex: Vendas Principal"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    disabled={isImporting}
                  />
                  <p className="text-xs text-gray-500 mt-1">Se não informado, usa o nome da instância</p>
                </div>

                <div className="flex gap-4 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setImportEvolutionModalOpen(false);
                      setImportEvolutionUrl('');
                      setImportEvolutionInstance('');
                      setImportEvolutionApiKey('');
                      setImportEvolutionDisplayName('');
                    }}
                    className="flex-1 bg-gray-100 text-gray-700 py-3 px-6 rounded-xl hover:bg-gray-200 font-medium transition-all duration-200 border border-gray-200"
                    disabled={isImporting}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={importEvolutionSession}
                    disabled={isImporting || !importEvolutionUrl.trim() || !importEvolutionInstance.trim() || !importEvolutionApiKey.trim()}
                    className="flex-1 bg-blue-600 text-white py-3 px-6 rounded-xl hover:bg-blue-700 font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {isImporting ? (
                      <>
                        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Importando...
                      </>
                    ) : (
                      'Importar Sessão'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* Modal Criar Sessão */}
      {createSessionModalOpen && (
        <Portal>
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center backdrop-blur-sm" style={{ zIndex: 9999 }}>
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-100 m-4" role="dialog" aria-labelledby="create-session-title">
            <div className="text-center mb-8">
              <div className="w-16 h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl mx-auto mb-4 flex items-center justify-center">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h2 id="create-session-title" className="text-2xl font-bold text-gray-900">
                Nova Sessão WhatsApp
              </h2>
              <p className="text-gray-500 mt-2">
                Digite um nome para identificar esta sessão
              </p>
            </div>

            <div className="space-y-6">
              <div>
                <label htmlFor="session-provider" className="block text-sm font-semibold text-gray-700 mb-2">
                  Provedor WhatsApp *
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => !isCreating && setProviderDropdownOpen(!providerDropdownOpen)}
                    className="w-full px-4 py-3 pl-12 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent text-sm bg-white text-left flex items-center justify-between"
                    disabled={isCreating}
                  >
                    <span className="flex items-center gap-3">
                      <img
                        src={
                          newSessionProvider === 'EVOLUTION' ? '/iconeevolutionapi.png' :
                          newSessionProvider === 'QUEPASA' ? '/iconequepasa.png' :
                          '/iconewaha.png'
                        }
                        alt={newSessionProvider}
                        className="w-5 h-5 object-contain"
                      />
                      {newSessionProvider === 'EVOLUTION' ? 'Evolution API' :
                       newSessionProvider === 'QUEPASA' ? 'Quepasa' :
                       'Waha'}
                    </span>
                    <svg className={`w-4 h-4 text-gray-400 transition-transform ${providerDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {providerDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setProviderDropdownOpen(false)}
                      />
                      <div className="absolute z-20 w-full mt-2 bg-white border border-gray-300 rounded-xl shadow-lg overflow-hidden">
                        {allowedProviders.includes('WAHA') && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewSessionProvider('WAHA');
                              setProviderDropdownOpen(false);
                            }}
                            className={`w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-blue-50 transition-colors ${
                              newSessionProvider === 'WAHA' ? 'bg-blue-50' : ''
                            }`}
                          >
                            <img src="/iconewaha.png" alt="Waha" className="w-5 h-5 object-contain" />
                            <span className="text-sm">Waha</span>
                          </button>
                        )}
                        {allowedProviders.includes('EVOLUTION') && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewSessionProvider('EVOLUTION');
                              setProviderDropdownOpen(false);
                            }}
                            className={`w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-blue-50 transition-colors ${
                              newSessionProvider === 'EVOLUTION' ? 'bg-blue-50' : ''
                            }`}
                          >
                            <img src="/iconeevolutionapi.png" alt="Evolution API" className="w-5 h-5 object-contain" />
                            <span className="text-sm">Evolution API</span>
                          </button>
                        )}
                        {allowedProviders.includes('QUEPASA') && (
                          <button
                            type="button"
                            onClick={() => {
                              setNewSessionProvider('QUEPASA');
                              setProviderDropdownOpen(false);
                            }}
                            className={`w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-blue-50 transition-colors ${
                              newSessionProvider === 'QUEPASA' ? 'bg-blue-50' : ''
                            }`}
                          >
                            <img src="/iconequepasa.png" alt="Quepasa" className="w-5 h-5 object-contain" />
                            <span className="text-sm">Quepasa</span>
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Escolha o provedor para conectar ao WhatsApp
                </p>
              </div>

              <div>
                <label htmlFor="session-name" className="block text-sm font-semibold text-gray-700 mb-2">
                  Nome da Sessão *
                </label>
                <input
                  id="session-name"
                  type="text"
                  value={newSessionName}
                  onChange={(e) => setNewSessionName(e.target.value)}
                  placeholder="Ex: vendas, suporte, atendimento"
                  className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent text-sm"
                  disabled={isCreating}
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-2">
                  Use um nome descritivo para facilitar a identificação
                </p>
              </div>

              <div className="bg-gradient-to-br from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-200">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <label htmlFor="interactive-campaign-toggle" className="text-sm font-semibold text-gray-800 cursor-pointer">
                        Campanha Interativa
                      </label>
                    </div>
                    <p className="text-xs text-gray-600">
                      Habilita recebimento de mensagens para fluxos conversacionais automatizados
                    </p>
                  </div>
                  <button
                    id="interactive-campaign-toggle"
                    type="button"
                    onClick={() => setInteractiveCampaignEnabled(!interactiveCampaignEnabled)}
                    disabled={isCreating}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                      interactiveCampaignEnabled ? 'bg-blue-600' : 'bg-gray-300'
                    } ${isCreating ? 'opacity-50 cursor-not-allowed' : ''}`}
                    role="switch"
                    aria-checked={interactiveCampaignEnabled}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        interactiveCampaignEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="flex gap-4 pt-6">
                <button
                  type="button"
                  onClick={() => {
                    setCreateSessionModalOpen(false);
                    setNewSessionName('');
                    setNewSessionProvider('WAHA');
                    setInteractiveCampaignEnabled(false);
                  }}
                  className="flex-1 bg-gray-100 text-gray-700 py-3 px-6 rounded-xl hover:bg-gray-200 font-medium transition-all duration-200 border border-gray-200"
                  disabled={isCreating}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await createSession();
                    setCreateSessionModalOpen(false);
                  }}
                  disabled={isCreating || !newSessionName.trim()}
                  className="flex-1 bg-green-600 text-white py-3 px-6 rounded-xl hover:bg-green-700 font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isCreating ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Criando...
                    </>
                  ) : (
                    'Criar Sessão'
                  )}
                </button>
              </div>
            </div>
          </div>
          </div>
        </Portal>
      )}

      {/* Modal do QR Code */}
      {qrModalOpen && currentQRSession && (
        <div className="qr-modal-overlay" onClick={closeQRModal}>
          <div className="qr-modal-content bg-white rounded-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center p-6 border-b">
              <h3 className="text-lg font-medium text-gray-900">
                QR Code - {currentQRSession.displayName || currentQRSession.name} ({currentQRSession.provider})
              </h3>
              <button
                onClick={closeQRModal}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6">
              {currentQRSession?.qr ? (
                <div className="text-center">
                  <h3 className="text-lg font-medium mb-4">Escaneie o QR Code com seu WhatsApp</h3>
                  <p className="text-sm text-gray-600 mb-6">
                    Abra o WhatsApp no seu celular, vá em <strong>Configurações → Aparelhos conectados → Conectar aparelho</strong> e escaneie o código abaixo
                  </p>
                  <div className="bg-white p-6 rounded-lg border inline-block shadow-lg">
                    {(() => {
                      // Para Evolution: QR vem em base64 direto
                      if (currentQRSession.provider === 'EVOLUTION' && currentQRSession.qr?.startsWith('data:image')) {
                        return (
                          <img
                            src={currentQRSession.qr}
                            alt="QR Code WhatsApp"
                            className="w-64 h-64 mx-auto block border-2 border-gray-200 rounded"
                          />
                        );
                      }

                      // Para Quepasa: QR vem em base64
                      if (currentQRSession.provider === 'QUEPASA' && currentQRSession.qr?.startsWith('data:image')) {
                        return (
                          <img
                            src={currentQRSession.qr}
                            alt="QR Code WhatsApp"
                            className="w-64 h-64 mx-auto block border-2 border-gray-200 rounded"
                            onError={(e) => {
                              console.error('Erro ao carregar QR Quepasa base64');
                            }}
                          />
                        );
                      }

                      // Para WAHA: QR já vem processado pelo backend em base64
                      if (currentQRSession.provider === 'WAHA' && currentQRSession.qr?.startsWith('data:image')) {
                        return (
                          <img
                            src={currentQRSession.qr}
                            alt="QR Code WhatsApp"
                            className="w-64 h-64 mx-auto block border-2 border-gray-200 rounded"
                            onError={(e) => {
                              console.error('Erro ao carregar QR WAHA base64');
                            }}
                          />
                        );
                      }

                      // Fallback: detectar automaticamente
                      const qrSrc = currentQRSession.qr?.startsWith('data:image')
                        ? currentQRSession.qr
                        : `/api/waha/sessions/${currentQRSession.name}/auth/qr`;

                      return (
                        <img
                          src={qrSrc}
                          alt="QR Code WhatsApp"
                          className="w-64 h-64 mx-auto block border-2 border-gray-200 rounded"
                          onError={(e) => {
                            console.error('Erro ao carregar QR fallback');
                          }}
                        />
                      );
                    })()}
                  </div>
                  {currentQRSession.qrExpiresAt && (
                    <div className="mt-4">
                      <QRCountdown expiresAt={currentQRSession.qrExpiresAt} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3"></div>
                  <span className="text-gray-600">Gerando QR Code...</span>
                  <p className="text-sm text-gray-500 mt-2">Aguarde um momento</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 p-6 border-t">
              <button
                onClick={() => openQRModal(currentQRSession.name)}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Atualizar QR
              </button>
              <button
                onClick={closeQRModal}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded-md hover:bg-gray-400"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
