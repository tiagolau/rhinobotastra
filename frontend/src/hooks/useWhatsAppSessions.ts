import { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTenant } from '../contexts/TenantContext';

export interface WhatsAppSession {
  name: string;
  displayName?: string;
  status: 'WORKING' | 'SCAN_QR_CODE' | 'STOPPED' | 'FAILED';
  provider: 'WAHA' | 'EVOLUTION' | 'QUEPASA';
  qr?: string;
  qrExpiresAt?: Date;
  me?: {
    id: string;
    pushName: string;
  };
}

interface UseWhatsAppSessionsOptions {
  listIntervalMs?: number;
  syncIntervalMs?: number;
}

function processSession(session: any): WhatsAppSession {
  return {
    name: session.name,
    displayName: session.displayName || session.name,
    status: session.status || 'STOPPED',
    provider: session.provider || 'WAHA',
    me: session.me || null,
    qr: session.qr || null,
    qrExpiresAt: session.qrExpiresAt ? new Date(session.qrExpiresAt) : undefined,
  };
}

export function useWhatsAppSessions(options: UseWhatsAppSessionsOptions = {}) {
  const { listIntervalMs = 5000, syncIntervalMs = 60000 } = options;
  const { selectedTenantId, loading: tenantLoading } = useTenant();
  const [sessions, setSessions] = useState<WhatsAppSession[]>([]);
  const [loading, setLoading] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const authenticatedFetch = useCallback(async (url: string, options: RequestInit = {}) => {
    const token = localStorage.getItem('auth_token');
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      (headers as Record<string, string>).Authorization = `Bearer ${token}`;
    }

    if (selectedTenantId) {
      (headers as Record<string, string>)['X-Tenant-Id'] = selectedTenantId;
    }

    return fetch(url, { ...options, headers });
  }, [selectedTenantId]);

  // Leitura rápida do banco (GET /sessions — sem sync com APIs externas)
  const listSessions = useCallback(async (showLoading = false) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      if (showLoading) setLoading(true);
      const response = await authenticatedFetch('/api/waha/sessions', {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setSessions(data.map(processSession));
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      console.error('Erro ao carregar sessões:', err);
      if (showLoading) toast.error('Erro ao carregar sessões WhatsApp');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [authenticatedFetch]);

  // Sync completo com provedores externos (POST /sessions/sync)
  const syncSessions = useCallback(async () => {
    try {
      setLoading((prev) => prev); // mantém estado atual
      const response = await authenticatedFetch('/api/waha/sessions/sync', {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setSessions(data.map(processSession));
      setLoading(false);
    } catch (err) {
      console.error('Erro ao sincronizar sessões:', err);
      setLoading(false);
    }
  }, [authenticatedFetch]);

  // Polling de status de uma sessão específica (para QR modal)
  const pollSessionStatus = useCallback(async (sessionName: string): Promise<WhatsAppSession | null> => {
    try {
      const response = await authenticatedFetch(`/api/waha/sessions/${sessionName}/status`);
      if (!response.ok) return null;
      const data = await response.json();
      return processSession(data);
    } catch {
      return null;
    }
  }, [authenticatedFetch]);

  // Setup dos intervalos de polling
  useEffect(() => {
    if (tenantLoading || !selectedTenantId) return;

    // Carga inicial: sync completo para ter dados frescos
    syncSessions();

    // Leitura rápida do banco a cada 5s
    const listInterval = setInterval(() => listSessions(false), listIntervalMs);

    // Sync completo a cada 60s
    const syncInterval = setInterval(() => syncSessions(), syncIntervalMs);

    return () => {
      clearInterval(listInterval);
      clearInterval(syncInterval);
      abortControllerRef.current?.abort();
    };
  }, [selectedTenantId, tenantLoading, listIntervalMs, syncIntervalMs, listSessions, syncSessions]);

  return {
    sessions,
    loading,
    listSessions,
    syncSessions,
    pollSessionStatus,
    authenticatedFetch,
  };
}
