import { settingsService } from '../services/settingsService';

const fetch = require('node-fetch');

export const wahaRequest = async (endpoint: string, options: any = {}) => {
  const config = await settingsService.getWahaConfig();
  const WAHA_BASE_URL = config.host || process.env.WAHA_BASE_URL || process.env.DEFAULT_WAHA_HOST || '';
  const WAHA_API_KEY = config.apiKey || process.env.WAHA_API_KEY || process.env.DEFAULT_WAHA_API_KEY || '';

  if (!WAHA_BASE_URL || !WAHA_API_KEY) {
    throw new Error('Configurações WAHA não encontradas. Configure o Host e API Key nas configurações do sistema.');
  }

  const url = `${WAHA_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': WAHA_API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`WAHA API Error: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
};
