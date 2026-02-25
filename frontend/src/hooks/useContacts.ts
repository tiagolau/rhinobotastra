import { useState, useEffect } from 'react';
import { ContactsResponse } from '../types';
import { apiService } from '../services/api';
import toast from 'react-hot-toast';

interface UseContactsParams {
  search?: string;
  tag?: string;
  page?: number;
  pageSize?: number;
}

export function useContacts(params: UseContactsParams = {}) {
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiService.getContacts(params);
      setData(response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erro ao carregar contatos';
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
  }, [params.search, params.tag, params.page, params.pageSize]);

  const deleteContact = async (id: string) => {
    try {
      await apiService.deleteContact(id);
      toast.success('Contato excluído com sucesso');
      fetchContacts();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erro ao excluir contato';
      toast.error(errorMessage);
    }
  };

  const bulkDeleteContacts = async (ids: string[]) => {
    try {
      const token = localStorage.getItem('auth_token');
      const response = await fetch('/api/contatos/bulk/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ contactIds: ids }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(err.error || 'Erro ao excluir contatos');
      }
      toast.success(`${ids.length} contato(s) excluído(s) com sucesso`);
      fetchContacts();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erro ao excluir contatos';
      toast.error(errorMessage);
    }
  };

  return {
    contacts: data?.contacts || [],
    total: data?.total || 0,
    page: data?.page || 1,
    pageSize: data?.pageSize || 30,
    totalPages: data?.totalPages || 0,
    loading,
    error,
    refresh: fetchContacts,
    deleteContact,
    bulkDeleteContacts,
  };
}
